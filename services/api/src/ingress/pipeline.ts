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
import { evaluateSenderLists } from "./lists.js";

export interface IngestInput {
  raw: ArrayBuffer;
  rawKey: string;
  envelopeFrom: string;
  envelopeTo: string;
}

export type IngestResult =
  | { kind: "unrouted" }
  | { kind: "blocked"; reason: "block_entry" | "not_allowlisted" }
  | { kind: "dsn"; event: "message.bounced" | "message.complained" }
  | { kind: "duplicate"; msg_id: string; thread_id: string }
  | { kind: "stored"; msg_id: string; thread_id: string };

/** D1 row width discipline (§4): bodies over 64 KB live only in R2. */
const MAX_BODY_BYTES = 64 * 1024;
/** Guard against crafted MIME with pathological part counts. */
const MAX_ATTACHMENTS = 100;
/** A pending Message-ID claim older than this is treated as abandoned. */
const CLAIM_TTL_MS = 10 * 60 * 1000;

/** Thrown when another invocation is actively ingesting the same Message-ID;
 * the SMTP layer retries delivery later. */
export class IngestInFlightError extends Error {
  constructor(messageId: string) {
    super(`ingestion already in flight for Message-ID ${messageId}; retry later`);
    this.name = "IngestInFlightError";
  }
}

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

  const senderVerdict = await evaluateSenderLists(
    env.DB,
    inbox.org_id,
    inbox.inbox_id,
    input.envelopeFrom
  );
  if (senderVerdict.verdict === "blocked") {
    await emitEvent(env.DB, {
      type: "message.rejected",
      org_id: inbox.org_id,
      pod_id: inbox.pod_id,
      inbox_id: inbox.inbox_id,
      data: {
        direction: "inbound",
        from: input.envelopeFrom.toLowerCase(),
        to: input.envelopeTo.toLowerCase(),
        reason: senderVerdict.reason,
        pattern: senderVerdict.pattern
      }
    });
    return { kind: "blocked", reason: senderVerdict.reason };
  }

  const email = await PostalMime.parse(input.raw);

  const dsn = detectDsn(email);
  if (dsn) return handleDsn(env, inbox, email, dsn);

  // SMTP-level retries redeliver the same MIME; the RFC Message-ID makes
  // redelivery a no-op instead of a duplicate row. Pending (uncommitted)
  // claims are not duplicates: a fresh one means another invocation is
  // ingesting right now, a stale one is abandoned work we may reclaim.
  let staleClaimMsgId: string | null = null;
  if (email.messageId) {
    const existing = await env.DB.prepare(
      "SELECT msg_id, thread_id, committed, claimed_at FROM message_id_lookup WHERE inbox_id = ? AND rfc822_message_id = ?"
    )
      .bind(inbox.inbox_id, email.messageId)
      .first<{ msg_id: string; thread_id: string; committed: number; claimed_at: string | null }>();
    if (existing) {
      if (existing.committed === 1) {
        return { kind: "duplicate", msg_id: existing.msg_id, thread_id: existing.thread_id };
      }
      const age = Date.now() - new Date(existing.claimed_at ?? 0).getTime();
      if (age <= CLAIM_TTL_MS) {
        throw new IngestInFlightError(email.messageId);
      }
      staleClaimMsgId = existing.msg_id;
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

  // Claim the Message-ID as pending before any side effects: the msg_id is
  // the ownership token, and only the claim holder may commit. An active
  // claimant holds a fresh lease and cannot be taken over; abandoned claims
  // (lease expired, never committed) are reclaimed by exactly one retry.
  if (email.messageId) {
    if (staleClaimMsgId) {
      const reclaimed = await env.DB.prepare(
        `UPDATE message_id_lookup SET msg_id = ?, thread_id = ?, claimed_at = ?
         WHERE inbox_id = ? AND rfc822_message_id = ? AND committed = 0 AND msg_id = ?`
      )
        .bind(msgId, threadId, now, inbox.inbox_id, email.messageId, staleClaimMsgId)
        .run();
      if (reclaimed.meta.changes === 0) {
        throw new IngestInFlightError(email.messageId);
      }
    } else {
      const claimed = await env.DB.prepare(
        `INSERT INTO message_id_lookup (inbox_id, rfc822_message_id, thread_id, msg_id, committed, claimed_at)
         VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT (inbox_id, rfc822_message_id) DO NOTHING`
      )
        .bind(inbox.inbox_id, email.messageId, threadId, msgId, now)
        .run();
      if (claimed.meta.changes === 0) {
        const winner = await env.DB.prepare(
          "SELECT msg_id, thread_id, committed FROM message_id_lookup WHERE inbox_id = ? AND rfc822_message_id = ?"
        )
          .bind(inbox.inbox_id, email.messageId)
          .first<{ msg_id: string; thread_id: string; committed: number }>();
        if (winner && winner.committed === 1) {
          return { kind: "duplicate", msg_id: winner.msg_id, thread_id: winner.thread_id };
        }
        throw new IngestInFlightError(email.messageId);
      }
    }
  }

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

  // The commit batch is one transaction. When a Message-ID claim exists, the
  // first statement flips it to committed if and only if we still own it
  // (msg_id is the ownership token), and every write is guarded by that same
  // ownership: a claimant that lost its claim writes nothing at all.
  const ownershipExists =
    "EXISTS (SELECT 1 FROM message_id_lookup WHERE inbox_id = ? AND rfc822_message_id = ? AND msg_id = ? AND committed = 1)";
  const guard = email.messageId ? ` AND ${ownershipExists}` : "";
  const selectGuard = email.messageId ? ` WHERE ${ownershipExists}` : "";
  const guardBinds = email.messageId ? [inbox.inbox_id, email.messageId, msgId] : [];

  const statements: D1PreparedStatement[] = [];
  if (email.messageId) {
    statements.push(
      env.DB.prepare(
        `UPDATE message_id_lookup SET committed = 1
         WHERE inbox_id = ? AND rfc822_message_id = ? AND msg_id = ? AND committed = 0`
      ).bind(inbox.inbox_id, email.messageId, msgId)
    );
  }
  if (resolution.kind === "new") {
    statements.push(
      env.DB.prepare(
        `INSERT INTO threads (thread_id, org_id, pod_id, inbox_id, subject, normalized_subject,
           preview, participants, labels, message_count, last_message_at, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?${selectGuard}`
      ).bind(
        threadId,
        inbox.org_id,
        inbox.pod_id,
        inbox.inbox_id,
        subject,
        normalized,
        preview,
        JSON.stringify(participants),
        JSON.stringify(["unread", "received"]),
        now,
        now,
        now,
        ...guardBinds
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
           labels = (SELECT json_group_array(DISTINCT value) FROM (
             SELECT value FROM json_each(labels)
             UNION SELECT value FROM json_each('["unread","received"]')))
         WHERE thread_id = ?${guard}`
      ).bind(now, preview, now, JSON.stringify(participants), threadId, ...guardBinds)
    );
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO messages (msg_id, org_id, pod_id, inbox_id, thread_id, direction, state,
         from_addr, to_addrs, cc_addrs, bcc_addrs, subject, text, html,
         extracted_text, extracted_html, body_truncated, labels, rfc822_message_id, in_reply_to,
         raw_key, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, 'inbound', 'received', ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${selectGuard}`
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
      now,
      ...guardBinds
    )
  );
  for (const att of attachmentRows) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO attachments (att_id, msg_id, inbox_id, filename, content_type, size, content_id, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?${selectGuard}`
      ).bind(att.att_id, msgId, inbox.inbox_id, att.filename, att.content_type, att.size, att.content_id, now, ...guardBinds)
    );
  }
  const batchResults = await env.DB.batch(statements);
  if (email.messageId && batchResults[0]?.meta.changes === 0) {
    // Our claim was reclaimed while we were uploading attachments: the guards
    // above made the whole transaction a no-op, so nothing was persisted.
    throw new IngestInFlightError(email.messageId);
  }

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
