import {
  ApiError,
  newId,
  normalizeSubject,
  parseMessageIdRefs,
  resolveThread,
  PLATFORM_LIMITS,
  type MailProvider,
  type SendAttachmentInput,
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
  state: "sent" | "rejected" | "scheduled";
  rfc822_message_id: string;
  send_at?: string;
  rejected_recipients?: { address: string; error: string }[];
}

/**
 * Transport-managed headers callers may never override: doing so would let an
 * authenticated key forge sender/recipient metadata or break threading.
 */
const PROTECTED_HEADERS = new Set([
  "from",
  "sender",
  "to",
  "cc",
  "bcc",
  "subject",
  "reply-to",
  "message-id",
  "date",
  "return-path",
  "received",
  "dkim-signature",
  "mime-version",
  "content-type",
  "content-transfer-encoding"
]);

/** An in-flight reservation older than this is presumed dead and can be retried. */
const RESERVATION_TTL_MS = 10 * 60 * 1000;

/** Hard cap on a single fetched attachment, independent of the MIME total. */
const FETCHED_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
const ATTACHMENT_FETCH_REDIRECTS = 3;

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "::1" || h === "[::1]") return true;
  if (h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local") || h.endsWith(".lan")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return true;
  }
  return false;
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Fetch a hosted attachment. https-only, no private hosts, bounded redirects. */
async function fetchAttachment(url: string): Promise<Uint8Array> {
  let current = url;
  for (let hop = 0; hop <= ATTACHMENT_FETCH_REDIRECTS; hop++) {
    const parsed = URL.parse(current);
    if (!parsed || parsed.protocol !== "https:") {
      throw new ApiError("validation_error", `attachment path must be https: ${url}`);
    }
    if (parsed.username || parsed.password) {
      throw new ApiError("validation_error", "attachment path must not carry credentials");
    }
    if (isPrivateHost(parsed.hostname)) {
      throw new ApiError("validation_error", `attachment path resolves to a private host: ${parsed.hostname}`);
    }
    const res = await fetch(parsed.toString(), { redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new ApiError("validation_error", `attachment fetch redirect without location: ${res.status}`);
      current = new URL(location, parsed).toString();
      continue;
    }
    if (!res.ok) {
      throw new ApiError("validation_error", `attachment fetch failed (${res.status})`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > FETCHED_ATTACHMENT_MAX_BYTES) {
      throw new ApiError("message_too_large", `attachment exceeds ${FETCHED_ATTACHMENT_MAX_BYTES} bytes`);
    }
    return buf;
  }
  throw new ApiError("validation_error", `attachment fetch exceeded ${ATTACHMENT_FETCH_REDIRECTS} redirects`);
}

interface ResolvedAttachment {
  attId: string;
  filename: string;
  contentType: string;
  dataBase64: string;
  bytes: Uint8Array;
  contentId?: string;
}

function base64Decode(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function resolveAttachments(
  attachments: SendAttachmentInput[] | undefined
): Promise<ResolvedAttachment[]> {
  const resolved: ResolvedAttachment[] = [];
  for (const att of attachments ?? []) {
    const bytes =
      att.path !== undefined ? await fetchAttachment(att.path) : base64Decode(att.content as string);
    resolved.push({
      attId: newId("att"),
      filename: att.filename,
      contentType: att.content_type,
      dataBase64: base64Encode(bytes),
      bytes,
      ...(att.content_id ? { contentId: att.content_id } : {})
    });
  }
  return resolved;
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
  if (input.client_id) {
    const owner = crypto.randomUUID();
    const replay = await env.DB.prepare(
      "SELECT response, created_at, owner FROM idempotency_keys WHERE org_id = ? AND resource_type = 'message' AND client_id = ?"
    )
      .bind(ctx.org_id, input.client_id)
      .first<{ response: string; created_at: string; owner: string }>();
    if (replay) {
      if (replay.response !== "") {
        return JSON.parse(replay.response) as SentMessage;
      }
      const age = Date.now() - new Date(replay.created_at).getTime();
      if (age <= RESERVATION_TTL_MS) {
        throw new ApiError("conflict", "a request with this client_id is already in flight");
      }
      // Stale reservation from an interrupted request: exactly one caller may
      // take ownership. The owner token guards every later write, so an
      // expired claimant that is still running can neither reach the provider
      // nor commit a result after this point.
      const takeover = await env.DB.prepare(
        `UPDATE idempotency_keys SET created_at = ?, owner = ?
         WHERE org_id = ? AND resource_type = 'message' AND client_id = ?
           AND response = '' AND owner = ?`
      )
        .bind(new Date().toISOString(), owner, ctx.org_id, input.client_id, replay.owner)
        .run();
      if (takeover.meta.changes === 0) {
        throw new ApiError("conflict", "a request with this client_id is already in flight");
      }
      return runReserved(env, provider, ctx, input, { clientId: input.client_id, owner });
    }
    // Reserve the key before any side effects so concurrent retries cannot
    // both reach the provider.
    const reserved = await env.DB.prepare(
      `INSERT INTO idempotency_keys (org_id, resource_type, client_id, response, created_at, owner)
       VALUES (?, 'message', ?, '', ?, ?) ON CONFLICT DO NOTHING`
    )
      .bind(ctx.org_id, input.client_id, new Date().toISOString(), owner)
      .run();
    if (reserved.meta.changes === 0) {
      throw new ApiError("conflict", "a request with this client_id is already in flight");
    }
    return runReserved(env, provider, ctx, input, { clientId: input.client_id, owner });
  }
  return doSend(env, provider, ctx, input, null);
}

interface Reservation {
  clientId: string;
  owner: string;
}

async function runReserved(
  env: Env,
  provider: MailProvider,
  ctx: SendContext,
  input: SendMessageInput,
  reservation: Reservation
): Promise<SentMessage> {
  try {
    return await doSend(env, provider, ctx, input, reservation);
  } catch (err) {
    // Release the client_id for retries — but only while we still own the
    // reservation and the response is empty, i.e. before the provider could
    // have delivered anything.
    await env.DB.prepare(
      "DELETE FROM idempotency_keys WHERE org_id = ? AND resource_type = 'message' AND client_id = ? AND response = '' AND owner = ?"
    )
      .bind(ctx.org_id, reservation.clientId, reservation.owner)
      .run();
    throw err;
  }
}

async function doSend(
  env: Env,
  provider: MailProvider,
  ctx: SendContext,
  input: SendMessageInput,
  reservation: Reservation | null
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
  // Normalize to UTC: dispatch compares timestamp strings, so an offset
  // timestamp would sort incorrectly against ISO-Z values.
  const sendAt =
    input.send_at && new Date(input.send_at).getTime() > Date.now()
      ? new Date(input.send_at).toISOString()
      : null;

  // Build MIME
  const mime = createMimeMessage();
  mime.setSender(ctx.inbox_id);
  mime.setTo(to);
  if (cc.length > 0) mime.setCc(cc);
  if (bcc.length > 0) mime.setBcc(bcc);
  mime.setSubject(subject);
  mime.setHeader("Message-ID", rfc822MessageId);
  if (input.reply_to) {
    const replyTo = Array.isArray(input.reply_to) ? input.reply_to : [input.reply_to];
    if (replyTo.length === 1) {
      mime.setHeader("Reply-To", replyTo[0]!);
    } else {
      // mimetext validates Reply-To as a single mailbox; a multi-address
      // Reply-To is RFC-legal, so write it as a raw custom field instead.
      mime.headers.setCustom({ name: "Reply-To", value: replyTo.join(", ") });
    }
  }
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    if (PROTECTED_HEADERS.has(key.toLowerCase())) {
      throw new ApiError("validation_error", `header ${key} cannot be overridden`);
    }
    mime.setHeader(key, value);
  }
  if (input.text) mime.addMessage({ contentType: "text/plain", data: input.text });
  if (input.html) mime.addMessage({ contentType: "text/html", data: input.html });
  if (!input.text && !input.html) {
    mime.addMessage({ contentType: "text/plain", data: "" });
  }
  const resolvedAttachments = await resolveAttachments(input.attachments);
  for (const att of resolvedAttachments) {
    mime.addAttachment({
      filename: att.filename,
      contentType: att.contentType,
      data: att.dataBase64,
      encoding: "base64",
      ...(att.contentId
        ? {
            inline: true,
            headers: { "Content-ID": `<${att.contentId}>` }
          }
        : {})
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
  // The inbox itself is on every thread; using it for overlap would merge
  // unrelated conversations that share a subject.
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
  const resolution = resolveThread({
    referencedThreadId,
    subject,
    participants: recipients,
    candidates
  });
  const threadId = resolution.kind === "existing" ? resolution.thread_id : newId("thread");
  const preview = (input.text ?? "").slice(0, 140);

  // Verify reservation ownership before any deliverable state is committed:
  // a stale claimant whose reservation was taken over must not schedule or
  // send another copy.
  if (reservation) {
    const renewed = await env.DB.prepare(
      `UPDATE idempotency_keys SET created_at = ?
       WHERE org_id = ? AND resource_type = 'message' AND client_id = ?
         AND response = '' AND owner = ?`
    )
      .bind(new Date().toISOString(), ctx.org_id, reservation.clientId, reservation.owner)
      .run();
    if (renewed.meta.changes === 0) {
      throw new ApiError("conflict", "a request with this client_id is already in flight");
    }
  }

  const rawR2Key = `raw/${ctx.inbox_id}/${msgId}.eml`;
  await env.MAIL.put(rawR2Key, raw);

  const statements: D1PreparedStatement[] = [];
  if (resolution.kind === "new") {
    statements.push(
      env.DB.prepare(
        `INSERT INTO threads (thread_id, org_id, pod_id, inbox_id, subject, normalized_subject,
           preview, participants, labels, message_count, last_message_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '["sent"]', 1, ?, ?, ?)`
      ).bind(
        threadId, ctx.org_id, ctx.pod_id, ctx.inbox_id, subject, normalized,
        preview, JSON.stringify(participants), now, now, now
      )
    );
  } else {
    statements.push(
      env.DB.prepare(
        `UPDATE threads SET message_count = message_count + 1, last_message_at = ?,
           preview = ?, updated_at = ?, deleted_at = NULL,
           labels = CASE WHEN EXISTS (SELECT 1 FROM json_each(labels) WHERE value = 'sent')
             THEN labels ELSE json_insert(labels, '$[#]', 'sent') END
         WHERE thread_id = ?`
      ).bind(now, preview, now, threadId)
    );
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO messages (msg_id, org_id, pod_id, inbox_id, thread_id, direction, state,
         from_addr, to_addrs, cc_addrs, bcc_addrs, subject, text, html,
         extracted_text, extracted_html, labels, rfc822_message_id, in_reply_to, client_id,
         raw_key, send_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      msgId, ctx.org_id, ctx.pod_id, ctx.inbox_id, threadId,
      sendAt ? "scheduled" : "queued",
      ctx.inbox_id, JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc),
      subject, input.text ?? null, input.html ?? null,
      input.text ?? null, input.html ?? null,
      JSON.stringify(input.labels ?? []), rfc822MessageId,
      refIds[0] ?? null, input.client_id ?? null, rawR2Key, sendAt, now, now
    )
  );
  statements.push(
    env.DB.prepare(
      `INSERT INTO message_id_lookup (inbox_id, rfc822_message_id, thread_id, msg_id)
       VALUES (?, ?, ?, ?) ON CONFLICT (inbox_id, rfc822_message_id) DO NOTHING`
    ).bind(ctx.inbox_id, rfc822MessageId, threadId, msgId)
  );
  for (const att of resolvedAttachments) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO attachments (att_id, msg_id, inbox_id, filename, content_type, size, content_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        att.attId,
        msgId,
        ctx.inbox_id,
        att.filename,
        att.contentType,
        att.bytes.length,
        att.contentId ?? null,
        now
      )
    );
  }
  // For scheduled sends the idempotency response is committed atomically with
  // the message rows: a replay can never observe a committed message without
  // its stored response (which would let it schedule a second copy).
  const scheduled: SentMessage | null = sendAt
    ? {
        message_id: msgId,
        thread_id: threadId,
        state: "scheduled",
        rfc822_message_id: rfc822MessageId,
        send_at: sendAt
      }
    : null;
  if (scheduled && reservation) {
    statements.push(
      env.DB.prepare(
        "UPDATE idempotency_keys SET response = ? WHERE org_id = ? AND resource_type = 'message' AND client_id = ? AND owner = ?"
      ).bind(JSON.stringify(scheduled), ctx.org_id, reservation.clientId, reservation.owner)
    );
  }
  await env.DB.batch(statements);
  for (const att of resolvedAttachments) {
    await env.MAIL.put(`att/${ctx.inbox_id}/${msgId}/${att.attId}`, att.bytes);
  }

  if (scheduled) {
    await bumpUsage(env.DB, ctx.org_id, "emails_scheduled", 1);
    await emitEvent(env.DB, {
      type: "message.scheduled",
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
          state: "scheduled",
          from: ctx.inbox_id,
          to,
          cc,
          bcc,
          subject,
          send_at: sendAt,
          created_at: now,
          updated_at: now
        }
      }
    });
    return scheduled;
  }

  if (reservation) {
    // Renew the lease and verify ownership again immediately before the
    // provider call: a claimant whose reservation was taken over must not send.
    const renewed = await env.DB.prepare(
      `UPDATE idempotency_keys SET created_at = ?
       WHERE org_id = ? AND resource_type = 'message' AND client_id = ?
         AND response = '' AND owner = ?`
    )
      .bind(new Date().toISOString(), ctx.org_id, reservation.clientId, reservation.owner)
      .run();
    if (renewed.meta.changes === 0) {
      throw new ApiError("conflict", "a request with this client_id is already in flight");
    }
  }

  let state: SentMessage["state"];
  let providerError: string | null = null;
  let rejectedRecipients: { address: string; error: string }[] = [];
  try {
    const outcome = await provider.send({ from: ctx.inbox_id, to: recipients, raw });
    rejectedRecipients = outcome.rejected;
    // A partial failure is still a send: acceptances must not be erased.
    state = outcome.accepted.length > 0 ? "sent" : "rejected";
    if (state === "rejected" && outcome.rejected.length > 0) {
      providerError = outcome.rejected.map((r) => `${r.address}: ${r.error}`).join("; ");
    }
  } catch (err) {
    state = "rejected";
    providerError = String(err);
  }
  const result: SentMessage = {
    message_id: msgId,
    thread_id: threadId,
    state,
    rfc822_message_id: rfc822MessageId,
    ...(rejectedRecipients.length > 0 ? { rejected_recipients: rejectedRecipients } : {})
  };
  // Persist the idempotency response the moment the provider outcome is known,
  // so later failures can never release the key and trigger a duplicate send.
  if (reservation) {
    await env.DB.prepare(
      "UPDATE idempotency_keys SET response = ? WHERE org_id = ? AND resource_type = 'message' AND client_id = ? AND owner = ?"
    )
      .bind(JSON.stringify(result), ctx.org_id, reservation.clientId, reservation.owner)
      .run();
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
      ...(providerError ? { provider_error: providerError } : {}),
      ...(rejectedRecipients.length > 0 ? { rejected_recipients: rejectedRecipients } : {})
    }
  });

  if (state === "rejected") {
    console.error(JSON.stringify({ msg: "send_rejected", msg_id: msgId, error: providerError }));
  }
  return result;
}
