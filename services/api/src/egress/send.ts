import {
  ApiError,
  newId,
  normalizeSubject,
  parseMessageIdRefs,
  resolveThread,
  PLATFORM_LIMITS,
  type MailProvider,
  type SendMessageInput
} from "@wzrdmail/core";
import { createMimeMessage } from "mimetext/browser";
import type { Env } from "../env.js";
import { bumpUsage, emitEvent } from "../lib/events.js";

export interface SendContext {
  inbox_id: string;
  org_id: string;
  pod_id: string;
  org_verified: boolean;
  human_email: string;
}

export interface SentMessage {
  message_id: string;
  thread_id: string;
  state: "sent" | "rejected";
  rfc822_message_id: string;
}

/**
 * Outbound pipeline (§6.2). Validations, MIME build, provider send, state
 * transition, event emit. Queue-based async dispatch is M3; v1 sends
 * synchronously within the request.
 */
export async function sendMessage(
  env: Env,
  provider: MailProvider,
  ctx: SendContext,
  input: SendMessageInput
): Promise<SentMessage> {
  const to = input.to.map((a) => a.toLowerCase());
  const cc = (input.cc ?? []).map((a) => a.toLowerCase());
  const bcc = (input.bcc ?? []).map((a) => a.toLowerCase());
  const recipients = [...new Set([...to, ...cc, ...bcc])];

  if (recipients.length > PLATFORM_LIMITS.maxRecipientsPerMessage) {
    throw new ApiError(
      "validation_error",
      `at most ${PLATFORM_LIMITS.maxRecipientsPerMessage} recipients per message`
    );
  }
  if (!ctx.org_verified) {
    const allowed = ctx.human_email.toLowerCase();
    if (recipients.some((r) => r !== allowed)) {
      throw new ApiError(
        "forbidden",
        "verify your account to email external recipients"
      );
    }
  }
  const suppressed = await env.DB.prepare(
    `SELECT address FROM suppressions
     WHERE (org_id = ? OR org_id IS NULL)
       AND address IN (${recipients.map(() => "?").join(",")})`
  )
    .bind(ctx.org_id, ...recipients)
    .first<{ address: string }>();
  if (suppressed) {
    throw new ApiError(
      "suppressed_recipient",
      `recipient ${suppressed.address} is suppressed (previous bounce or complaint)`
    );
  }

  const msgId = newId("msg");
  const domain = ctx.inbox_id.slice(ctx.inbox_id.lastIndexOf("@") + 1);
  const rfc822MessageId = `<${msgId}@${domain}>`;
  const now = new Date().toISOString();
  const subject = input.subject ?? "";

  // Build MIME
  const mime = createMimeMessage();
  mime.setSender(ctx.inbox_id);
  mime.setTo(to);
  if (cc.length > 0) mime.setCc(cc);
  if (bcc.length > 0) mime.setBcc(bcc);
  mime.setSubject(subject);
  mime.setHeader("Message-ID", rfc822MessageId);
  if (input.reply_to) mime.setHeader("Reply-To", input.reply_to);
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    mime.setHeader(key, value);
  }
  if (input.text) mime.addMessage({ contentType: "text/plain", data: input.text });
  if (input.html) mime.addMessage({ contentType: "text/html", data: input.html });
  if (!input.text && !input.html) {
    mime.addMessage({ contentType: "text/plain", data: "" });
  }
  for (const att of input.attachments ?? []) {
    mime.addAttachment({
      filename: att.filename,
      contentType: att.content_type,
      data: att.content,
      encoding: "base64"
    });
  }
  const raw = mime.asRaw();
  if (raw.length > PLATFORM_LIMITS.maxOutboundBytes) {
    throw new ApiError(
      "message_too_large",
      `message exceeds ${PLATFORM_LIMITS.maxOutboundBytes} bytes`
    );
  }

  // Thread resolution: outbound messages thread by the same rules (§6.5).
  const refIds = parseMessageIdRefs(input.headers?.["In-Reply-To"]);
  let referencedThreadId: string | null = null;
  for (const mid of refIds) {
    const hit = await env.DB.prepare(
      "SELECT thread_id FROM message_id_lookup WHERE inbox_id = ? AND rfc822_message_id = ?"
    )
      .bind(ctx.inbox_id, mid)
      .first<{ thread_id: string }>();
    if (hit) {
      referencedThreadId = hit.thread_id;
      break;
    }
  }
  const participants = [...new Set([ctx.inbox_id.toLowerCase(), ...recipients])];
  const normalized = normalizeSubject(subject);
  const candidates = referencedThreadId
    ? []
    : (
        await env.DB.prepare(
          `SELECT thread_id, normalized_subject, participants, last_message_at
           FROM threads WHERE inbox_id = ? AND normalized_subject = ?
           ORDER BY last_message_at DESC LIMIT 20`
        )
          .bind(ctx.inbox_id, normalized)
          .all<{
            thread_id: string;
            normalized_subject: string;
            participants: string;
            last_message_at: string;
          }>()
      ).results.map((r) => ({
        thread_id: r.thread_id,
        normalized_subject: r.normalized_subject,
        participants: JSON.parse(r.participants) as string[],
        last_message_at: r.last_message_at
      }));
  const resolution = resolveThread({ referencedThreadId, subject, participants, candidates });
  const threadId = resolution.kind === "existing" ? resolution.thread_id : newId("thread");
  const preview = (input.text ?? "").slice(0, 140);

  await env.MAIL.put(`raw/${ctx.inbox_id}/${msgId}.eml`, raw);

  const statements: D1PreparedStatement[] = [];
  if (resolution.kind === "new") {
    statements.push(
      env.DB.prepare(
        `INSERT INTO threads (thread_id, org_id, pod_id, inbox_id, subject, normalized_subject,
           preview, participants, labels, message_count, last_message_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', 1, ?, ?, ?)`
      ).bind(
        threadId, ctx.org_id, ctx.pod_id, ctx.inbox_id, subject, normalized,
        preview, JSON.stringify(participants), now, now, now
      )
    );
  } else {
    statements.push(
      env.DB.prepare(
        `UPDATE threads SET message_count = message_count + 1, last_message_at = ?,
           preview = ?, updated_at = ? WHERE thread_id = ?`
      ).bind(now, preview, now, threadId)
    );
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO messages (msg_id, org_id, pod_id, inbox_id, thread_id, direction, state,
         from_addr, to_addrs, cc_addrs, bcc_addrs, subject, text, html,
         extracted_text, extracted_html, labels, rfc822_message_id, in_reply_to, client_id,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'outbound', 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      msgId, ctx.org_id, ctx.pod_id, ctx.inbox_id, threadId,
      ctx.inbox_id, JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc),
      subject, input.text ?? null, input.html ?? null,
      input.text ?? null, input.html ?? null,
      JSON.stringify(input.labels ?? []), rfc822MessageId,
      refIds[0] ?? null, input.client_id ?? null, now, now
    )
  );
  statements.push(
    env.DB.prepare(
      `INSERT INTO message_id_lookup (inbox_id, rfc822_message_id, thread_id, msg_id)
       VALUES (?, ?, ?, ?) ON CONFLICT (inbox_id, rfc822_message_id) DO NOTHING`
    ).bind(ctx.inbox_id, rfc822MessageId, threadId, msgId)
  );
  await env.DB.batch(statements);

  let state: SentMessage["state"];
  let providerError: string | null = null;
  try {
    await provider.send({ from: ctx.inbox_id, to: recipients, raw });
    state = "sent";
  } catch (err) {
    state = "rejected";
    providerError = String(err);
  }
  await env.DB.prepare("UPDATE messages SET state = ?, updated_at = ? WHERE msg_id = ?")
    .bind(state, new Date().toISOString(), msgId)
    .run();
  await bumpUsage(env.DB, ctx.org_id, "emails_sent", 1);
  await emitEvent(env.DB, {
    type: state === "sent" ? "message.sent" : "message.rejected",
    org_id: ctx.org_id,
    pod_id: ctx.pod_id,
    inbox_id: ctx.inbox_id,
    data: {
      message: {
        message_id: msgId,
        inbox_id: ctx.inbox_id,
        thread_id: threadId,
        organization_id: ctx.org_id,
        pod_id: ctx.pod_id,
        direction: "outbound",
        state,
        from: ctx.inbox_id,
        to,
        cc,
        bcc,
        subject,
        text: input.text ?? null,
        html: input.html ?? null,
        rfc822_message_id: rfc822MessageId,
        created_at: now,
        updated_at: now
      },
      ...(providerError ? { provider_error: providerError } : {})
    }
  });

  if (state === "rejected") {
    console.error(JSON.stringify({ msg: "send_rejected", msg_id: msgId, error: providerError }));
  }
  return { message_id: msgId, thread_id: threadId, state, rfc822_message_id: rfc822MessageId };
}
