import { ApiError, newId } from "@wzrdmail/core";
import { hashApiKey } from "../auth.js";
import type { Env } from "../env.js";
import { OTP_MAX_ATTEMPTS, SHARED_DOMAIN, THIRDWEB_CODE, thirdwebComplete } from "./otp.js";

/**
 * A sign-up that has been emailed a code but proved nothing yet. It lives only
 * in KV (never D1) so anonymous requests cannot reserve an org or a username.
 * The console stores it under `signup_pending:<email>`; the connector under
 * `connect_pending:<email>`, so the two flows cannot clobber each other.
 */
export interface PendingSignup {
  username: string;
  org_name: string | null;
  code_hash: string;
  attempts: number;
  expires_at: string;
  created_at: string;
}

/** Finalize a verified signup: create the org, default pod, and first inbox. */
export async function completeSignup(
  env: Env,
  humanEmail: string,
  pending: PendingSignup
): Promise<{ org_id: string; human_email: string }> {
  const orgId = newId("org");
  const podId = newId("pod");
  const inboxId = `${pending.username}@${SHARED_DOMAIN}`;
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO organizations (org_id, name, plan, human_email, verified, created_at, updated_at)
         VALUES (?, ?, 'free', ?, 1, ?, ?)`
      ).bind(orgId, pending.org_name ?? pending.username, humanEmail, now, now),
      env.DB.prepare(
        "INSERT INTO pods (pod_id, org_id, name, created_at) VALUES (?, ?, 'default', ?)"
      ).bind(podId, orgId, now),
      env.DB.prepare(
        `INSERT INTO inboxes (inbox_id, org_id, pod_id, username, domain, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(inboxId, orgId, podId, pending.username, SHARED_DOMAIN, now, now)
    ]);
  } catch (err) {
    if (String(err).includes("UNIQUE")) {
      throw new ApiError("conflict", "this email or username was registered while you verified; sign up again");
    }
    throw err;
  }
  return { org_id: orgId, human_email: humanEmail };
}

/**
 * Check a pending-signup code (thirdweb or locally hashed) with an attempt cap.
 * `cacheKey` is the KV key the record lives under, so each flow caps attempts
 * against its own record.
 */
export async function checkPendingSignup(
  env: Env,
  cacheKey: string,
  humanEmail: string,
  pending: PendingSignup,
  submitted: string
): Promise<"ok" | "exhausted" | "mismatch" | "expired" | "unavailable"> {
  if (new Date(pending.expires_at).getTime() < Date.now()) return "expired";
  if (pending.attempts >= OTP_MAX_ATTEMPTS) return "exhausted";
  // KV writes are not atomic, so this attempt counter is best-effort; the
  // short TTL bounds total guesses.
  pending.attempts += 1;
  await env.CACHE.put(cacheKey, JSON.stringify(pending), {
    expirationTtl: Math.max(60, Math.ceil((new Date(pending.expires_at).getTime() - Date.now()) / 1000))
  });
  if (pending.code_hash === THIRDWEB_CODE) {
    const result = await thirdwebComplete(env, humanEmail, submitted);
    if (result === "unavailable") {
      // Refund the attempt: the guess was never actually checked.
      pending.attempts -= 1;
      await env.CACHE.put(cacheKey, JSON.stringify(pending), {
        expirationTtl: Math.max(60, Math.ceil((new Date(pending.expires_at).getTime() - Date.now()) / 1000))
      });
      return "unavailable";
    }
    return result === "ok" ? "ok" : "mismatch";
  }
  return pending.code_hash === (await hashApiKey(submitted)) ? "ok" : "mismatch";
}
