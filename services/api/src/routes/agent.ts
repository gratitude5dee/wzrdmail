import {
  AgentSignUpInput,
  AgentVerifyInput,
  ApiError,
  newId,
  validateUsername
} from "@wzrdmail/core";
import { Hono } from "hono";
import { createMimeMessage } from "mimetext/browser";
import { authenticate, hashApiKey } from "../auth.js";
import { CloudflareEmailProvider } from "../egress/provider.js";
import type { Env } from "../env.js";
import { parseBody } from "../lib/http.js";

export const agent = new Hono<{ Bindings: Env }>();

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const SHARED_DOMAIN = "wzrd.tech";

function randomToken(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomOtp(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String((buf[0] ?? 0) % 1_000_000).padStart(6, "0");
}

/** Stores a fresh OTP and emails it; returns whether delivery succeeded. */
async function issueOtp(env: Env, orgId: string, humanEmail: string): Promise<boolean> {
  const code = randomOtp();
  const now = new Date();
  await env.DB.prepare(
    `INSERT INTO otp_codes (org_id, purpose, code_hash, attempts, expires_at, created_at)
     VALUES (?, 'agent_verify', ?, 0, ?, ?)
     ON CONFLICT (org_id, purpose) DO UPDATE
       SET code_hash = excluded.code_hash, attempts = 0,
           expires_at = excluded.expires_at, created_at = excluded.created_at`
  )
    .bind(
      orgId,
      await hashApiKey(code),
      new Date(now.getTime() + OTP_TTL_MS).toISOString(),
      now.toISOString()
    )
    .run();

  const mime = createMimeMessage();
  const from = `noreply@${SHARED_DOMAIN}`;
  mime.setSender(from);
  mime.setTo(humanEmail);
  mime.setSubject("Your wzrdmail verification code");
  mime.setHeader("Message-ID", `<${newId("msg")}@${SHARED_DOMAIN}>`);
  mime.addMessage({
    contentType: "text/plain",
    data: `Your wzrdmail verification code is: ${code}\n\nIt expires in 10 minutes. If you didn't request this, ignore this email.`
  });
  const provider = new CloudflareEmailProvider(env);
  try {
    await provider.send({ from, to: [humanEmail.toLowerCase()], raw: mime.asRaw() });
    return true;
  } catch (err) {
    console.error(JSON.stringify({ msg: "otp_send_failed", org_id: orgId, error: String(err) }));
    return false;
  }
}

agent.post("/agent/sign-up", async (c) => {
  const input = await parseBody(c, AgentSignUpInput);
  const humanEmail = input.human_email.toLowerCase();
  const verdict = validateUsername(input.username);
  if (!verdict.ok) {
    throw new ApiError("validation_error", `username is ${verdict.reason}`);
  }

  const existingOrg = await c.env.DB.prepare(
    "SELECT org_id FROM organizations WHERE human_email = ?"
  )
    .bind(humanEmail)
    .first<{ org_id: string }>();
  if (existingOrg) {
    throw new ApiError("conflict", "this email is already registered");
  }
  const inboxId = `${verdict.username}@${SHARED_DOMAIN}`;
  const existingInbox = await c.env.DB.prepare(
    "SELECT inbox_id FROM inboxes WHERE username = ? AND domain = ?"
  )
    .bind(verdict.username, SHARED_DOMAIN)
    .first<{ inbox_id: string }>();
  if (existingInbox) {
    throw new ApiError("conflict", "this username is taken");
  }

  const orgId = newId("org");
  const podId = newId("pod");
  const keyId = newId("key");
  const apiKey = `wm_live_${randomToken(24)}`;
  const now = new Date().toISOString();

  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO organizations (org_id, name, plan, human_email, verified, created_at, updated_at)
         VALUES (?, ?, 'free', ?, 0, ?, ?)`
      ).bind(orgId, verdict.username, humanEmail, now, now),
      c.env.DB.prepare(
        "INSERT INTO pods (pod_id, org_id, name, created_at) VALUES (?, ?, 'default', ?)"
      ).bind(podId, orgId, now),
      c.env.DB.prepare(
        `INSERT INTO api_keys (key_id, org_id, pod_id, key_hash, key_prefix, permissions, created_at)
         VALUES (?, ?, NULL, ?, ?, 'admin', ?)`
      ).bind(keyId, orgId, await hashApiKey(apiKey), apiKey.slice(0, 12), now),
      c.env.DB.prepare(
        `INSERT INTO inboxes (inbox_id, org_id, pod_id, username, domain, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(inboxId, orgId, podId, verdict.username, SHARED_DOMAIN, now, now)
    ]);
  } catch (err) {
    if (String(err).includes("UNIQUE")) {
      throw new ApiError("conflict", "this email or username is already registered");
    }
    throw err;
  }

  const delivered = await issueOtp(c.env, orgId, humanEmail);

  return c.json(
    {
      api_key: apiKey,
      inbox_id: inboxId,
      organization_id: orgId,
      pod_id: podId,
      verified: false,
      message: delivered
        ? `Verification code sent to ${humanEmail}. POST /v0/agent/verify with {"otp_code": "…"} to unlock external sending.`
        : `We could not deliver the verification code to ${humanEmail}. POST /v0/agent/verify/resend to try again.`
    },
    201
  );
});

agent.post("/agent/verify/resend", async (c) => {
  const auth = await authenticate(c);
  if (auth.org_verified) {
    throw new ApiError("conflict", "organization is already verified");
  }
  const delivered = await issueOtp(c.env, auth.org_id, auth.human_email);
  if (!delivered) {
    throw new ApiError("internal_error", "could not deliver the verification code; try again later");
  }
  return c.json({ organization_id: auth.org_id, message: `Verification code sent to ${auth.human_email}.` });
});

agent.post("/agent/verify", async (c) => {
  const auth = await authenticate(c);
  const input = await parseBody(c, AgentVerifyInput);
  const row = await c.env.DB.prepare(
    "SELECT code_hash, expires_at FROM otp_codes WHERE org_id = ? AND purpose = 'agent_verify'"
  )
    .bind(auth.org_id)
    .first<{ code_hash: string; expires_at: string }>();
  if (!row) throw new ApiError("not_found", "no pending verification code");
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new ApiError("forbidden", "verification code expired");
  }
  // Consume an attempt atomically before comparing, so concurrent guesses
  // cannot all pass the limit check on a shared snapshot.
  const consumed = await c.env.DB.prepare(
    `UPDATE otp_codes SET attempts = attempts + 1
     WHERE org_id = ? AND purpose = 'agent_verify' AND attempts < ?`
  )
    .bind(auth.org_id, OTP_MAX_ATTEMPTS)
    .run();
  if (consumed.meta.changes === 0) {
    throw new ApiError("forbidden", "too many attempts; request a new code");
  }
  const matches = row.code_hash === (await hashApiKey(input.otp_code));
  if (!matches) {
    throw new ApiError("validation_error", "incorrect verification code");
  }
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE organizations SET verified = 1, updated_at = ? WHERE org_id = ?"
    ).bind(now, auth.org_id),
    c.env.DB.prepare(
      "DELETE FROM otp_codes WHERE org_id = ? AND purpose = 'agent_verify'"
    ).bind(auth.org_id)
  ]);
  return c.json({ organization_id: auth.org_id, verified: true });
});

agent.get("/auth/me", async (c) => {
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
    key_id: auth.key_id,
    organization_id: org.org_id,
    pod_id: auth.pod_id,
    permissions: auth.permissions.split(",").map((p) => p.trim()),
    organization: {
      organization_id: org.org_id,
      name: org.name,
      plan: org.plan,
      verified: org.verified === 1,
      human_email: org.human_email,
      created_at: org.created_at
    }
  });
});

agent.get("/organizations/:org_id", async (c) => {
  const auth = await authenticate(c);
  const orgId = c.req.param("org_id");
  if (orgId !== auth.org_id) throw new ApiError("not_found", "no such organization");
  const org = await c.env.DB.prepare(
    "SELECT org_id, name, plan, verified, human_email, created_at, updated_at FROM organizations WHERE org_id = ?"
  )
    .bind(orgId)
    .first<{
      org_id: string;
      name: string;
      plan: string;
      verified: number;
      human_email: string;
      created_at: string;
      updated_at: string;
    }>();
  if (!org) throw new ApiError("not_found", "no such organization");
  return c.json({
    organization_id: org.org_id,
    name: org.name,
    plan: org.plan,
    verified: org.verified === 1,
    human_email: org.human_email,
    created_at: org.created_at,
    updated_at: org.updated_at
  });
});
