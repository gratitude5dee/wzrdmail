import {
  ApiError,
  BatchGetMessagesInput,
  BatchUpdateMessagesInput,
  ForwardMessageInput,
  ReplyMessageInput,
  SendMessageInput,
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
  type InboxRow
} from "../lib/http.js";
import { processDueDeliveries } from "../lib/webhook-delivery.js";
import {
  applyLabelPatch,
  messageJson,
  type AttachmentRow,
  type MessageRow
} from "../lib/serialize.js";

export const messages = new Hono<{ Bindings: Env }>();

const MESSAGE_COLUMNS =
  "msg_id, org_id, pod_id, inbox_id, thread_id, direction, state, from_addr, to_addrs, cc_addrs, bcc_addrs, subject, text, html, extracted_text, extracted_html, labels, rfc822_message_id, in_reply_to, send_at, deleted_at, created_at, updated_at";

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
  return new Response(object.body, {
    headers: {
      "Content-Type": att.content_type,
      "Content-Disposition": `attachment; filename="${att.filename.replaceAll('"', "")}"`
    }
  });
});

messages.patch("/inboxes/:inbox_id/messages/:msg_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const row = await requireMessage(c, inbox, c.req.param("msg_id"));
  const input = await parseBody(c, UpdateMessageInput);
  const next = applyLabelPatch(JSON.parse(row.labels) as string[], input);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE messages SET labels = ?, updated_at = ? WHERE msg_id = ?"
  )
    .bind(JSON.stringify(next), now, row.msg_id)
    .run();
  return c.json(
    await messageWithAttachments(c, { ...row, labels: JSON.stringify(next), updated_at: now })
  );
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
