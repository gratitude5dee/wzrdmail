import {
  ApiError,
  BatchGetMessagesInput,
  BatchSendInput,
  BatchUpdateMessagesInput,
  ForwardMessageInput,
  newId,
  ReplyMessageInput,
  SendMessageInput,
  ShareMessageInput,
  UpdateMessageInput
} from "@wzrdmail/core";
import { Hono } from "hono";
import type { Context } from "hono";
import { authenticate, requirePermission, type AuthedKey } from "../auth.js";
import { CloudflareEmailProvider } from "../egress/provider.js";
import { sendMessage, type SendContext } from "../egress/send.js";
import type { Env } from "../env.js";
import {
  collection,
  parseBody,
  parsePagination,
  requireInbox,
  withIdempotency,
  type InboxRow
} from "../lib/http.js";
import { emitEvent } from "../lib/events.js";
import { shareDocumentHtml } from "../lib/share.js";
import { processDueDeliveries } from "../lib/webhook-delivery.js";
import {
  applyLabelPatch,
  messageJson,
  type AttachmentRow,
  type MessageRow
} from "../lib/serialize.js";

export const messages = new Hono<{ Bindings: Env }>();

const MESSAGE_COLUMNS =
  "msg_id, org_id, pod_id, inbox_id, thread_id, direction, state, from_addr, to_addrs, cc_addrs, bcc_addrs, subject, text, html, extracted_text, extracted_html, labels, rfc822_message_id, in_reply_to, send_at, deleted_at, x_open_count, x_click_count, x_last_opened_at, x_last_clicked_at, created_at, updated_at";

/** `folder` query param: default hides trash; `trash` shows only trashed rows. */
function folderCondition(c: Context<{ Bindings: Env }>): string {
  const folder = c.req.query("folder") ?? "";
  if (folder === "trash") return "deleted_at IS NOT NULL";
  if (folder === "scheduled") return "deleted_at IS NULL AND state = 'scheduled'";
  if (folder === "" || folder === "all") return "deleted_at IS NULL";
  throw new ApiError("validation_error", "folder must be one of: all, trash, scheduled");
}

async function attachmentsFor(
  db: D1Database,
  msgIds: string[]
): Promise<Map<string, AttachmentRow[]>> {
  const map = new Map<string, AttachmentRow[]>();
  if (msgIds.length === 0) return map;
  const rows = (
    await db
      .prepare(
        `SELECT att_id, msg_id, filename, content_type, size, content_id
         FROM attachments WHERE msg_id IN (${msgIds.map(() => "?").join(",")})`
      )
      .bind(...msgIds)
      .all<AttachmentRow>()
  ).results;
  for (const row of rows) {
    const list = map.get(row.msg_id) ?? [];
    list.push(row);
    map.set(row.msg_id, list);
  }
  return map;
}

async function requireMessage(
  c: Context<{ Bindings: Env }>,
  inbox: InboxRow,
  msgId: string
): Promise<MessageRow> {
  const row = await c.env.DB.prepare(
    `SELECT ${MESSAGE_COLUMNS}, raw_key FROM messages WHERE msg_id = ? AND inbox_id = ?`
  )
    .bind(msgId, inbox.inbox_id)
    .first<MessageRow & { raw_key: string | null }>();
  if (!row) throw new ApiError("not_found", "no such message");
  return row;
}

async function messageWithAttachments(
  c: Context<{ Bindings: Env }>,
  row: MessageRow
): Promise<Record<string, unknown>> {
  const atts = await attachmentsFor(c.env.DB, [row.msg_id]);
  return messageJson(row, atts.get(row.msg_id) ?? []);
}

messages.get("/inboxes/:inbox_id/messages", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const { limit, cursor } = parsePagination(c);
  const labels = (c.req.query("labels") ?? "")
    .split(",")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const before = c.req.query("before") ?? null;
  const after = c.req.query("after") ?? null;

  const conditions = ["inbox_id = ?", folderCondition(c)];
  const binds: (string | number)[] = [inbox.inbox_id];
  if (before) {
    conditions.push("created_at < ?");
    binds.push(before);
  }
  if (after) {
    conditions.push("created_at > ?");
    binds.push(after);
  }
  for (const label of labels) {
    conditions.push("EXISTS (SELECT 1 FROM json_each(messages.labels) WHERE json_each.value = ?)");
    binds.push(label);
  }
  if (cursor) {
    conditions.push("(created_at < ? OR (created_at = ? AND msg_id < ?))");
    binds.push(cursor.v, cursor.v, cursor.id);
  }
  const rows = (
    await c.env.DB.prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC, msg_id DESC LIMIT ?`
    )
      .bind(...binds, limit + 1)
      .all<MessageRow>()
  ).results;
  const page = collection(rows, limit, (r) => ({ v: r.created_at, id: r.msg_id }));
  const atts = await attachmentsFor(c.env.DB, page.items.map((r) => r.msg_id));
  return c.json({
    messages: page.items.map((r) => messageJson(r, atts.get(r.msg_id) ?? [])),
    next_page_token: page.next_page_token ?? null
  });
});

messages.get("/inboxes/:inbox_id/messages/search", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const query = c.req.query("query") ?? "";
  if (query === "") throw new ApiError("validation_error", "query is required");
  const { limit, cursor } = parsePagination(c);
  const like = `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const binds: string[] = [inbox.inbox_id, like, like, like];
  let cursorSql = "";
  if (cursor) {
    cursorSql = " AND (created_at < ? OR (created_at = ? AND msg_id < ?))";
    binds.push(cursor.v, cursor.v, cursor.id);
  }
  const rows = (
    await c.env.DB.prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM messages
       WHERE inbox_id = ? AND deleted_at IS NULL
         AND (subject LIKE ? ESCAPE '\\' OR text LIKE ? ESCAPE '\\' OR from_addr LIKE ? ESCAPE '\\')${cursorSql}
       ORDER BY created_at DESC, msg_id DESC LIMIT ?`
    )
      .bind(...binds, limit + 1)
      .all<MessageRow>()
  ).results;
  const page = collection(rows, limit, (r) => ({ v: r.created_at, id: r.msg_id }));
  const atts = await attachmentsFor(c.env.DB, page.items.map((r) => r.msg_id));
  return c.json({
    messages: page.items.map((r) => messageJson(r, atts.get(r.msg_id) ?? [])),
    next_page_token: page.next_page_token ?? null
  });
});

messages.post("/inboxes/:inbox_id/messages/batch-send", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "send");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const input = await parseBody(c, BatchSendInput);

  // Batch-level idempotency: an Idempotency-Key header dedupes the whole batch
  // (same TTL-takeover/release semantics as withIdempotency on single creates).
  // Per-item `client_id` remains the safe-retry story for individual items.
  const payload = await withIdempotency(
    c.env.DB,
    auth.org_id,
    "message_batch",
    c.req.header("idempotency-key"),
    async () => {
      const provider = new CloudflareEmailProvider(c.env);
      const ctx: SendContext = {
        inbox_id: inbox.inbox_id,
        org_id: inbox.org_id,
        pod_id: inbox.pod_id,
        org_verified: auth.org_verified,
        human_email: auth.human_email
      };
      const results: Record<string, unknown>[] = [];
      for (const [index, item] of input.messages.entries()) {
        try {
          const sent = await sendMessage(c.env, provider, ctx, item);
          results.push({ index, ...sent });
        } catch (err) {
          if (err instanceof ApiError) {
            results.push({ index, error: err.toEnvelope() });
          } else {
            throw err;
          }
        }
      }
      return { results };
    }
  );
  deliverInBackground(c);
  return c.json(payload);
});

messages.post("/inboxes/:inbox_id/messages/batch-get", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const input = await parseBody(c, BatchGetMessagesInput);
  const rows = (
    await c.env.DB.prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM messages
       WHERE inbox_id = ? AND msg_id IN (${input.message_ids.map(() => "?").join(",")})`
    )
      .bind(inbox.inbox_id, ...input.message_ids)
      .all<MessageRow>()
  ).results;
  const atts = await attachmentsFor(c.env.DB, rows.map((r) => r.msg_id));
  return c.json({ messages: rows.map((r) => messageJson(r, atts.get(r.msg_id) ?? [])) });
});

messages.patch("/inboxes/:inbox_id/messages/batch-update", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const input = await parseBody(c, BatchUpdateMessagesInput);
  const rows = (
    await c.env.DB.prepare(
      `SELECT msg_id, labels FROM messages
       WHERE inbox_id = ? AND msg_id IN (${input.message_ids.map(() => "?").join(",")})`
    )
      .bind(inbox.inbox_id, ...input.message_ids)
      .all<{ msg_id: string; labels: string }>()
  ).results;
  const now = new Date().toISOString();
  const updates = rows.map((row) => {
    const next = applyLabelPatch(JSON.parse(row.labels) as string[], input);
    return c.env.DB.prepare(
      "UPDATE messages SET labels = ?, updated_at = ? WHERE msg_id = ?"
    ).bind(JSON.stringify(next), now, row.msg_id);
  });
  if (updates.length > 0) await c.env.DB.batch(updates);
  return c.json({ updated: rows.map((r) => r.msg_id) });
});

messages.get("/inboxes/:inbox_id/messages/:msg_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const row = await requireMessage(c, inbox, c.req.param("msg_id"));
  return c.json(await messageWithAttachments(c, row));
});

// Per-message event timeline (spec §4): every event emitted with this
// msg_id, chronological. Read-only view over the events table.
messages.get("/inboxes/:inbox_id/messages/:msg_id/events", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const row = await requireMessage(c, inbox, c.req.param("msg_id"));
  const events = (
    await c.env.DB.prepare(
      "SELECT payload FROM events WHERE msg_id = ? AND org_id = ? ORDER BY created_at, event_id"
    )
      .bind(row.msg_id, inbox.org_id)
      .all<{ payload: string }>()
  ).results;
  return c.json({ events: events.map((e) => JSON.parse(e.payload)) });
});

// Mint a share link (spec §4): snapshots the message's sanitized html/text
// under an unguessable id; GET /share/:share_id serves it without auth.
messages.post("/inboxes/:inbox_id/messages/:msg_id/share", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "send");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const row = await requireMessage(c, inbox, c.req.param("msg_id"));
  const input = await parseBody(c, ShareMessageInput);
  const shareId = newId("share");
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + input.expires_in * 1000).toISOString();
  const htmlSource = row.html ?? row.extracted_html;
  const htmlSnapshot = htmlSource ? shareDocumentHtml(htmlSource) : null;
  const textSnapshot = row.extracted_text ?? row.text;
  await c.env.DB.prepare(
    `INSERT INTO share_links (share_id, msg_id, org_id, html_snapshot, text_snapshot, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(shareId, row.msg_id, inbox.org_id, htmlSnapshot, textSnapshot, expiresAt, now)
    .run();
  return c.json(
    {
      share_id: shareId,
      share_url: `${new URL(c.req.url).origin}/v0/share/${shareId}`,
      message_id: row.msg_id,
      expires_at: expiresAt,
      created_at: now
    },
    201
  );
});

messages.get("/inboxes/:inbox_id/messages/:msg_id/raw", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const row = (await requireMessage(c, inbox, c.req.param("msg_id"))) as MessageRow & {
    raw_key: string | null;
  };
  if (!row.raw_key) throw new ApiError("not_found", "raw MIME is not stored for this message");
  const object = await c.env.MAIL.get(row.raw_key);
  if (!object) throw new ApiError("not_found", "raw MIME is not stored for this message");
  return new Response(object.body, {
    headers: { "Content-Type": "message/rfc822" }
  });
});

messages.get("/inboxes/:inbox_id/messages/:msg_id/attachments/:att_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const row = await requireMessage(c, inbox, c.req.param("msg_id"));
  const attId = c.req.param("att_id");
  const att = await c.env.DB.prepare(
    "SELECT att_id, filename, content_type FROM attachments WHERE att_id = ? AND msg_id = ?"
  )
    .bind(attId, row.msg_id)
    .first<{ att_id: string; filename: string; content_type: string }>();
  if (!att) throw new ApiError("not_found", "no such attachment");
  const object = await c.env.MAIL.get(`att/${inbox.inbox_id}/${row.msg_id}/${att.att_id}`);
  if (!object) throw new ApiError("not_found", "attachment content is not stored");
  // Mail readers need CID-backed raster image parts to render in place. Keep
  // every other attachment as a download: serving sender-provided HTML or SVG
  // inline would give it the API origin when opened in a browser.
  const mediaType = att.content_type.split(";", 1)[0]?.trim().toLowerCase();
  const inlineImageTypes = new Set([
    "image/avif",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp"
  ]);
  const disposition =
    c.req.query("disposition") === "inline" && inlineImageTypes.has(mediaType ?? "")
      ? "inline"
      : "attachment";
  return new Response(object.body, {
    headers: {
      "Content-Type": att.content_type,
      "Content-Disposition": `${disposition}; filename="${att.filename.replaceAll('"', "")}"`,
      "X-Content-Type-Options": "nosniff"
    }
  });
});

messages.patch("/inboxes/:inbox_id/messages/:msg_id", async (c) => {
  const auth = await authenticate(c);
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const row = await requireMessage(c, inbox, c.req.param("msg_id"));
  const input = await parseBody(c, UpdateMessageInput);
  // Rescheduling is a send-lifecycle op (spec §4: the `send` scope); label and
  // read edits are mailbox administration and still need `admin`.
  const touchesLabels =
    input.labels !== undefined ||
    input.add_labels !== undefined ||
    input.remove_labels !== undefined ||
    input.read !== undefined;
  requirePermission(auth, touchesLabels ? "admin" : "send");
  const next = applyLabelPatch(JSON.parse(row.labels) as string[], input);
  const now = new Date().toISOString();

  let nextState = row.state;
  let sendAt = row.send_at;
  if (input.send_at !== undefined) {
    if (row.deleted_at || (row.state !== "scheduled" && row.state !== "cancelled")) {
      throw new ApiError("conflict", "only scheduled or cancelled messages can be rescheduled");
    }
    const when = new Date(input.send_at);
    if (when.getTime() <= Date.now()) {
      throw new ApiError("validation_error", "send_at must be in the future");
    }
    sendAt = when.toISOString();
    nextState = "scheduled";
  }

  await c.env.DB.prepare(
    "UPDATE messages SET labels = ?, state = ?, send_at = ?, updated_at = ? WHERE msg_id = ?"
  )
    .bind(JSON.stringify(next), nextState, sendAt, now, row.msg_id)
    .run();

  if (sendAt !== row.send_at) {
    await emitEvent(c.env.DB, {
      type: "message.scheduled",
      org_id: row.org_id,
      pod_id: row.pod_id,
      inbox_id: row.inbox_id,
      msg_id: row.msg_id,
      data: {
        message: { message_id: row.msg_id, inbox_id: row.inbox_id, thread_id: row.thread_id },
        send_at: sendAt
      }
    });
  }
  return c.json(
    await messageWithAttachments(c, {
      ...row,
      labels: JSON.stringify(next),
      state: nextState,
      send_at: sendAt,
      updated_at: now
    })
  );
});

// Cancels a scheduled send without trashing the message (Resend parity).
// Trashing still cancels too; `cancelled` is the explicit, restorable state.
messages.post("/inboxes/:inbox_id/messages/:msg_id/cancel", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "send");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const row = await requireMessage(c, inbox, c.req.param("msg_id"));
  if (row.deleted_at || row.state !== "scheduled") {
    throw new ApiError("conflict", "only scheduled messages can be cancelled");
  }
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE messages SET state = 'cancelled', updated_at = ? WHERE msg_id = ?"
  )
    .bind(now, row.msg_id)
    .run();
  await emitEvent(c.env.DB, {
    type: "message.cancelled",
    org_id: row.org_id,
    pod_id: row.pod_id,
    inbox_id: row.inbox_id,
    msg_id: row.msg_id,
    data: {
      message: { message_id: row.msg_id, inbox_id: row.inbox_id, thread_id: row.thread_id }
    }
  });
  return c.json(await messageWithAttachments(c, { ...row, state: "cancelled", updated_at: now }));
});

messages.get("/inboxes/:inbox_id/messages/:msg_id/attachments", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const row = await requireMessage(c, inbox, c.req.param("msg_id"));
  const atts = await attachmentsFor(c.env.DB, [row.msg_id]);
  return c.json({
    attachments: (atts.get(row.msg_id) ?? []).map((a) => ({
      attachment_id: a.att_id,
      filename: a.filename,
      content_type: a.content_type,
      size: a.size,
      content_id: a.content_id
    }))
  });
});

// Moves the message to trash (soft delete). Trashing a scheduled message
// cancels its delivery. A cron purge removes trashed rows after 30 days.
messages.delete("/inboxes/:inbox_id/messages/:msg_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const row = await requireMessage(c, inbox, c.req.param("msg_id"));
  if (!row.deleted_at) {
    const now = new Date().toISOString();
    await c.env.DB.prepare(
      "UPDATE messages SET deleted_at = ?, updated_at = ? WHERE msg_id = ?"
    )
      .bind(now, now, row.msg_id)
      .run();
  }
  return c.body(null, 204);
});

messages.post("/inboxes/:inbox_id/messages/:msg_id/restore", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const row = await requireMessage(c, inbox, c.req.param("msg_id"));
  if (row.deleted_at) {
    const now = new Date().toISOString();
    await c.env.DB.prepare(
      "UPDATE messages SET deleted_at = NULL, updated_at = ? WHERE msg_id = ?"
    )
      .bind(now, row.msg_id)
      .run();
    row.deleted_at = null;
    row.updated_at = now;
  }
  return c.json(await messageWithAttachments(c, row));
});

async function sendFromInbox(
  c: Context<{ Bindings: Env }>,
  auth: AuthedKey,
  inbox: InboxRow,
  input: SendMessageInput
): Promise<Response> {
  // AgentMail-compatible header idempotency: an Idempotency-Key header acts
  // as the send client_id when the body doesn't provide one.
  const headerKey = c.req.header("idempotency-key");
  if (input.client_id === undefined && headerKey) {
    input = { ...input, client_id: headerKey };
  }
  const ctx: SendContext = {
    inbox_id: inbox.inbox_id,
    org_id: inbox.org_id,
    pod_id: inbox.pod_id,
    org_verified: auth.org_verified,
    human_email: auth.human_email
  };
  const provider = new CloudflareEmailProvider(c.env);
  const result = await sendMessage(c.env, provider, ctx, input);
  deliverInBackground(c);
  return c.json(result, 200);
}

/** Kick pending webhook deliveries after the response; tests have no
 * ExecutionContext, so fall back to letting the sweep pick them up. */
function deliverInBackground(c: Context<{ Bindings: Env }>): void {
  try {
    c.executionCtx.waitUntil(processDueDeliveries(c.env));
  } catch {
    // no ExecutionContext (unit tests): the scheduled sweep delivers instead
  }
}

messages.post("/inboxes/:inbox_id/messages/send", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "send");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const input = await parseBody(c, SendMessageInput);
  return sendFromInbox(c, auth, inbox, input);
});

function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}

function quoteHistory(source: MessageRow): string {
  const body = source.extracted_text ?? source.text ?? "";
  const quoted = body
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  return `\n\nOn ${source.created_at}, ${source.from_addr} wrote:\n${quoted}`;
}

function replyHeaders(
  source: MessageRow,
  extra: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!source.rfc822_message_id) return extra;
  return {
    ...(extra ?? {}),
    "In-Reply-To": source.rfc822_message_id,
    References: source.rfc822_message_id
  };
}

messages.post("/inboxes/:inbox_id/messages/:msg_id/reply", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "send");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const source = await requireMessage(c, inbox, c.req.param("msg_id"));
  const input = await parseBody(c, ReplyMessageInput);
  const to =
    input.to ??
    (source.direction === "inbound"
      ? [source.from_addr]
      : (JSON.parse(source.to_addrs) as string[]));
  return sendFromInbox(c, auth, inbox, {
    ...input,
    to,
    cc: input.cc,
    subject: replySubject(source.subject),
    text: (input.text ?? "") + quoteHistory(source),
    headers: replyHeaders(source, input.headers)
  });
});

messages.post("/inboxes/:inbox_id/messages/:msg_id/reply-all", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "send");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const source = await requireMessage(c, inbox, c.req.param("msg_id"));
  const input = await parseBody(c, ReplyMessageInput);
  const self = inbox.inbox_id.toLowerCase();
  const participants = [
    source.from_addr,
    ...(JSON.parse(source.to_addrs) as string[]),
    ...(JSON.parse(source.cc_addrs) as string[])
  ]
    .map((a) => a.toLowerCase())
    .filter((a) => a !== self);
  const to = input.to ?? [...new Set(participants)];
  if (to.length === 0) throw new ApiError("validation_error", "no recipients to reply to");
  return sendFromInbox(c, auth, inbox, {
    ...input,
    to,
    subject: replySubject(source.subject),
    text: (input.text ?? "") + quoteHistory(source),
    headers: replyHeaders(source, input.headers)
  });
});

messages.post("/inboxes/:inbox_id/messages/:msg_id/forward", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "send");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const source = await requireMessage(c, inbox, c.req.param("msg_id"));
  const input = await parseBody(c, ForwardMessageInput);
  const subject = /^fwd?:/i.test(source.subject.trim())
    ? source.subject
    : `Fwd: ${source.subject}`;
  const history = `\n\n---------- Forwarded message ----------\nFrom: ${source.from_addr}\nDate: ${source.created_at}\nSubject: ${source.subject}\n\n${source.text ?? source.extracted_text ?? ""}`;
  return sendFromInbox(c, auth, inbox, {
    ...input,
    subject,
    text: (input.text ?? "") + history
  });
});
