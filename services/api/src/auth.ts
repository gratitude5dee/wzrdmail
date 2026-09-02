import { ApiError } from "@wzrdmail/core";
import type { Context } from "hono";
import type { Env } from "./env.js";

export interface AuthedKey {
  key_id: string;
  org_id: string;
  pod_id: string | null;
  /** Set for inbox-scoped keys: the only inbox this key may touch. */
  inbox_id: string | null;
  permissions: string;
  org_verified: boolean;
  human_email: string;
}

/**
 * Permission sets are comma-separated (`read`, `send`, `drafts`, `admin`);
 * admin implies all. `drafts` allows creating/editing drafts without the
 * ability to send them (`send` also implies `drafts`), so sandboxed agents
 * can prepare mail for human review.
 */
export function requirePermission(
  auth: AuthedKey,
  needed: "read" | "send" | "drafts" | "admin"
): void {
  const granted = auth.permissions.split(",").map((p) => p.trim().toLowerCase());
  if (granted.includes("admin") || granted.includes(needed)) return;
  if (needed === "drafts" && granted.includes("send")) return;
  throw new ApiError("forbidden", `API key lacks the '${needed}' permission`);
}

export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const SESSION_COOKIE = "wm_session";

/** Console session cookie → org-admin principal (goal-console.md §1). */
async function authenticateSession(
  c: Context<{ Bindings: Env }>,
  token: string
): Promise<AuthedKey | null> {
  const tokenHash = await hashApiKey(token);
  const row = await c.env.DB.prepare(
    `SELECT s.session_id, s.org_id, s.expires_at, o.verified AS org_verified, o.human_email
     FROM sessions s JOIN organizations o ON o.org_id = s.org_id
     WHERE s.token_hash = ?`
  )
    .bind(tokenHash)
    .first<{
      session_id: string;
      org_id: string;
      expires_at: string;
      org_verified: number;
      human_email: string;
    }>();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE session_id = ?").bind(row.session_id).run();
    return null;
  }
  return {
    key_id: row.session_id,
    org_id: row.org_id,
    pod_id: null,
    inbox_id: null,
    permissions: "admin",
    org_verified: row.org_verified === 1,
    human_email: row.human_email
  };
}

function readCookie(c: Context<{ Bindings: Env }>, name: string): string | null {
  const header = c.req.header("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Resolve `Authorization: Bearer wm_…`, `x-api-key: wm_…` (§7), or a console session cookie. */
export async function authenticate(
  c: Context<{ Bindings: Env }>
): Promise<AuthedKey> {
  const header = c.req.header("authorization");
  const bearer = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null;
  const key = bearer ?? c.req.header("x-api-key") ?? null;
  if (!key || !key.startsWith("wm_")) {
    const cookie = readCookie(c, SESSION_COOKIE);
    if (cookie) {
      const session = await authenticateSession(c, cookie);
      if (session) return session;
    }
    throw new ApiError("unauthorized", "missing or malformed API key");
  }
  const keyHash = await hashApiKey(key);
  const row = await c.env.DB.prepare(
    `SELECT k.key_id, k.org_id, COALESCE(i.pod_id, k.pod_id) AS pod_id, k.inbox_id, k.permissions,
            o.verified AS org_verified, o.human_email
     FROM api_keys k JOIN organizations o ON o.org_id = k.org_id
     LEFT JOIN inboxes i ON i.inbox_id = k.inbox_id
     WHERE k.key_hash = ? AND k.revoked_at IS NULL`
  )
    .bind(keyHash)
    .first<{
      key_id: string;
      org_id: string;
      pod_id: string | null;
      inbox_id: string | null;
      permissions: string;
      org_verified: number;
      human_email: string;
    }>();
  if (!row) throw new ApiError("unauthorized", "invalid API key");
  await c.env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE key_id = ?")
    .bind(new Date().toISOString(), row.key_id)
    .run();
  return {
    key_id: row.key_id,
    org_id: row.org_id,
    pod_id: row.pod_id,
    inbox_id: row.inbox_id,
    permissions: row.permissions,
    org_verified: row.org_verified === 1,
    human_email: row.human_email
  };
}
