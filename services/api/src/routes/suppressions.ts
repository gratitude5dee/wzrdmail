import {
  ApiError,
  BatchSuppressionInput,
  CreateSuppressionInput,
  SuppressionReason
} from "@wzrdmail/core";
import { Hono } from "hono";
import { authenticate, requirePermission, type AuthedKey } from "../auth.js";
import type { Env } from "../env.js";
import { emitEvent } from "../lib/events.js";
import { collection, parseBody, parsePagination, withIdempotency } from "../lib/http.js";

export const suppressions = new Hono<{ Bindings: Env }>();

interface SuppressionRow {
  org_id: string | null;
  address: string;
  reason: SuppressionReason;
  source_msg_id: string | null;
  created_at: string;
}

function suppressionJson(row: SuppressionRow): Record<string, unknown> {
  return {
    address: row.address,
    reason: row.reason,
    source_msg_id: row.source_msg_id,
    created_at: row.created_at
  };
}

/** Suppressions gate delivery org-wide, so pod/inbox-scoped keys may not write them. */
function requireOrgScope(auth: AuthedKey): void {
  if (auth.pod_id || auth.inbox_id) {
    throw new ApiError("forbidden", "suppressions require an organization-scoped key");
  }
}

/**
 * Events need a pod_id (column is NOT NULL); org-level resources borrow the
 * org's first pod, same as domain.verified.
 */
async function orgEventPodId(db: D1Database, orgId: string): Promise<string | null> {
  const pod = await db
    .prepare("SELECT pod_id FROM pods WHERE org_id = ? ORDER BY created_at LIMIT 1")
    .bind(orgId)
    .first<{ pod_id: string }>();
  return pod?.pod_id ?? null;
}

async function emitSuppressionEvent(
  db: D1Database,
  orgId: string,
  type: "suppression.added" | "suppression.removed",
  data: { address: string; reason: string; source_msg_id: string | null }
): Promise<void> {
  const podId = await orgEventPodId(db, orgId);
  if (!podId) return;
  await emitEvent(db, {
    type,
    org_id: orgId,
    pod_id: podId,
    ...(data.source_msg_id ? { msg_id: data.source_msg_id } : {}),
    data: {
      address: data.address,
      reason: data.reason,
      source_msg_id: data.source_msg_id
    }
  });
}

async function insertSuppression(
  db: D1Database,
  orgId: string,
  address: string,
  reason: SuppressionReason = "manual"
): Promise<SuppressionRow | null> {
  const now = new Date().toISOString();
  const inserted = await db
    .prepare(
      `INSERT INTO suppressions (org_id, address, reason, source_msg_id, created_at)
       VALUES (?, ?, ?, NULL, ?)
       ON CONFLICT (COALESCE(org_id, ''), address) DO NOTHING`
    )
    .bind(orgId, address, reason, now)
    .run();
  if (inserted.meta.changes === 0) return null;
  return { org_id: orgId, address, reason, source_msg_id: null, created_at: now };
}

async function deleteSuppression(
  db: D1Database,
  orgId: string,
  address: string
): Promise<SuppressionRow | null> {
  const row = await db
    .prepare(
      "SELECT org_id, address, reason, source_msg_id, created_at FROM suppressions WHERE org_id = ? AND address = ?"
    )
    .bind(orgId, address)
    .first<SuppressionRow>();
  if (!row) return null;
  await db
    .prepare("DELETE FROM suppressions WHERE org_id = ? AND address = ?")
    .bind(orgId, address)
    .run();
  return row;
}

suppressions.get("/suppressions", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  const { limit, cursor } = parsePagination(c);
  const conditions = ["org_id = ?"];
  const binds: string[] = [auth.org_id];
  const reason = c.req.query("reason");
  if (reason !== undefined) {
    if (!SuppressionReason.safeParse(reason).success) {
      throw new ApiError("validation_error", "reason must be one of: bounce, complaint, manual");
    }
    conditions.push("reason = ?");
    binds.push(reason);
  }
  const address = c.req.query("address");
  if (address !== undefined) {
    conditions.push("address = ?");
    binds.push(address.trim().toLowerCase());
  }
  if (cursor) {
    conditions.push("(created_at > ? OR (created_at = ? AND address > ?))");
    binds.push(cursor.v, cursor.v, cursor.id);
  }
  const rows = (
    await c.env.DB.prepare(
      `SELECT org_id, address, reason, source_msg_id, created_at FROM suppressions
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at, address LIMIT ?`
    )
      .bind(...binds, limit + 1)
      .all<SuppressionRow>()
  ).results;
  const page = collection(rows, limit, (r) => ({ v: r.created_at, id: r.address }));
  return c.json({
    suppressions: page.items.map(suppressionJson),
    next_page_token: page.next_page_token ?? null
  });
});

suppressions.post("/suppressions", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  requireOrgScope(auth);
  const input = await parseBody(c, CreateSuppressionInput);
  const result = await withIdempotency(
    c.env.DB,
    auth.org_id,
    "suppression",
    input.client_id,
    async () => {
      const row = await insertSuppression(c.env.DB, auth.org_id, input.address);
      if (!row) {
        throw new ApiError("conflict", `${input.address} is already suppressed`);
      }
      return row;
    }
  );
  await emitSuppressionEvent(c.env.DB, auth.org_id, "suppression.added", {
    address: result.address,
    reason: result.reason,
    source_msg_id: result.source_msg_id
  });
  return c.json(suppressionJson(result), 201);
});

suppressions.delete("/suppressions/:address", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  requireOrgScope(auth);
  const address = c.req.param("address").toLowerCase();
  const row = await deleteSuppression(c.env.DB, auth.org_id, address);
  if (!row) throw new ApiError("not_found", "no such suppression");
  await emitSuppressionEvent(c.env.DB, auth.org_id, "suppression.removed", {
    address: row.address,
    reason: row.reason,
    source_msg_id: row.source_msg_id
  });
  return c.body(null, 204);
});

// Batch add/remove in one call. Adds are reason 'manual'; entries already in
// the requested state are silently skipped (conflict/no-op), and the response
// reports only actual changes.
suppressions.post("/suppressions/batch", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  requireOrgScope(auth);
  const input = await parseBody(c, BatchSuppressionInput);
  const added: SuppressionRow[] = [];
  const removed: SuppressionRow[] = [];
  for (const address of input.add ?? []) {
    const row = await insertSuppression(c.env.DB, auth.org_id, address);
    if (row) added.push(row);
  }
  for (const address of input.remove ?? []) {
    const row = await deleteSuppression(c.env.DB, auth.org_id, address);
    if (row) removed.push(row);
  }
  for (const row of added) {
    await emitSuppressionEvent(c.env.DB, auth.org_id, "suppression.added", {
      address: row.address,
      reason: row.reason,
      source_msg_id: row.source_msg_id
    });
  }
  for (const row of removed) {
    await emitSuppressionEvent(c.env.DB, auth.org_id, "suppression.removed", {
      address: row.address,
      reason: row.reason,
      source_msg_id: row.source_msg_id
    });
  }
  return c.json({
    added: added.map(suppressionJson),
    removed: removed.map((r) => r.address)
  });
});
