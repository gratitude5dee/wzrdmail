import { Hono } from "hono";
import { authenticate, requirePermission } from "../auth.js";
import type { Env } from "../env.js";
import { requireInbox } from "../lib/http.js";

export const counts = new Hono<{ Bindings: Env }>();

/**
 * Folder badge counts for an inbox (airv2 inbox mini-app):
 * `unread` = live messages carrying the `unread` label, `spam` = live
 * `spam`-labeled threads, `drafts` = draft rows, `trash` = trashed threads.
 */
counts.get("/inboxes/:inbox_id/counts", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const row = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM messages WHERE inbox_id = ? AND deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM json_each(messages.labels) WHERE json_each.value = 'unread')) AS unread,
       (SELECT COUNT(*) FROM threads WHERE inbox_id = ? AND deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM json_each(threads.labels) WHERE json_each.value = 'spam')) AS spam,
       (SELECT COUNT(*) FROM drafts WHERE inbox_id = ?) AS drafts,
       (SELECT COUNT(*) FROM threads WHERE inbox_id = ? AND deleted_at IS NOT NULL) AS trash`
  )
    .bind(inbox.inbox_id, inbox.inbox_id, inbox.inbox_id, inbox.inbox_id)
    .first<{ unread: number; spam: number; drafts: number; trash: number }>();
  return c.json({
    unread: row?.unread ?? 0,
    spam: row?.spam ?? 0,
    drafts: row?.drafts ?? 0,
    trash: row?.trash ?? 0
  });
});
