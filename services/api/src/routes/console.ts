import { ApiError, newId } from "@wzrdmail/core";
import { Hono } from "hono";
import { z } from "zod";
import { SESSION_COOKIE, authenticate, hashApiKey } from "../auth.js";
import type { Env } from "../env.js";
import { parseBody } from "../lib/http.js";
import { OTP_RESEND_COOLDOWN_MS, checkOtp, issueOtp } from "../lib/otp.js";

export const consoleAuth = new Hono<{ Bindings: Env }>();

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const LoginInput = z.object({ email: z.string().email() });
const VerifyInput = z.object({ email: z.string().email(), otp_code: z.string().min(4).max(8) });

function randomToken(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sessionCookie(env: Env, token: string, maxAgeSeconds: number): string {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    // The console SPA lives on a different origin (console.mail.wzrd.tech),
    // so cross-site credentialed requests require SameSite=None; Secure.
    ...(env.WZRDMAIL_ENV === "dev" ? ["SameSite=Lax"] : ["SameSite=None", "Secure"])
  ];
  return attrs.join("; ");
}

async function findOrg(env: Env, email: string): Promise<{ org_id: string; human_email: string } | null> {
  return env.DB.prepare("SELECT org_id, human_email FROM organizations WHERE human_email = ?")
    .bind(email.toLowerCase())
    .first<{ org_id: string; human_email: string }>();
}

consoleAuth.post("/console/login", async (c) => {
  const input = await parseBody(c, LoginInput);
  const org = await findOrg(c.env, input.email);
  // Do not reveal whether the email exists; always claim a code may arrive.
  if (org) {
    const pending = await c.env.DB.prepare(
      "SELECT created_at FROM otp_codes WHERE org_id = ? AND purpose = 'console_login'"
    )
      .bind(org.org_id)
      .first<{ created_at: string }>();
    const claimedAt = new Date().toISOString();
    let claimed = false;
    let placeholder = false;
    if (pending) {
      const remainingMs =
        OTP_RESEND_COOLDOWN_MS - (Date.now() - new Date(pending.created_at).getTime());
      if (remainingMs <= 0) {
        // Claim the cooldown window atomically so concurrent logins cannot
        // each trigger a send: only the request that bumps created_at proceeds.
        const res = await c.env.DB.prepare(
          `UPDATE otp_codes SET created_at = ?
           WHERE org_id = ? AND purpose = 'console_login' AND created_at = ?`
        )
          .bind(claimedAt, org.org_id, pending.created_at)
          .run();
        claimed = res.meta.changes > 0;
      }
    } else {
      // No code yet: claim by inserting an unverifiable placeholder (already
      // expired, attempts exhausted) that issueOtp will overwrite on success.
      const res = await c.env.DB.prepare(
        `INSERT INTO otp_codes (org_id, purpose, code_hash, attempts, expires_at, created_at)
         VALUES (?, 'console_login', 'claim', 999, ?, ?)
         ON CONFLICT (org_id, purpose) DO NOTHING`
      )
        .bind(org.org_id, new Date(0).toISOString(), claimedAt)
        .run();
      claimed = res.meta.changes > 0;
      placeholder = claimed;
    }
    if (claimed) {
      const delivered = await issueOtp(c.env, org.org_id, org.human_email, "console_login");
      if (!delivered) {
        // Release the claim so a failed delivery does not start a cooldown;
        // only touch the row if it still carries our claim timestamp.
        if (placeholder) {
          await c.env.DB.prepare(
            `DELETE FROM otp_codes
             WHERE org_id = ? AND purpose = 'console_login' AND code_hash = 'claim' AND created_at = ?`
          )
            .bind(org.org_id, claimedAt)
            .run();
        } else if (pending) {
          await c.env.DB.prepare(
            `UPDATE otp_codes SET created_at = ?
             WHERE org_id = ? AND purpose = 'console_login' AND created_at = ?`
          )
            .bind(pending.created_at, org.org_id, claimedAt)
            .run();
        }
      }
    }
  }
  return c.json({ message: "If this email has an organization, a sign-in code is on its way." });
});

consoleAuth.post("/console/verify", async (c) => {
  const input = await parseBody(c, VerifyInput);
  const org = await findOrg(c.env, input.email);
  if (!org) throw new ApiError("unauthorized", "incorrect email or code");
  const verdict = await checkOtp(c.env, org.org_id, "console_login", input.otp_code);
  if (verdict !== "ok") {
    if (verdict === "exhausted") {
      throw new ApiError("forbidden", "too many attempts; request a new code");
    }
    throw new ApiError("unauthorized", "incorrect email or code");
  }
  const token = `wms_${randomToken(32)}`;
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO sessions (session_id, token_hash, org_id, email, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      newId("ses"),
      await hashApiKey(token),
      org.org_id,
      org.human_email,
      new Date(now + SESSION_TTL_MS).toISOString(),
      new Date(now).toISOString()
    )
    .run();
  c.header("Set-Cookie", sessionCookie(c.env, token, SESSION_TTL_MS / 1000));
  return c.json({ organization_id: org.org_id, email: org.human_email });
});

consoleAuth.get("/console/session", async (c) => {
  const auth = await authenticate(c);
  const org = await c.env.DB.prepare(
    "SELECT org_id, name, plan, verified, human_email, created_at FROM organizations WHERE org_id = ?"
  )
    .bind(auth.org_id)
    .first<{
      org_id: string;
      name: string;
      plan: string;
      verified: number;
      human_email: string;
      created_at: string;
    }>();
  if (!org) throw new ApiError("not_found", "organization not found");
  return c.json({
    organization_id: org.org_id,
    name: org.name,
    plan: org.plan,
    verified: org.verified === 1,
    email: org.human_email,
    created_at: org.created_at
  });
});

consoleAuth.post("/console/logout", async (c) => {
  const cookie = c.req.header("cookie") ?? "";
  const token = cookie
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  if (token) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
      .bind(await hashApiKey(token))
      .run();
  }
  c.header("Set-Cookie", sessionCookie(c.env, "", 0));
  return c.json({ ok: true });
});
