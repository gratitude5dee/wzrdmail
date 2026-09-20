import { newId } from "@wzrdmail/core";
import { hashApiKey } from "../auth.js";
import type { Env } from "../env.js";

/** Where a key came from (migration 0015): console UI, agent sign-up, OAuth consent. */
export type ApiKeySource = "console" | "agent" | "oauth";

export interface MintApiKeyInput {
  org_id: string;
  /** Pod scope, or null for an organization-wide key. */
  pod_id?: string | null;
  /** Inbox scope, or null for a pod-/org-wide key. */
  inbox_id?: string | null;
  permissions: string[];
  name?: string | null;
  source: ApiKeySource;
  /** OAuth client_id when source is "oauth". */
  client_id?: string | null;
}

export interface MintedApiKey {
  key_id: string;
  /** Plaintext secret — returned once, never stored and never logged. */
  api_key: string;
  key_prefix: string;
  created_at: string;
}

/**
 * The single INSERT that creates an API key. Only the SHA-256 hash and the
 * 12-char lookup prefix reach D1 (goal.md §2 secrets discipline); the caller
 * shows the plaintext once and forgets it. Callers are responsible for having
 * already proved that pod_id/inbox_id belong to org_id.
 */
export async function mintApiKey(env: Env, input: MintApiKeyInput): Promise<MintedApiKey> {
  const keyId = newId("key");
  const secret = `wm_live_${[...crypto.getRandomValues(new Uint8Array(24))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
  const keyPrefix = secret.slice(0, 12);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO api_keys (key_id, org_id, pod_id, inbox_id, key_hash, key_prefix, permissions, name, source, client_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      keyId,
      input.org_id,
      input.pod_id ?? null,
      input.inbox_id ?? null,
      await hashApiKey(secret),
      keyPrefix,
      input.permissions.join(","),
      input.name ?? null,
      input.source,
      input.client_id ?? null,
      now
    )
    .run();
  return { key_id: keyId, api_key: secret, key_prefix: keyPrefix, created_at: now };
}
