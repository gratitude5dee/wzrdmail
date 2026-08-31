import {
  extractReplyHtml,
  extractReplyText,
  newId,
  normalizeSubject,
  parseMessageIdRefs,
  resolveThread,
  type ThreadCandidate
} from "@wzrdmail/core";
import PostalMime, { type Email } from "postal-mime";
import type { Env } from "../env.js";
import { bumpUsage, emitEvent } from "../lib/events.js";
import { detectDsn } from "./dsn.js";

export interface IngestInput {
  raw: ArrayBuffer;
  rawKey: string;
  envelopeFrom: string;
  envelopeTo: string;
}

export type IngestResult =
  | { kind: "unrouted" }
  | { kind: "dsn"; event: "message.bounced" | "message.complained" }
  | { kind: "duplicate"; msg_id: string; thread_id: string }
  | { kind: "stored"; msg_id: string; thread_id: string };

/** D1 row width discipline (§4): bodies over 64 KB live only in R2. */
const MAX_BODY_BYTES = 64 * 1024;
/** Guard against crafted MIME with pathological part counts. */
const MAX_ATTACHMENTS = 100;

function truncateBody(value: string | null): { value: string | null; truncated: boolean } {
  if (value === null || value.length <= MAX_BODY_BYTES) {
    return { value, truncated: false };
  }
  return { value: value.slice(0, MAX_BODY_BYTES), truncated: true };
}

interface InboxRow {
  inbox_id: string;
  org_id: string;
  pod_id: string;
}

async function resolveInbox(db: D1Database, address: string): Promise<InboxRow | null> {
  const at = address.lastIndexOf("@");
  if (at < 1) return null;
  const username = address.slice(0, at).toLowerCase();
  const domain = address.slice(at + 1).toLowerCase();
  return db
    .prepare(
      "SELECT inbox_id, org_id, pod_id FROM inboxes WHERE username = ? AND domain = ? AND deleted_at IS NULL"
    )
    .bind(username, domain)
    .first<InboxRow>();
}

function addressList(list: { address?: string }[] | undefined): string[] {
  return (list ?? [])
    .map((a) => a.address?.toLowerCase() ?? "")
    .filter((a) => a.length > 0);
}

async function handleDsn(
  env: Env,
  inbox: InboxRow,
  email: Email,
  report: NonNullable<ReturnType<typeof detectDsn>>
): Promise<IngestResult> {
  let original: { msg_id: string; thread_id: string } | null = null;
  for (const mid of report.originalMessageIds) {
    original = await env.DB.prepare(
      "SELECT msg_id, thread_id FROM message_id_lookup WHERE inbox_id = ? AND rfc822_message_id = ?"
    )
      .bind(inbox.inbox_id, mid)
      .first<{ msg_id: string; thread_id: string }>();
    if (original) break;
  }
  const eventType = report.kind === "complaint" ? "message.complained" : "message.bounced";
  const state = report.kind === "complaint" ? "complained" : "bounced";
  const now = new Date().toISOString();
  const reason = report.kind === "complaint" ? "complaint" : "bounce";

  const statements: D1PreparedStatement[] = [];
  if (original) {
    statements.push(
      env.DB.prepare("UPDATE messages SET state = ?, updated_at = ? WHERE msg_id = ?").bind(
        state,
        now,
        original.msg_id
      )
    );
  }
  for (const recipient of report.recipients) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO suppressions (org_id, address, reason, source_msg_id, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (COALESCE(org_id, ''), address) DO NOTHING`
      ).bind(inbox.org_id, recipient, reason, original?.msg_id ?? null, now)
    );
  }
  if (statements.length > 0) await env.DB.batch(statements);

  await emitEvent(env.DB, {
    type: eventType,
    org_id: inbox.org_id,
    pod_id: inbox.pod_id,
    inbox_id: inbox.inbox_id,
    data: {
      original_message_id: original?.msg_id ?? null,
      recipients: report.recipients,
      reporter: email.from?.address ?? null
    }
  });
  return { kind: "dsn", event: eventType };
}

export async function ingestEmail(env: Env, input: IngestInput): Promise<IngestResult> {
  const inbox = await resolveInbox(env.DB, input.envelopeTo);
  if (!inbox) {
    console.log(
      JSON.stringify({ msg: "email_unrouted", to: input.envelopeTo, r2_key: input.rawKey })
    );
    return { kind: "unrouted" };
  }

  const email = await PostalMime.parse(input.raw);

  const dsn = detectDsn(email);
  if (dsn) return handleDsn(env, inbox, email, dsn);

  // SMTP-level retries redeliver the same MIME; the RFC Message-ID makes
  // redelivery a no-op instead of a duplicate row.
  if (email.messageId) {
    const existing = await env.DB.prepare(
      "SELECT msg_id, thread_id FROM message_id_lookup WHERE inbox_id = ? AND rfc822_message_id = ?"
    )
      .bind(inbox.inbox_id, email.messageId)
      .first<{ msg_id: string; thread_id: string }>();
    if (existing) {
      return { kind: "duplicate", msg_id: existing.msg_id, thread_id: existing.thread_id };
    }
  }

  const now = new Date().toISOString();
  const msgId = newId("msg");
  const subject = email.subject ?? "";
  const textBody = truncateBody(email.text ?? null);
  const htmlBody = truncateBody(email.html ?? null);
  const text = textBody.value;
  const html = htmlBody.value;
  const extractedText = text ? extractReplyText(text) : null;
  const extractedHtml = html ? extractReplyHtml(html) : null;
  const bodyTruncated = textBody.truncated || htmlBody.truncated;
  const fromAddr = email.from?.address?.toLowerCase() ?? input.envelopeFrom.toLowerCase();
  const toAddrs = addressList(email.to);
  const ccAddrs = addressList(email.cc);
  const participants = [...new Set([fromAddr, ...toAddrs, ...ccAddrs])];
  // The inbox's own address appears on every thread; including it in overlap
  // scoring would merge unrelated conversations that share a subject.
  const inboxAddr = inbox.inbox_id.toLowerCase();
  const overlapParticipants = participants.filter((p) => p !== inboxAddr);

  // Threading (§6.5): Message-ID references first, subject+participants fallback.
  const refIds = [
    ...parseMessageIdRefs(email.inReplyTo),
    ...parseMessageIdRefs(email.references)
  ];
  let referencedThreadId: string | null = null;
  for (const mid of refIds) {
    const hit = await env.DB.prepare(
      "SELECT thread_id FROM message_id_lookup WHERE inbox_id = ? AND rfc822_message_id = ?"
    )
      .bind(inbox.inbox_id, mid)
      .first<{ thread_id: string }>();
    if (hit) {
      referencedThreadId = hit.thread_id;
      break;
    }
  }
  const normalized = normalizeSubject(subject);
  let candidates: ThreadCandidate[] = [];
  if (!referencedThreadId && normalized.length > 0) {
    const rows = await env.DB.prepare(
      `SELECT thread_id, normalized_subject, participants, last_message_at
       FROM threads WHERE inbox_id = ? AND normalized_subject = ?
       ORDER BY last_message_at DESC LIMIT 20`
    )
      .bind(inbox.inbox_id, normalized)
      .all<{
        thread_id: string;
        normalized_subject: string;
        participants: string;
        last_message_at: string;
      }>();
    candidates = rows.results.map((r) => ({
      thread_id: r.thread_id,
      normalized_subject: r.normalized_subject,
      participants: JSON.parse(r.participants) as string[],
      last_message_at: r.last_message_at
    }));
  }
  const resolution = resolveThread({
    referencedThreadId,
    subject,
    participants: overlapParticipants,
    candidates
  });
  const threadId = resolution.kind === "existing" ? resolution.thread_id : newId("thread");
  const preview = (extractedText ?? text ?? "").slice(0, 140);

  // Attachments go to R2 before the D1 batch commits.
  const attachmentRows: { att_id: string; filename: string; content_type: string; size: number; content_id: string | null }[] = [];
  for (const att of email.attachments.slice(0, MAX_ATTACHMENTS)) {
    const attId = newId("att");
    const content =
      typeof att.content === "string" ? new TextEncoder().encode(att.content) : att.content;
    await env.MAIL.put(`att/${inbox.inbox_id}/${msgId}/${attId}`, content);
    attachmentRows.push({
      att_id: attId,
      filename: att.filename ?? "attachment",
      content_type: att.mimeType,
      size: content.byteLength,
      content_id: att.contentId ?? null
    });
  }

  const statements: D1PreparedStatement[] = [];
  if (resolution.kind === "new") {
    statements.push(
      env.DB.prepare(
        `INSERT INTO threads (thread_id, org_id, pod_id, inbox_id, subject, normalized_subject,
           preview, participants, labels, message_count, last_message_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
      ).bind(
        threadId,
        inbox.org_id,
        inbox.pod_id,
        inbox.inbox_id,
        subject,
        normalized,
        preview,
        JSON.stringify(participants),
        JSON.stringify(["unread"]),
        now,
        now,
        now
      )
    );
  } else {
    statements.push(
      env.DB.prepare(
        `UPDATE threads SET message_count = message_count + 1, last_message_at = ?,
           preview = ?, updated_at = ?,
           participants = (SELECT json_group_array(DISTINCT value) FROM (
             SELECT value FROM json_each(participants)
             UNION SELECT value FROM json_each(?))),
           labels = CASE WHEN EXISTS (SELECT 1 FROM json_each(labels) WHERE value = 'unread')
             THEN labels ELSE json_insert(labels, '$[#]', 'unread') END
         WHERE thread_id = ?`
      ).bind(now, preview, now, JSON.stringify(participants), threadId)
    );
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO messages (msg_id, org_id, pod_id, inbox_id, thread_id, direction, state,
         from_addr, to_addrs, cc_addrs, bcc_addrs, subject, text, html,
         extracted_text, extracted_html, body_truncated, labels, rfc822_message_id, in_reply_to,
         raw_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'inbound', 'received', ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      msgId,
      inbox.org_id,
      inbox.pod_id,
      inbox.inbox_id,
      threadId,
      fromAddr,
      JSON.stringify(toAddrs),
      JSON.stringify(ccAddrs),
      subject,
      text,
      html,
      extractedText,
      extractedHtml,
      bodyTruncated ? 1 : 0,
      JSON.stringify(["unread"]),
      email.messageId ?? null,
      email.inReplyTo ?? null,
      input.rawKey,
      now,
      now
    )
  );
  if (email.messageId) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO message_id_lookup (inbox_id, rfc822_message_id, thread_id, msg_id)
         VALUES (?, ?, ?, ?) ON CONFLICT (inbox_id, rfc822_message_id) DO NOTHING`
      ).bind(inbox.inbox_id, email.messageId, threadId, msgId)
    );
  }
  for (const att of attachmentRows) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO attachments (att_id, msg_id, inbox_id, filename, content_type, size, content_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(att.att_id, msgId, inbox.inbox_id, att.filename, att.content_type, att.size, att.content_id, now)
    );
  }
  await env.DB.batch(statements);

  await bumpUsage(env.DB, inbox.org_id, "emails_received", 1);
  await bumpUsage(env.DB, inbox.org_id, "storage_bytes", input.raw.byteLength);
  await emitEvent(env.DB, {
    type: "message.received",
    org_id: inbox.org_id,
    pod_id: inbox.pod_id,
    inbox_id: inbox.inbox_id,
    data: {
      message: {
        message_id: msgId,
        inbox_id: inbox.inbox_id,
        thread_id: threadId,
        organization_id: inbox.org_id,
        pod_id: inbox.pod_id,
        direction: "inbound",
        state: "received",
        from: fromAddr,
        to: toAddrs,
        cc: ccAddrs,
        bcc: [],
        subject,
        text,
        html,
        extracted_text: extractedText,
        extracted_html: extractedHtml,
        labels: ["unread"],
        attachments: attachmentRows.map((a) => ({
          attachment_id: a.att_id,
          filename: a.filename,
          content_type: a.content_type,
          size: a.size,
          content_id: a.content_id
        })),
        in_reply_to: email.inReplyTo ?? null,
        rfc822_message_id: email.messageId ?? null,
        created_at: now,
        updated_at: now
      }
    }
  });

  return { kind: "stored", msg_id: msgId, thread_id: threadId };
}
