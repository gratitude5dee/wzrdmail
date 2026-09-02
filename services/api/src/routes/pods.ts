import { ApiError, CreatePodInput, newId } from "@wzrdmail/core";
import { Hono } from "hono";
import type { Context } from "hono";
import { authenticate, requirePermission, type AuthedKey } from "../auth.js";
import type { Env } from "../env.js";
import {
  collection,
  parseBody,
  parsePagination,
  requireNotInboxScoped,
  withIdempotency
} from "../lib/http.js";

export const pods = new Hono<{ Bindings: Env }>();

interface PodRow {
  pod_id: string;
  org_id: string;
  name: string;
  client_id: string | null;
  created_at: string;
}

function podJson(row: PodRow): Record<string, unknown> {
  return {
    pod_id: row.pod_id,
    organization_id: row.org_id,
    name: row.name,
    client_id: row.client_id,
    created_at: row.created_at
  };
}

/** Load a pod and enforce org + pod scoping; foreign pods 404 (§7). */
export async function requirePod(
  c: Context<{ Bindings: Env }>,
  auth: AuthedKey,
  podId: string
): Promise<PodRow> {
  const row = await c.env.DB.prepare(
    "SELECT pod_id, org_id, name, client_id, created_at FROM pods WHERE pod_id = ? AND org_id = ? AND deleted_at IS NULL"
  )
    .bind(podId, auth.org_id)
    .first<PodRow>();
  if (!row || (auth.pod_id && auth.pod_id !== row.pod_id)) {
    throw new ApiError("not_found", "pod not found");
  }
  return row;
}

pods.get("/pods", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  requireNotInboxScoped(auth, "pod listing");
  const { limit, cursor } = parsePagination(c);
  const rows = (
    await c.env.DB.prepare(
      `SELECT pod_id, org_id, name, client_id, created_at
       FROM pods
       WHERE org_id = ? AND deleted_at IS NULL
         AND (? IS NULL OR pod_id = ?)
         AND (? IS NULL OR created_at > ? OR (created_at = ? AND pod_id > ?))
       ORDER BY created_at, pod_id LIMIT ?`
    )
      .bind(
        auth.org_id,
        auth.pod_id,
        auth.pod_id,
        cursor?.v ?? null,
        cursor?.v ?? null,
        cursor?.v ?? null,
        cursor?.id ?? null,
        limit + 1
      )
      .all<PodRow>()
  ).results;
  const page = collection(rows, limit, (r) => ({ v: r.created_at, id: r.pod_id }));
  return c.json({ pods: page.items.map(podJson), next_page_token: page.next_page_token ?? null });
});

pods.post("/pods", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  requireNotInboxScoped(auth, "pod creation");
  if (auth.pod_id) throw new ApiError("forbidden", "pod-scoped keys cannot create pods");
  const input = await parseBody(c, CreatePodInput);
  const result = await withIdempotency(c.env.DB, auth.org_id, "pod", input.client_id, async () => {
    const row: PodRow = {
      pod_id: newId("pod"),
      org_id: auth.org_id,
      name: input.name ?? "default",
      client_id: input.client_id ?? null,
      created_at: new Date().toISOString()
    };
    const inserted = await c.env.DB.prepare(
      "INSERT INTO pods (pod_id, org_id, name, client_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING"
    )
      .bind(row.pod_id, row.org_id, row.name, row.client_id, row.created_at)
      .run();
    if (inserted.meta.changes === 0) {
      throw new ApiError("conflict", `a pod with client_id ${input.client_id} already exists`);
    }
    return podJson(row);
  });
  return c.json(result, 201);
});

pods.get("/pods/:pod_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  requireNotInboxScoped(auth, "pod access");
  return c.json(podJson(await requirePod(c, auth, c.req.param("pod_id"))));
});

/** Soft-deletes the pod and every inbox in it; the org's last pod stays. */
pods.delete("/pods/:pod_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  requireNotInboxScoped(auth, "pod deletion");
  if (auth.pod_id) throw new ApiError("forbidden", "pod-scoped keys cannot delete pods");
  const pod = await requirePod(c, auth, c.req.param("pod_id"));
  const remaining = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM pods WHERE org_id = ? AND deleted_at IS NULL"
  )
    .bind(auth.org_id)
    .first<{ n: number }>();
  if ((remaining?.n ?? 0) <= 1) {
    throw new ApiError("conflict", "an organization must keep at least one pod");
  }
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE inboxes SET deleted_at = ?, updated_at = ? WHERE pod_id = ? AND deleted_at IS NULL"
    ).bind(now, now, pod.pod_id),
    c.env.DB.prepare("UPDATE pods SET deleted_at = ? WHERE pod_id = ?").bind(now, pod.pod_id)
  ]);
  return c.body(null, 204);
});
