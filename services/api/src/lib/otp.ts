import { newId } from "@wzrdmail/core";
import { createMimeMessage } from "mimetext/browser";
import { hashApiKey } from "../auth.js";
import { CloudflareEmailProvider } from "../egress/provider.js";
import type { Env } from "../env.js";

export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
export const SHARED_DOMAIN = "wzrd.tech";

export type OtpPurpose = "agent_verify" | "console_login";

/** Sentinel code_hash marking a code that thirdweb (not us) holds and verifies. */
export const THIRDWEB_CODE = "thirdweb";

const THIRDWEB_API = "https://api.thirdweb.com";

function randomOtp(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String((buf[0] ?? 0) % 1_000_000).padStart(6, "0");
}

/** Ask thirdweb to email a login code to the address. */
export async function thirdwebInitiate(env: Env, email: string): Promise<boolean> {
  if (!env.THIRDWEB_CLIENT_ID) return false;
  try {
    const res = await fetch(`${THIRDWEB_API}/v1/auth/initiate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-client-id": env.THIRDWEB_CLIENT_ID },
      body: JSON.stringify({ method: "email", email })
    });
    if (!res.ok) {
      console.error(
        JSON.stringify({ msg: "thirdweb_initiate_failed", status: res.status })
      );
    }
    return res.ok;
  } catch (err) {
    console.error(JSON.stringify({ msg: "thirdweb_initiate_failed", error: String(err) }));
    return false;
  }
}

/**
 * Verify an emailed code with thirdweb. Distinguishes a definitive rejection
 * ("invalid") from transient upstream failures ("unavailable"), so callers
 * only consume an attempt for genuine wrong guesses.
 */
export async function thirdwebComplete(
  env: Env,
  email: string,
  code: string
): Promise<"ok" | "invalid" | "unavailable"> {
  if (!env.THIRDWEB_CLIENT_ID) return "unavailable";
  try {
    const res = await fetch(`${THIRDWEB_API}/v1/auth/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-client-id": env.THIRDWEB_CLIENT_ID },
      body: JSON.stringify({ method: "email", email, code })
    });
    if (res.ok) return "ok";
    if (res.status === 429 || res.status >= 500) {
      console.error(JSON.stringify({ msg: "thirdweb_complete_unavailable", status: res.status }));
      return "unavailable";
    }
    return "invalid";
  } catch (err) {
    console.error(JSON.stringify({ msg: "thirdweb_complete_failed", error: String(err) }));
    return "unavailable";
  }
}

/**
 * Resolve a thirdweb user auth token (JWT) to the verified email it belongs
 * to, via thirdweb's authenticated wallet endpoint. "invalid" means thirdweb
 * definitively rejected the token; "unavailable" means the check could not be
 * performed.
 */
export async function thirdwebEmailForToken(
  env: Env,
  token: string
): Promise<{ email: string } | "invalid" | "unavailable"> {
  if (!env.THIRDWEB_CLIENT_ID) return "unavailable";
  try {
    const res = await fetch(`${THIRDWEB_API}/v1/wallets/me`, {
      headers: { "x-client-id": env.THIRDWEB_CLIENT_ID, authorization: `Bearer ${token}` }
    });
    if (res.status === 429 || res.status >= 500) {
      console.error(JSON.stringify({ msg: "thirdweb_me_unavailable", status: res.status }));
      return "unavailable";
    }
    if (!res.ok) return "invalid";
    const body = (await res.json()) as {
      result?: { profiles?: { type?: string; email?: string; emailVerified?: boolean }[] };
    };
    const profile = body.result?.profiles?.find(
      (p) => typeof p.email === "string" && p.email.length > 0 && p.emailVerified !== false
    );
    if (!profile?.email) return "invalid";
    return { email: profile.email.toLowerCase() };
  } catch (err) {
    console.error(JSON.stringify({ msg: "thirdweb_me_failed", error: String(err) }));
    return "unavailable";
  }
}

/** Email a specific code through Cloudflare Email Service. */
async function sendCodeEmail(
  env: Env,
  email: string,
  purpose: OtpPurpose,
  code: string
): Promise<boolean> {
  const mime = createMimeMessage();
  const from = `noreply@${SHARED_DOMAIN}`;
  mime.setSender(from);
  mime.setTo(email);
  mime.setSubject(
    purpose === "console_login" ? "Your wzrdmail console sign-in code" : "Your wzrdmail verification code"
  );
  mime.setHeader("Message-ID", `<${newId("msg")}@${SHARED_DOMAIN}>`);
  mime.addMessage({
    contentType: "text/plain",
    data:
      purpose === "console_login"
        ? `Your wzrdmail console sign-in code is: ${code}\n\nIt expires in 10 minutes. If you didn't request this, ignore this email.`
        : `Your wzrdmail verification code is: ${code}\n\nIt expires in 10 minutes. If you didn't request this, ignore this email.`
  });
  const provider = new CloudflareEmailProvider(env);
  const recipient = email.toLowerCase();
  try {
    const outcome = await provider.send({ from, to: [recipient], raw: mime.asRaw() });
    if (!outcome.accepted.includes(recipient)) {
      console.error(
        JSON.stringify({
          msg: "otp_send_rejected",
          error: outcome.rejected[0]?.error ?? "recipient not accepted"
        })
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(JSON.stringify({ msg: "otp_send_failed", error: String(err) }));
    return false;
  }
}

/**
 * Deliver an OTP email without touching the database: thirdweb when
 * configured (thirdweb holds the code), otherwise Cloudflare Email with a
 * locally generated code. Returns the code hash to store, or null when
 * delivery failed.
 */
export async function deliverOtp(
  env: Env,
  email: string,
  purpose: OtpPurpose
): Promise<string | null> {
  const recipient = email.toLowerCase();
  if (env.THIRDWEB_CLIENT_ID) {
    return (await thirdwebInitiate(env, recipient)) ? THIRDWEB_CODE : null;
  }
  const code = randomOtp();
  if (!(await sendCodeEmail(env, recipient, purpose, code))) return null;
  return hashApiKey(code);
}

/**
 * Emails a fresh OTP and stores it only after delivery succeeds, so a failed
 * send leaves any previously delivered code valid. Returns whether delivery
 * succeeded.
 */
export async function issueOtp(
  env: Env,
  orgId: string,
  humanEmail: string,
  purpose: OtpPurpose
): Promise<boolean> {
  const codeHash = await deliverOtp(env, humanEmail, purpose);
  if (codeHash === null) return false;

  const now = new Date();
  await env.DB.prepare(
    `INSERT INTO otp_codes (org_id, purpose, code_hash, attempts, expires_at, created_at)
     VALUES (?, ?, ?, 0, ?, ?)
     ON CONFLICT (org_id, purpose) DO UPDATE
       SET code_hash = excluded.code_hash, attempts = 0,
           expires_at = excluded.expires_at, created_at = excluded.created_at`
  )
    .bind(
      orgId,
      purpose,
      codeHash,
      new Date(now.getTime() + OTP_TTL_MS).toISOString(),
      now.toISOString()
    )
    .run();
  return true;
}

/**
 * Consume one attempt and compare the submitted code; throws nothing, returns
 * "ok" | "expired" | "exhausted" | "mismatch" | "missing".
 */
export async function checkOtp(
  env: Env,
  orgId: string,
  purpose: OtpPurpose,
  submitted: string,
  email: string
): Promise<"ok" | "expired" | "exhausted" | "mismatch" | "missing" | "unavailable"> {
  const row = await env.DB.prepare(
    "SELECT code_hash, expires_at FROM otp_codes WHERE org_id = ? AND purpose = ?"
  )
    .bind(orgId, purpose)
    .first<{ code_hash: string; expires_at: string }>();
  if (!row) return "missing";
  if (new Date(row.expires_at).getTime() < Date.now()) return "expired";
  // Consume an attempt atomically before comparing, so concurrent guesses
  // cannot all pass the limit check on a shared snapshot.
  const consumed = await env.DB.prepare(
    `UPDATE otp_codes SET attempts = attempts + 1
     WHERE org_id = ? AND purpose = ? AND attempts < ?`
  )
    .bind(orgId, purpose, OTP_MAX_ATTEMPTS)
    .run();
  if (consumed.meta.changes === 0) return "exhausted";
  if (row.code_hash === THIRDWEB_CODE) {
    const verdict = await thirdwebComplete(env, email.toLowerCase(), submitted);
    if (verdict === "unavailable") {
      // Refund the attempt: the guess was never actually checked.
      await env.DB.prepare(
        "UPDATE otp_codes SET attempts = attempts - 1 WHERE org_id = ? AND purpose = ? AND attempts > 0"
      )
        .bind(orgId, purpose)
        .run();
      return "unavailable";
    }
    if (verdict === "invalid") return "mismatch";
  } else if (row.code_hash !== (await hashApiKey(submitted))) {
    return "mismatch";
  }
  await env.DB.prepare("DELETE FROM otp_codes WHERE org_id = ? AND purpose = ?")
    .bind(orgId, purpose)
    .run();
  return "ok";
}
