import { ApiError, validateUsername } from "@wzrdmail/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { hashApiKey } from "../auth.js";
import type { Env } from "../env.js";
import { parseBody } from "../lib/http.js";
import { mintApiKey } from "../lib/keys.js";
import {
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
  SHARED_DOMAIN,
  checkOtp,
  deliverOtp,
  issueOtp
} from "../lib/otp.js";
import { forwardedIp, throttle } from "../lib/ratelimit.js";
import { type PendingSignup, checkPendingSignup, completeSignup } from "../lib/signup.js";

/**
 * The connector lane (muse.md §7.1). These routes are called server-to-server
 * by the MCP Worker's consent pages during an OAuth authorization: none of
 * them calls `authenticate()` and none of them reads a cookie. Instead each
 * one first compares `x-connect-secret` against `CONNECT_SECRET` in constant
 * time and answers the ordinary 404 envelope otherwise, so the whole surface
 * is invisible until the secret is provisioned.
 */
export const connect = new Hono<{ Bindings: Env }>();

const StartInput = z.object({ email: z.string().email() });
const SignupInput = z.object({
  email: z.string().email(),
  username: z.string().min(1).max(64),
  org_name: z.string().min(1).max(120).optional()
});
const VerifyInput = z.object({ email: z.string().email(), otp_code: z.string().min(4).max(8) });
const CompleteInput = z.object({
  connect_token: z.string().min(32).max(256),
  inbox_id: z.string().email(),
  permissions: z
    .array(z.enum(["read", "send", "drafts", "admin"]))
    .min(1)
    .default(["read"]),
  name: z.string().min(1).max(80),
  client_id: z.string().min(1).max(200).optional()
});

/** Per-email and per-IP caps on the code-sending routes (muse.md §7.5). */
const EMAIL_LIMIT = 5;
const IP_LIMIT = 20;
const RATE_WINDOW_SECONDS = 3600;

/** A consent token lives for ten minutes and is spent once (muse.md §7.1). */
const CONNECT_TOKEN_TTL_SECONDS = 600;

interface ConnectTokenRecord {
  org_id: string;
  human_email: string;
  created_at: string;
}

function pendingKey(email: string): string {
  return `connect_pending:${email}`;
}

function tokenKey(tokenHash: string): string {
  return `connect_token:${tokenHash}`;
}

function randomToken(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time secret comparison. Both sides are hashed first so the compare
 * is over fixed-length digests and the length of the presented secret leaks
 * nothing.
 */
async function secretMatches(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/** Missing, unset, or wrong secret is indistinguishable from "no such route". */
async function requireConnectSecret(c: Context<{ Bindings: Env }>): Promise<void> {
  const expected = c.env.CONNECT_SECRET;
  const provided = c.req.header("x-connect-secret");
  if (!expected || !provided || !(await secretMatches(provided, expected))) {
    throw new ApiError("not_found", "no such endpoint");
  }
}

async function findOrg(
  env: Env,
  email: string
): Promise<{ org_id: string; human_email: string } | null> {
  return env.DB.prepare("SELECT org_id, human_email FROM organizations WHERE human_email = ?")
    .bind(email.toLowerCase())
    .first<{ org_id: string; human_email: string }>();
}

/** 5 codes per email per hour and 20 per IP per hour, before any send. */
async function throttleCodeSend(
  c: Context<{ Bindings: Env }>,
  humanEmail: string
): Promise<void> {
  await throttle(
    c,
    `connect_email_rate:${humanEmail}`,
    EMAIL_LIMIT,
    RATE_WINDOW_SECONDS,
    "too many codes requested for this email; try again later"
  );
  await throttle(
    c,
    `connect_ip_rate:${forwardedIp(c)}`,
    IP_LIMIT,
    RATE_WINDOW_SECONDS,
    "too many connection attempts; try again later"
  );
}

function cooldownExceeded(c: Context<{ Bindings: Env }>, seconds: number): never {
  c.header("Retry-After", String(seconds));
  throw new ApiError("rate_limited", "a code was sent recently; wait before requesting another");
}

/** Issue the org's `connect_login` code, mirroring /console/login's claim. */
async function issueConnectCode(
  c: Context<{ Bindings: Env }>,
  org: { org_id: string; human_email: string }
): Promise<boolean> {
  const pending = await c.env.DB.prepare(
    "SELECT created_at FROM otp_codes WHERE org_id = ? AND purpose = 'connect_login'"
  )
    .bind(org.org_id)
    .first<{ created_at: string }>();
  const claimedAt = new Date().toISOString();
  let claimed = false;
  let placeholder = false;
  if (pending) {
    const remainingMs =
      OTP_RESEND_COOLDOWN_MS - (Date.now() - new Date(pending.created_at).getTime());
    if (remainingMs > 0) {
      cooldownExceeded(c, Math.ceil(remainingMs / 1000));
    }
    // Claim the cooldown window atomically so concurrent starts cannot each
    // trigger a send: only the request that bumps created_at proceeds.
    const res = await c.env.DB.prepare(
      `UPDATE otp_codes SET created_at = ?
       WHERE org_id = ? AND purpose = 'connect_login' AND created_at = ?`
    )
      .bind(claimedAt, org.org_id, pending.created_at)
      .run();
    claimed = res.meta.changes > 0;
  } else {
    // No code yet: claim by inserting an unverifiable placeholder (already
    // expired, attempts exhausted) that issueOtp will overwrite on success.
    const res = await c.env.DB.prepare(
      `INSERT INTO otp_codes (org_id, purpose, code_hash, attempts, expires_at, created_at)
       VALUES (?, 'connect_login', 'claim', 999, ?, ?)
       ON CONFLICT (org_id, purpose) DO NOTHING`
    )
      .bind(org.org_id, new Date(0).toISOString(), claimedAt)
      .run();
    claimed = res.meta.changes > 0;
    placeholder = claimed;
  }
  if (!claimed) {
    // Another request holds the window; it is sending the code.
    cooldownExceeded(c, Math.ceil(OTP_RESEND_COOLDOWN_MS / 1000));
  }
  const delivered = await issueOtp(c.env, org.org_id, org.human_email, "connect_login");
  if (!delivered) {
    // Release the claim so a failed delivery does not start a cooldown; only
    // touch the row if it still carries our claim timestamp.
    if (placeholder) {
      await c.env.DB.prepare(
        `DELETE FROM otp_codes
         WHERE org_id = ? AND purpose = 'connect_login' AND code_hash = 'claim' AND created_at = ?`
      )
        .bind(org.org_id, claimedAt)
        .run();
    } else if (pending) {
      await c.env.DB.prepare(
        `UPDATE otp_codes SET created_at = ?
         WHERE org_id = ? AND purpose = 'connect_login' AND created_at = ?`
      )
        .bind(pending.created_at, org.org_id, claimedAt)
        .run();
    }
  }
  return delivered;
}

// Step 2 of the consent flow: does this email already have an organization?
// Known emails get a connect_login code; unknown ones are sent to /signup.
connect.post("/connect/start", async (c) => {
  await requireConnectSecret(c);
  const input = await parseBody(c, StartInput);
  const humanEmail = input.email.toLowerCase();
  await throttleCodeSend(c, humanEmail);
  const org = await findOrg(c.env, humanEmail);
  if (!org) {
    return c.json({
      registered: false,
      delivered: false,
      message: `${humanEmail} has no wzrdmail organization yet; pick a username to create one.`
    });
  }
  const delivered = await issueConnectCode(c, org);
  return c.json({
    registered: true,
    delivered,
    message: delivered
      ? `Connection code sent to ${humanEmail}.`
      : `We could not deliver the connection code to ${humanEmail}; try again in a minute.`
  });
});

// Step 3: a brand-new user picks their @wzrd.tech address. Nothing is written
// to D1 until /connect/verify proves ownership of the email, and the pending
// record lives under its own KV prefix so console and connector sign-ups for
// the same email cannot clobber each other.
connect.post("/connect/signup", async (c) => {
  await requireConnectSecret(c);
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
    cooldownExceeded(c, Math.ceil(OTP_RESEND_COOLDOWN_MS / 1000));
  }
  await throttleCodeSend(c, humanEmail);

  const codeHash = await deliverOtp(c.env, humanEmail, "connect_login");
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
        ? `Connection code sent to ${humanEmail}.`
        : `We could not deliver the connection code to ${humanEmail}; try again in a minute.`
  });
});

// Step 4: the code proves ownership of the human email, which both verifies an
// existing org and finalizes a pending sign-up. The reply carries a one-shot
// connect_token: only its SHA-256 is kept (in KV, 600 s), so nothing that can
// mint a key is ever at rest.
connect.post("/connect/verify", async (c) => {
  await requireConnectSecret(c);
  const input = await parseBody(c, VerifyInput);
  const humanEmail = input.email.toLowerCase();
  let org = await findOrg(c.env, humanEmail);
  let newUser = false;
  if (org) {
    const verdict = await checkOtp(c.env, org.org_id, "connect_login", input.otp_code, humanEmail);
    if (verdict !== "ok") {
      if (verdict === "exhausted") {
        throw new ApiError("forbidden", "too many attempts; request a new code");
      }
      if (verdict === "unavailable") {
        throw new ApiError("internal_error", "code verification is temporarily unavailable; try again");
      }
      throw new ApiError("unauthorized", "incorrect email or code");
    }
    // A successful OTP round-trip proves ownership of the org's human email,
    // which is exactly the gate the unverified sandbox checks.
    await c.env.DB.prepare(
      "UPDATE organizations SET verified = 1, updated_at = ? WHERE org_id = ? AND verified = 0"
    )
      .bind(new Date().toISOString(), org.org_id)
      .run();
  } else {
    const pending = await c.env.CACHE.get<PendingSignup>(pendingKey(humanEmail), "json");
    if (!pending) throw new ApiError("unauthorized", "incorrect email or code");
    const verdict = await checkPendingSignup(
      c.env,
      pendingKey(humanEmail),
      humanEmail,
      pending,
      input.otp_code
    );
    if (verdict !== "ok") {
      if (verdict === "exhausted") {
        throw new ApiError("forbidden", "too many attempts; request a new code");
      }
      if (verdict === "unavailable") {
        throw new ApiError("internal_error", "code verification is temporarily unavailable; try again");
      }
      throw new ApiError("unauthorized", "incorrect email or code");
    }
    org = await completeSignup(c.env, humanEmail, pending);
    await c.env.CACHE.delete(pendingKey(humanEmail));
    newUser = true;
  }

  const inboxes = await c.env.DB.prepare(
    `SELECT inbox_id, display_name FROM inboxes
     WHERE org_id = ? AND deleted_at IS NULL
     ORDER BY created_at ASC`
  )
    .bind(org.org_id)
    .all<{ inbox_id: string; display_name: string | null }>();

  const connectToken = randomToken(32);
  const record: ConnectTokenRecord = {
    org_id: org.org_id,
    human_email: org.human_email,
    created_at: new Date().toISOString()
  };
  await c.env.CACHE.put(tokenKey(await hashApiKey(connectToken)), JSON.stringify(record), {
    expirationTtl: CONNECT_TOKEN_TTL_SECONDS
  });

  return c.json({
    connect_token: connectToken,
    organization_id: org.org_id,
    new_user: newUser,
    inboxes: inboxes.results.map((row) => ({
      inbox_id: row.inbox_id,
      display_name: row.display_name
    }))
  });
});

// Step 5: consent granted. The token is spent before the key exists, so a
// replay cannot mint a second key even if the response is lost.
connect.post("/connect/complete", async (c) => {
  await requireConnectSecret(c);
  const input = await parseBody(c, CompleteInput);
  if (input.permissions.includes("admin")) {
    throw new ApiError("validation_error", "admin permissions are not available to connected apps");
  }
  const key = tokenKey(await hashApiKey(input.connect_token));
  const record = await c.env.CACHE.get<ConnectTokenRecord>(key, "json");
  if (!record) {
    throw new ApiError("unauthorized", "this connection has expired; start again");
  }
  // Single use: spend the token before minting, so a replay finds nothing.
  await c.env.CACHE.delete(key);

  const inboxId = input.inbox_id.toLowerCase();
  const inbox = await c.env.DB.prepare(
    `SELECT inbox_id, pod_id FROM inboxes
     WHERE inbox_id = ? AND org_id = ? AND deleted_at IS NULL`
  )
    .bind(inboxId, record.org_id)
    .first<{ inbox_id: string; pod_id: string }>();
  if (!inbox) throw new ApiError("not_found", "no such inbox");

  const minted = await mintApiKey(c.env, {
    org_id: record.org_id,
    pod_id: inbox.pod_id,
    inbox_id: inbox.inbox_id,
    permissions: input.permissions,
    name: input.name,
    source: "oauth",
    client_id: input.client_id ?? null
  });
  return c.json(
    {
      api_key: minted.api_key,
      key_id: minted.key_id,
      inbox_id: inbox.inbox_id,
      organization_id: record.org_id,
      permissions: input.permissions
    },
    201
  );
});
