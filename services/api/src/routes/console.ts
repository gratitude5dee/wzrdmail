import { ApiError, newId, validateUsername } from "@wzrdmail/core";
import { Hono } from "hono";
import { z } from "zod";
import { SESSION_COOKIE, authenticate, hashApiKey } from "../auth.js";
import type { Env } from "../env.js";
import { parseBody } from "../lib/http.js";
import {
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
  SHARED_DOMAIN,
  THIRDWEB_CODE,
  checkOtp,
  deliverOtp,
  issueOtp,
  thirdwebComplete
} from "../lib/otp.js";

export const consoleAuth = new Hono<{ Bindings: Env }>();

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const LoginInput = z.object({ email: z.string().email() });
const SignupInput = z.object({
  email: z.string().email(),
  username: z.string().min(1).max(64),
  org_name: z.string().min(1).max(120).optional()
});
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

interface PendingSignup {
  username: string;
  org_name: string | null;
  code_hash: string;
  attempts: number;
  expires_at: string;
  created_at: string;
}

function pendingKey(email: string): string {
  return `signup_pending:${email}`;
}

const SIGNUP_IP_LIMIT = 10;
const SIGNUP_IP_WINDOW_SECONDS = 3600;

/** Best-effort per-IP throttle: anonymous signups may not spam email sends. */
async function throttleSignup(c: { env: Env; req: { header: (n: string) => string | undefined } }): Promise<void> {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const key = `signup_rate:${ip}`;
  const count = Number((await c.env.CACHE.get(key)) ?? "0");
  if (count >= SIGNUP_IP_LIMIT) {
    throw new ApiError("rate_limited", "too many sign-up attempts; try again later");
  }
  await c.env.CACHE.put(key, String(count + 1), { expirationTtl: SIGNUP_IP_WINDOW_SECONDS });
}

consoleAuth.post("/console/signup", async (c) => {
  const input = await parseBody(c, SignupInput);
  const humanEmail = input.email.toLowerCase();
  const verdict = validateUsername(input.username);
  if (!verdict.ok) {
    throw new ApiError("validation_error", `username is ${verdict.reason}`);
  }
  const existingOrg = await findOrg(c.env, humanEmail);
  if (existingOrg) {
    throw new ApiError("conflict", "this email is already registered; sign in instead");
  }
  const existingInbox = await c.env.DB.prepare(
    "SELECT inbox_id FROM inboxes WHERE username = ? AND domain = ?"
  )
    .bind(verdict.username, SHARED_DOMAIN)
    .first<{ inbox_id: string }>();
  if (existingInbox) {
    throw new ApiError("conflict", "this username is taken");
  }

  const prior = await c.env.CACHE.get<PendingSignup>(pendingKey(humanEmail), "json");
  if (prior && Date.now() - new Date(prior.created_at).getTime() < OTP_RESEND_COOLDOWN_MS) {
    c.header("Retry-After", String(Math.ceil(OTP_RESEND_COOLDOWN_MS / 1000)));
    throw new ApiError("rate_limited", "a code was sent recently; wait before requesting another");
  }
  await throttleSignup(c);

  // Nothing is persisted in D1 yet: the org, pod, and inbox are only created
  // once /console/verify proves ownership of the email, so anonymous requests
  // cannot reserve usernames.
  const codeHash = await deliverOtp(c.env, humanEmail, "console_login");
  if (codeHash !== null) {
    const now = new Date();
    const pending: PendingSignup = {
      username: verdict.username,
      org_name: input.org_name ?? null,
      code_hash: codeHash,
      attempts: 0,
      expires_at: new Date(now.getTime() + OTP_TTL_MS).toISOString(),
      created_at: now.toISOString()
    };
    await c.env.CACHE.put(pendingKey(humanEmail), JSON.stringify(pending), {
      expirationTtl: Math.ceil(OTP_TTL_MS / 1000)
    });
  }
  return c.json({
    delivered: codeHash !== null,
    message:
      codeHash !== null
        ? `Sign-in code sent to ${humanEmail}.`
        : `We could not deliver the sign-in code to ${humanEmail}; try again in a minute.`
  });
});

/** Finalize a verified signup: create the org, default pod, and first inbox. */
async function completeSignup(
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

/** Check a pending-signup code (thirdweb or locally hashed) with an attempt cap. */
async function checkPendingSignup(
  env: Env,
  humanEmail: string,
  pending: PendingSignup,
  submitted: string
): Promise<"ok" | "exhausted" | "mismatch" | "expired"> {
  if (new Date(pending.expires_at).getTime() < Date.now()) return "expired";
  if (pending.attempts >= OTP_MAX_ATTEMPTS) return "exhausted";
  // KV writes are not atomic, so this attempt counter is best-effort; the
  // short TTL bounds total guesses.
  pending.attempts += 1;
  await env.CACHE.put(pendingKey(humanEmail), JSON.stringify(pending), {
    expirationTtl: Math.max(60, Math.ceil((new Date(pending.expires_at).getTime() - Date.now()) / 1000))
  });
  const matches =
    pending.code_hash === THIRDWEB_CODE
      ? await thirdwebComplete(env, humanEmail, submitted)
      : pending.code_hash === (await hashApiKey(submitted));
  return matches ? "ok" : "mismatch";
}

consoleAuth.post("/console/verify", async (c) => {
  const input = await parseBody(c, VerifyInput);
  const humanEmail = input.email.toLowerCase();
  let org = await findOrg(c.env, humanEmail);
  if (org) {
    const verdict = await checkOtp(c.env, org.org_id, "console_login", input.otp_code, humanEmail);
    if (verdict !== "ok") {
      if (verdict === "exhausted") {
        throw new ApiError("forbidden", "too many attempts; request a new code");
      }
      throw new ApiError("unauthorized", "incorrect email or code");
    }
    // A successful OTP round-trip proves ownership of the org's human email.
    await c.env.DB.prepare(
      "UPDATE organizations SET verified = 1, updated_at = ? WHERE org_id = ? AND verified = 0"
    )
      .bind(new Date().toISOString(), org.org_id)
      .run();
  } else {
    const pending = await c.env.CACHE.get<PendingSignup>(pendingKey(humanEmail), "json");
    if (!pending) throw new ApiError("unauthorized", "incorrect email or code");
    const verdict = await checkPendingSignup(c.env, humanEmail, pending, input.otp_code);
    if (verdict !== "ok") {
      if (verdict === "exhausted") {
        throw new ApiError("forbidden", "too many attempts; request a new code");
      }
      throw new ApiError("unauthorized", "incorrect email or code");
    }
    org = await completeSignup(c.env, humanEmail, pending);
    await c.env.CACHE.delete(pendingKey(humanEmail));
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
