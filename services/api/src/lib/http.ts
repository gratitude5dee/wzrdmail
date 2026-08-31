import { ApiError, Pagination } from "@wzrdmail/core";
import type { Context } from "hono";
import type { z } from "zod";
import type { AuthedKey } from "../auth.js";
import type { Env } from "../env.js";

export async function parseBody<T extends z.ZodTypeAny>(
  c: Context<{ Bindings: Env }>,
  schema: T
): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError("validation_error", "request body must be JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") ?? "";
    throw new ApiError(
      "validation_error",
      path ? `${path}: ${issue?.message ?? "invalid"}` : issue?.message ?? "invalid body"
    );
  }
  return parsed.data as z.infer<T>;
}

export interface PageCursor {
  /** Sort-column value (ISO timestamp) of the last item on the previous page. */
  v: string;
  /** Tie-breaking primary key of the last item on the previous page. */
  id: string;
}

/** Pagination per §7: `limit` (default 20, max 100) + opaque `page_token`. */
export function parsePagination(c: Context<{ Bindings: Env }>): {
  limit: number;
  cursor: PageCursor | null;
} {
  const parsed = Pagination.safeParse({
    limit: c.req.query("limit") ?? undefined,
    page_token: c.req.query("page_token") ?? undefined
  });
  if (!parsed.success) {
    throw new ApiError("validation_error", "invalid limit or page_token");
  }
  let cursor: PageCursor | null = null;
  if (parsed.data.page_token) {
    try {
      const decoded = JSON.parse(atob(parsed.data.page_token)) as PageCursor;
      if (typeof decoded.v !== "string" || typeof decoded.id !== "string") {
        throw new Error("bad token");
      }
      cursor = decoded;
    } catch {
      throw new ApiError("validation_error", "invalid page_token");
    }
  }
  return { limit: parsed.data.limit, cursor };
}

export function pageToken(cursor: PageCursor): string {
  return btoa(JSON.stringify(cursor));
}

/**
 * Collection envelope: fetch `limit + 1` rows, pass them here, and the extra
 * row becomes the `next_page_token` cursor.
 */
export function collection<T>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => PageCursor
): { items: T[]; next_page_token?: string } {
  if (rows.length <= limit) return { items: rows };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return last === undefined
    ? { items }
    : { items, next_page_token: pageToken(cursorOf(last)) };
}

export interface InboxRow {
  inbox_id: string;
  org_id: string;
  pod_id: string;
  username: string;
  domain: string;
  display_name: string | null;
  client_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Load an inbox and enforce org + pod scoping; foreign inboxes 404 (§7). */
export async function requireInbox(
  c: Context<{ Bindings: Env }>,
  auth: AuthedKey,
  rawInboxId: string
): Promise<InboxRow> {
  const inboxId = decodeURIComponent(rawInboxId).toLowerCase();
  const inbox = await c.env.DB.prepare(
    `SELECT inbox_id, org_id, pod_id, username, domain, display_name, client_id, created_at, updated_at
     FROM inboxes WHERE inbox_id = ? AND deleted_at IS NULL`
  )
    .bind(inboxId)
    .first<InboxRow>();
  if (!inbox || inbox.org_id !== auth.org_id) {
    throw new ApiError("not_found", "no such inbox");
  }
  if (auth.pod_id && auth.pod_id !== inbox.pod_id) {
    throw new ApiError("forbidden", "key is scoped to a different pod");
  }
  return inbox;
}

/** An in-flight reservation older than this is presumed dead and can be retried. */
const RESERVATION_TTL_MS = 10 * 60 * 1000;

/**
 * client_id replay for cheap create endpoints (§7): first writer wins the
 * reservation, finishes the create, and stores the response; replays return
 * the stored response verbatim. Stale empty reservations (an interrupted
 * create) can be taken over by exactly one retry via the owner token.
 */
export async function withIdempotency<T>(
  db: D1Database,
  orgId: string,
  resourceType: string,
  clientId: string | undefined,
  create: () => Promise<T>
): Promise<T> {
  if (!clientId) return create();
  const owner = crypto.randomUUID();
  const reserved = await db
    .prepare(
      `INSERT INTO idempotency_keys (org_id, resource_type, client_id, response, created_at, owner)
       VALUES (?, ?, ?, '', ?, ?) ON CONFLICT DO NOTHING`
    )
    .bind(orgId, resourceType, clientId, new Date().toISOString(), owner)
    .run();
  if (reserved.meta.changes === 0) {
    const replay = await db
      .prepare(
        "SELECT response, created_at, owner FROM idempotency_keys WHERE org_id = ? AND resource_type = ? AND client_id = ?"
      )
      .bind(orgId, resourceType, clientId)
      .first<{ response: string; created_at: string; owner: string }>();
    if (replay && replay.response !== "") return JSON.parse(replay.response) as T;
    const age = replay ? Date.now() - new Date(replay.created_at).getTime() : 0;
    if (!replay || age <= RESERVATION_TTL_MS) {
      throw new ApiError("conflict", "a request with this client_id is already in flight");
    }
    const takeover = await db
      .prepare(
        `UPDATE idempotency_keys SET created_at = ?, owner = ?
         WHERE org_id = ? AND resource_type = ? AND client_id = ?
           AND response = '' AND owner = ?`
      )
      .bind(new Date().toISOString(), owner, orgId, resourceType, clientId, replay.owner)
      .run();
    if (takeover.meta.changes === 0) {
      throw new ApiError("conflict", "a request with this client_id is already in flight");
    }
  }
  try {
    const result = await create();
    await db
      .prepare(
        "UPDATE idempotency_keys SET response = ? WHERE org_id = ? AND resource_type = ? AND client_id = ? AND owner = ?"
      )
      .bind(JSON.stringify(result), orgId, resourceType, clientId, owner)
      .run();
    return result;
  } catch (err) {
    await db
      .prepare(
        "DELETE FROM idempotency_keys WHERE org_id = ? AND resource_type = ? AND client_id = ? AND response = '' AND owner = ?"
      )
      .bind(orgId, resourceType, clientId, owner)
      .run();
    throw err;
  }
}
