import { ApiError, UpdateThreadInput } from "@wzrdmail/core";
import { Hono } from "hono";
import type { Context } from "hono";
import { authenticate, requirePermission, type AuthedKey } from "../auth.js";
import type { Env } from "../env.js";
import {
  collection,
  parseBody,
  parsePagination,
  requireInbox,
  type PageCursor
} from "../lib/http.js";
import {
  applyLabelPatch,
  messageJson,
  threadJson,
  type AttachmentRow,
  type MessageRow,
  type ThreadRow
} from "../lib/serialize.js";

export const threads = new Hono<{ Bindings: Env }>();

const THREAD_COLUMNS =
  "thread_id, org_id, pod_id, inbox_id, subject, preview, participants, labels, message_count, deleted_at, last_message_at, created_at, updated_at";

const MESSAGE_COLUMNS =
  "msg_id, org_id, pod_id, inbox_id, thread_id, direction, state, from_addr, to_addrs, cc_addrs, bcc_addrs, subject, text, html, extracted_text, extracted_html, labels, rfc822_message_id, in_reply_to, send_at, deleted_at, created_at, updated_at";

/** `folder` query param: default hides trash; `trash` shows only trashed rows. */
function folderCondition(c: Context<{ Bindings: Env }>): string {
  const folder = c.req.query("folder") ?? "";
  if (folder === "trash") return "deleted_at IS NOT NULL";
  if (folder === "" || folder === "all") return "deleted_at IS NULL";
  throw new ApiError("validation_error", "folder must be one of: all, trash");
}

interface Scope {
  /** Restrict to one inbox (inbox-scoped routes) or the whole key scope. */
  inboxId?: string;
}

async function listThreads(
  c: Context<{ Bindings: Env }>,
  auth: AuthedKey,
  scope: Scope,
  search: string | null
): Promise<Response> {
  const { limit, cursor } = parsePagination(c);
  const conditions = ["org_id = ?", folderCondition(c)];
  const binds: string[] = [auth.org_id];
  if (scope.inboxId) {
    conditions.push("inbox_id = ?");
    binds.push(scope.inboxId);
  } else if (auth.pod_id) {
    conditions.push("pod_id = ?");
    binds.push(auth.pod_id);
  }
  if (search !== null) {
    if (search === "") throw new ApiError("validation_error", "query is required");
    const like = `%${search.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    conditions.push("(subject LIKE ? ESCAPE '\\' OR preview LIKE ? ESCAPE '\\')");
    binds.push(like, like);
  }
  if (cursor) {
    conditions.push("(last_message_at < ? OR (last_message_at = ? AND thread_id < ?))");
    binds.push(cursor.v, cursor.v, cursor.id);
  }
  const rows = (
    await c.env.DB.prepare(
      `SELECT ${THREAD_COLUMNS} FROM threads WHERE ${conditions.join(" AND ")}
       ORDER BY last_message_at DESC, thread_id DESC LIMIT ?`
    )
      .bind(...binds, limit + 1)
      .all<ThreadRow>()
  ).results;
  const page = collection(rows, limit, (r): PageCursor => ({ v: r.last_message_at, id: r.thread_id }));
  return c.json({
    threads: page.items.map(threadJson),
    next_page_token: page.next_page_token ?? null
  });
}

async function requireThread(
  c: Context<{ Bindings: Env }>,
  auth: AuthedKey,
  threadId: string,
  inboxId?: string
): Promise<ThreadRow> {
  const row = await c.env.DB.prepare(
    `SELECT ${THREAD_COLUMNS} FROM threads WHERE thread_id = ?`
  )
    .bind(threadId)
    .first<ThreadRow>();
  if (
    !row ||
    row.org_id !== auth.org_id ||
    (inboxId !== undefined && row.inbox_id !== inboxId)
  ) {
    throw new ApiError("not_found", "no such thread");
  }
  if (auth.pod_id && auth.pod_id !== row.pod_id) {
    throw new ApiError("forbidden", "key is scoped to a different pod");
  }
  return row;
}

async function threadDetail(
  c: Context<{ Bindings: Env }>,
  thread: ThreadRow
): Promise<Response> {
  const msgs = (
    await c.env.DB.prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE thread_id = ? AND deleted_at IS NULL
       ORDER BY created_at, msg_id`
    )
      .bind(thread.thread_id)
      .all<MessageRow>()
  ).results;
  const attRows =
    msgs.length === 0
      ? []
      : (
          await c.env.DB.prepare(
            `SELECT att_id, msg_id, filename, content_type, size, content_id
             FROM attachments WHERE msg_id IN (${msgs.map(() => "?").join(",")})`
          )
            .bind(...msgs.map((m) => m.msg_id))
            .all<AttachmentRow>()
        ).results;
  const byMsg = new Map<string, AttachmentRow[]>();
  for (const att of attRows) {
    const list = byMsg.get(att.msg_id) ?? [];
    list.push(att);
    byMsg.set(att.msg_id, list);
  }
  return c.json({
    ...threadJson(thread),
    messages: msgs.map((m) => messageJson(m, byMsg.get(m.msg_id) ?? []))
  });
}

// Inbox-scoped
threads.get("/inboxes/:inbox_id/threads", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  return listThreads(c, auth, { inboxId: inbox.inbox_id }, null);
});

threads.get("/inboxes/:inbox_id/threads/search", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  return listThreads(c, auth, { inboxId: inbox.inbox_id }, c.req.query("query") ?? "");
});

threads.get("/inboxes/:inbox_id/threads/:thread_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const thread = await requireThread(c, auth, c.req.param("thread_id"), inbox.inbox_id);
  return threadDetail(c, thread);
});

threads.patch("/inboxes/:inbox_id/threads/:thread_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const thread = await requireThread(c, auth, c.req.param("thread_id"), inbox.inbox_id);
  const input = await parseBody(c, UpdateThreadInput);
  const next = applyLabelPatch(JSON.parse(thread.labels) as string[], input);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE threads SET labels = ?, updated_at = ? WHERE thread_id = ?"
  )
    .bind(JSON.stringify(next), now, thread.thread_id)
    .run();
  return c.json(threadJson({ ...thread, labels: JSON.stringify(next), updated_at: now }));
});

// Moves the thread and its messages to trash (soft delete). A cron purge
// removes trashed rows after 30 days.
threads.delete("/inboxes/:inbox_id/threads/:thread_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const thread = await requireThread(c, auth, c.req.param("thread_id"), inbox.inbox_id);
  if (!thread.deleted_at) {
    const now = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE threads SET deleted_at = ?, updated_at = ? WHERE thread_id = ?"
      ).bind(now, now, thread.thread_id),
      c.env.DB.prepare(
        "UPDATE messages SET deleted_at = ?, updated_at = ? WHERE thread_id = ? AND deleted_at IS NULL"
      ).bind(now, now, thread.thread_id)
    ]);
  }
  return c.body(null, 204);
});

threads.post("/inboxes/:inbox_id/threads/:thread_id/restore", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const thread = await requireThread(c, auth, c.req.param("thread_id"), inbox.inbox_id);
  if (thread.deleted_at) {
    const now = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE threads SET deleted_at = NULL, updated_at = ? WHERE thread_id = ?"
      ).bind(now, thread.thread_id),
      c.env.DB.prepare(
        "UPDATE messages SET deleted_at = NULL, updated_at = ? WHERE thread_id = ? AND deleted_at = ?"
      ).bind(now, thread.thread_id, thread.deleted_at)
    ]);
    thread.deleted_at = null;
    thread.updated_at = now;
  }
  return c.json(threadJson(thread));
});

// Org-wide
threads.get("/threads", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  return listThreads(c, auth, {}, null);
});

threads.get("/threads/search", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  return listThreads(c, auth, {}, c.req.query("query") ?? "");
});

threads.get("/threads/:thread_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  const thread = await requireThread(c, auth, c.req.param("thread_id"));
  return threadDetail(c, thread);
});
