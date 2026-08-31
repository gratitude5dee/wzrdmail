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

function randomOtp(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String((buf[0] ?? 0) % 1_000_000).padStart(6, "0");
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
  const code = randomOtp();
  const mime = createMimeMessage();
  const from = `noreply@${SHARED_DOMAIN}`;
  mime.setSender(from);
  mime.setTo(humanEmail);
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
  const recipient = humanEmail.toLowerCase();
  try {
    const outcome = await provider.send({ from, to: [recipient], raw: mime.asRaw() });
    if (!outcome.accepted.includes(recipient)) {
      console.error(
        JSON.stringify({
          msg: "otp_send_rejected",
          org_id: orgId,
          error: outcome.rejected[0]?.error ?? "recipient not accepted"
        })
      );
      return false;
    }
  } catch (err) {
    console.error(JSON.stringify({ msg: "otp_send_failed", org_id: orgId, error: String(err) }));
    return false;
  }

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
      await hashApiKey(code),
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
  submitted: string
): Promise<"ok" | "expired" | "exhausted" | "mismatch" | "missing"> {
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
  if (row.code_hash !== (await hashApiKey(submitted))) return "mismatch";
  await env.DB.prepare("DELETE FROM otp_codes WHERE org_id = ? AND purpose = ?")
    .bind(orgId, purpose)
    .run();
  return "ok";
}
