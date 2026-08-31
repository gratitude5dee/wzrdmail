import { ApiError, CreateListEntryInput, ListKind, newId } from "@wzrdmail/core";
import { Hono } from "hono";
import type { Context } from "hono";
import { authenticate, requirePermission, type AuthedKey } from "../auth.js";
import type { Env } from "../env.js";
import { collection, parseBody, parsePagination, requireInbox, withIdempotency } from "../lib/http.js";
import { listEntryJson, type ListEntryRow } from "../lib/serialize.js";

export const lists = new Hono<{ Bindings: Env }>();

const LIST_COLUMNS = "entry_id, org_id, inbox_id, kind, pattern, created_at";

/** Org-wide entries gate delivery for every pod, so pod keys may not write them. */
function requireOrgScopeForOrgWide(auth: AuthedKey): void {
  if (auth.pod_id) {
    throw new ApiError(
      "forbidden",
      "organization-wide list entries require an organization-scoped key"
    );
  }
}

async function requireEntry(
  c: Context<{ Bindings: Env }>,
  auth: AuthedKey,
  entryId: string,
  inboxId?: string
): Promise<ListEntryRow> {
  const row = await c.env.DB.prepare(
    `SELECT e.entry_id, e.org_id, e.inbox_id, e.kind, e.pattern, e.created_at,
            i.pod_id AS inbox_pod_id
     FROM list_entries e LEFT JOIN inboxes i ON i.inbox_id = e.inbox_id
     WHERE e.entry_id = ?`
  )
    .bind(entryId)
    .first<ListEntryRow & { inbox_pod_id: string | null }>();
  if (
    !row ||
    row.org_id !== auth.org_id ||
    (inboxId !== undefined && row.inbox_id !== inboxId)
  ) {
    throw new ApiError("not_found", "no such list entry");
  }
  if (auth.pod_id && row.inbox_id !== null && row.inbox_pod_id !== auth.pod_id) {
    throw new ApiError("forbidden", "key is scoped to a different pod");
  }
  return row;
}

async function listEntries(
  c: Context<{ Bindings: Env }>,
  auth: AuthedKey,
  forcedInboxId?: string
): Promise<Response> {
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
  const inboxId = forcedInboxId ?? c.req.query("inbox_id");
  if (inboxId !== undefined) {
    const inbox = await requireInbox(c, auth, inboxId);
    conditions.push("inbox_id = ?");
    binds.push(inbox.inbox_id);
  } else if (auth.pod_id) {
    conditions.push(
      "(inbox_id IS NULL OR inbox_id IN (SELECT inbox_id FROM inboxes WHERE pod_id = ?))"
    );
    binds.push(auth.pod_id);
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
}

async function createEntry(
  c: Context<{ Bindings: Env }>,
  auth: AuthedKey,
  forcedInboxId?: string
): Promise<Response> {
  const input = await parseBody(c, CreateListEntryInput);
  const requestedInboxId = forcedInboxId ?? input.inbox_id;
  let inboxId: string | null;
  if (requestedInboxId === undefined) {
    requireOrgScopeForOrgWide(auth);
    inboxId = null;
  } else {
    inboxId = (await requireInbox(c, auth, requestedInboxId)).inbox_id;
  }
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
}

async function deleteEntry(
  c: Context<{ Bindings: Env }>,
  auth: AuthedKey,
  entryId: string,
  inboxId?: string
): Promise<Response> {
  const row = await requireEntry(c, auth, entryId, inboxId);
  if (row.inbox_id === null) requireOrgScopeForOrgWide(auth);
  await c.env.DB.prepare("DELETE FROM list_entries WHERE entry_id = ? AND org_id = ?")
    .bind(row.entry_id, auth.org_id)
    .run();
  return c.body(null, 204);
}

// Org-wide
lists.get("/lists", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  return listEntries(c, auth);
});

lists.post("/lists", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  return createEntry(c, auth);
});

lists.get("/lists/:entry_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  const row = await requireEntry(c, auth, c.req.param("entry_id"));
  return c.json(listEntryJson(row));
});

lists.delete("/lists/:entry_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  return deleteEntry(c, auth, c.req.param("entry_id"));
});

// Inbox-scoped mirrors
lists.get("/inboxes/:inbox_id/lists", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  return listEntries(c, auth, inbox.inbox_id);
});

lists.post("/inboxes/:inbox_id/lists", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  return createEntry(c, auth, inbox.inbox_id);
});

lists.get("/inboxes/:inbox_id/lists/:entry_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const row = await requireEntry(c, auth, c.req.param("entry_id"), inbox.inbox_id);
  return c.json(listEntryJson(row));
});

lists.delete("/inboxes/:inbox_id/lists/:entry_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  return deleteEntry(c, auth, c.req.param("entry_id"), inbox.inbox_id);
});
