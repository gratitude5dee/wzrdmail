import { ApiError, newId } from "@wzrdmail/core";
import { Hono } from "hono";
import { z } from "zod";
import { authenticate, hashApiKey, requirePermission } from "../auth.js";
import type { Env } from "../env.js";
import { parseBody } from "../lib/http.js";

export const keys = new Hono<{ Bindings: Env }>();

const CreateKeyInput = z.object({
  name: z.string().min(1).max(80),
  pod_id: z.string().startsWith("pod_").optional(),
  permissions: z
    .array(z.enum(["read", "send", "admin"]))
    .min(1)
    .default(["admin"])
});

interface KeyRow {
  key_id: string;
  pod_id: string | null;
  name: string | null;
  key_prefix: string;
  permissions: string;
  last_used_at: string | null;
  created_at: string;
}

function keyJson(row: KeyRow): Record<string, unknown> {
  return {
    key_id: row.key_id,
    name: row.name,
    pod_id: row.pod_id,
    key_preview: `${row.key_prefix}\u2022\u2022\u2022`,
    permissions: row.permissions.split(",").map((p) => p.trim()),
    last_used_at: row.last_used_at,
    created_at: row.created_at
  };
}

keys.get("/api-keys", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  const rows = auth.pod_id
    ? await c.env.DB.prepare(
        `SELECT key_id, pod_id, name, key_prefix, permissions, last_used_at, created_at
         FROM api_keys WHERE org_id = ? AND pod_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`
      )
        .bind(auth.org_id, auth.pod_id)
        .all<KeyRow>()
    : await c.env.DB.prepare(
        `SELECT key_id, pod_id, name, key_prefix, permissions, last_used_at, created_at
         FROM api_keys WHERE org_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`
      )
        .bind(auth.org_id)
        .all<KeyRow>();
  return c.json({ api_keys: rows.results.map(keyJson) });
});

keys.post("/api-keys", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  const input = await parseBody(c, CreateKeyInput);
  // A pod-scoped credential may only mint keys for its own pod; letting it
  // omit pod_id would grant the new key organization-wide access.
  if (auth.pod_id) {
    if (input.pod_id && input.pod_id !== auth.pod_id) {
      throw new ApiError("forbidden", "pod-scoped keys can only create keys for their own pod");
    }
    input.pod_id = auth.pod_id;
  }
  if (input.pod_id) {
    const pod = await c.env.DB.prepare("SELECT pod_id FROM pods WHERE pod_id = ? AND org_id = ?")
      .bind(input.pod_id, auth.org_id)
      .first();
    if (!pod) throw new ApiError("not_found", "no such pod");
  }
  const keyId = newId("key");
  const secret = `wm_live_${[...crypto.getRandomValues(new Uint8Array(24))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO api_keys (key_id, org_id, pod_id, key_hash, key_prefix, permissions, name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      keyId,
      auth.org_id,
      input.pod_id ?? null,
      await hashApiKey(secret),
      secret.slice(0, 12),
      input.permissions.join(","),
      input.name,
      now
    )
    .run();
  return c.json(
    {
      key_id: keyId,
      name: input.name,
      pod_id: input.pod_id ?? null,
      api_key: secret,
      permissions: input.permissions,
      created_at: now,
      message: "Store this key now; it will not be shown again."
    },
    201
  );
});

keys.delete("/api-keys/:key_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  const result = auth.pod_id
    ? await c.env.DB.prepare(
        "UPDATE api_keys SET revoked_at = ? WHERE key_id = ? AND org_id = ? AND pod_id = ? AND revoked_at IS NULL"
      )
        .bind(new Date().toISOString(), c.req.param("key_id"), auth.org_id, auth.pod_id)
        .run()
    : await c.env.DB.prepare(
        "UPDATE api_keys SET revoked_at = ? WHERE key_id = ? AND org_id = ? AND revoked_at IS NULL"
      )
        .bind(new Date().toISOString(), c.req.param("key_id"), auth.org_id)
        .run();
  if (result.meta.changes === 0) throw new ApiError("not_found", "no such API key");
  return c.json({ key_id: c.req.param("key_id"), revoked: true });
});
