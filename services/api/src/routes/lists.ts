import { ApiError, CreateListEntryInput, ListKind, newId } from "@wzrdmail/core";
import { Hono } from "hono";
import { authenticate, requirePermission } from "../auth.js";
import type { Env } from "../env.js";
import { collection, parseBody, parsePagination, requireInbox, withIdempotency } from "../lib/http.js";
import { listEntryJson, type ListEntryRow } from "../lib/serialize.js";

export const lists = new Hono<{ Bindings: Env }>();

const LIST_COLUMNS = "entry_id, org_id, inbox_id, kind, pattern, created_at";

lists.get("/lists", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  const { limit, cursor } = parsePagination(c);
  const conditions = ["org_id = ?"];
  const binds: string[] = [auth.org_id];
  const kind = c.req.query("kind");
  if (kind !== undefined) {
    if (!ListKind.safeParse(kind).success) {
      throw new ApiError("validation_error", "kind must be 'allow' or 'block'");
    }
    conditions.push("kind = ?");
    binds.push(kind);
  }
  const inboxId = c.req.query("inbox_id");
  if (inboxId !== undefined) {
    const inbox = await requireInbox(c, auth, inboxId);
    conditions.push("inbox_id = ?");
    binds.push(inbox.inbox_id);
  }
  if (cursor) {
    conditions.push("(created_at > ? OR (created_at = ? AND entry_id > ?))");
    binds.push(cursor.v, cursor.v, cursor.id);
  }
  const rows = (
    await c.env.DB.prepare(
      `SELECT ${LIST_COLUMNS} FROM list_entries WHERE ${conditions.join(" AND ")}
       ORDER BY created_at, entry_id LIMIT ?`
    )
      .bind(...binds, limit + 1)
      .all<ListEntryRow>()
  ).results;
  const page = collection(rows, limit, (r) => ({ v: r.created_at, id: r.entry_id }));
  return c.json({
    list_entries: page.items.map((r) => listEntryJson(r)),
    next_page_token: page.next_page_token ?? null
  });
});

lists.post("/lists", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  const input = await parseBody(c, CreateListEntryInput);
  const inboxId =
    input.inbox_id === undefined
      ? null
      : (await requireInbox(c, auth, input.inbox_id)).inbox_id;
  const result = await withIdempotency(
    c.env.DB,
    auth.org_id,
    "list_entry",
    input.client_id,
    async () => {
      const row: ListEntryRow = {
        entry_id: newId("lst"),
        org_id: auth.org_id,
        inbox_id: inboxId,
        kind: input.kind,
        pattern: input.pattern,
        created_at: new Date().toISOString()
      };
      const inserted = await c.env.DB.prepare(
        `INSERT INTO list_entries (entry_id, org_id, inbox_id, kind, pattern, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (org_id, COALESCE(inbox_id, ''), kind, pattern) DO NOTHING`
      )
        .bind(row.entry_id, row.org_id, row.inbox_id, row.kind, row.pattern, row.created_at)
        .run();
      if (inserted.meta.changes === 0) {
        throw new ApiError("conflict", "an identical list entry already exists");
      }
      return listEntryJson(row);
    }
  );
  return c.json(result, 201);
});

lists.delete("/lists/:entry_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  const deleted = await c.env.DB.prepare(
    "DELETE FROM list_entries WHERE entry_id = ? AND org_id = ?"
  )
    .bind(c.req.param("entry_id"), auth.org_id)
    .run();
  if (deleted.meta.changes === 0) {
    throw new ApiError("not_found", "no such list entry");
  }
  return c.body(null, 204);
});
