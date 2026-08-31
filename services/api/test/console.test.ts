import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashApiKey } from "../src/auth.js";
import { NOW, seedInbox } from "./helpers.js";

const app = createApp();

async function seedKey(orgId: string, permissions = "admin"): Promise<string> {
  const key = `wm_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.prepare(
    "INSERT INTO api_keys (key_id, org_id, pod_id, key_hash, key_prefix, permissions, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)"
  )
    .bind(`key_${crypto.randomUUID().slice(0, 8)}`, orgId, await hashApiKey(key), key.slice(0, 12), permissions, NOW)
    .run();
  return key;
}

async function seedConsoleOtp(orgId: string, code: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO otp_codes (org_id, purpose, code_hash, attempts, expires_at, created_at)
     VALUES (?, 'console_login', ?, 0, ?, ?)`
  )
    .bind(orgId, await hashApiKey(code), new Date(Date.now() + 600_000).toISOString(), NOW)
    .run();
}

function authed(key: string, init?: RequestInit): RequestInit {
  return {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }
  };
}

describe("console auth", () => {
  it("login does not reveal whether an email exists", async () => {
    const res = await app.request(
      "/v0/console/login",
      { method: "POST", body: JSON.stringify({ email: "nobody@example.com" }), headers: { "content-type": "application/json" } },
      env
    );
    expect(res.status).toBe(200);
  });

  it("verify with a valid code sets a session cookie usable for /console/session", async () => {
    const seeded = await seedInbox();
    const org = await env.DB.prepare("SELECT human_email FROM organizations WHERE org_id = ?")
      .bind(seeded.org_id)
      .first<{ human_email: string }>();
    await seedConsoleOtp(seeded.org_id, "123456");
    const verify = await app.request(
      "/v0/console/verify",
      {
        method: "POST",
        body: JSON.stringify({ email: org?.human_email, otp_code: "123456" }),
        headers: { "content-type": "application/json" }
      },
      env
    );
    expect(verify.status).toBe(200);
    const cookie = verify.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("wm_session=");
    const token = cookie.split(";")[0] ?? "";
    const session = await app.request(
      "/v0/console/session",
      { headers: { cookie: token } },
      env
    );
    expect(session.status).toBe(200);
    const body = (await session.json()) as { organization_id: string };
    expect(body.organization_id).toBe(seeded.org_id);
  });

  it("verify rejects a wrong code", async () => {
    const seeded = await seedInbox();
    const org = await env.DB.prepare("SELECT human_email FROM organizations WHERE org_id = ?")
      .bind(seeded.org_id)
      .first<{ human_email: string }>();
    await seedConsoleOtp(seeded.org_id, "123456");
    const res = await app.request(
      "/v0/console/verify",
      {
        method: "POST",
        body: JSON.stringify({ email: org?.human_email, otp_code: "999999" }),
        headers: { "content-type": "application/json" }
      },
      env
    );
    expect(res.status).toBe(401);
  });

  it("logout deletes the session", async () => {
    const seeded = await seedInbox();
    const org = await env.DB.prepare("SELECT human_email FROM organizations WHERE org_id = ?")
      .bind(seeded.org_id)
      .first<{ human_email: string }>();
    await seedConsoleOtp(seeded.org_id, "123456");
    const verify = await app.request(
      "/v0/console/verify",
      {
        method: "POST",
        body: JSON.stringify({ email: org?.human_email, otp_code: "123456" }),
        headers: { "content-type": "application/json" }
      },
      env
    );
    const token = (verify.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const out = await app.request(
      "/v0/console/logout",
      { method: "POST", headers: { cookie: token } },
      env
    );
    expect(out.status).toBe(200);
    const after = await app.request("/v0/console/session", { headers: { cookie: token } }, env);
    expect(after.status).toBe(401);
  });
});

describe("api keys", () => {
  it("creates, lists (masked), and revokes a named key", async () => {
    const seeded = await seedInbox();
    const key = await seedKey(seeded.org_id);
    const create = await app.request(
      "/v0/api-keys",
      authed(key, { method: "POST", body: JSON.stringify({ name: "my-agent", permissions: ["read", "send"] }) }),
      env
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as { key_id: string; api_key: string };
    expect(created.api_key).toMatch(/^wm_live_/);

    const list = await app.request("/v0/api-keys", authed(key), env);
    const listed = (await list.json()) as { api_keys: { key_id: string; key_preview: string; name: string | null }[] };
    const mine = listed.api_keys.find((k) => k.key_id === created.key_id);
    expect(mine?.name).toBe("my-agent");
    expect(mine?.key_preview).not.toContain(created.api_key.slice(12));

    const newKeyWorks = await app.request("/v0/inboxes", authed(created.api_key), env);
    expect(newKeyWorks.status).toBe(200);

    const revoke = await app.request(`/v0/api-keys/${created.key_id}`, authed(key, { method: "DELETE" }), env);
    expect(revoke.status).toBe(200);
    const afterRevoke = await app.request("/v0/inboxes", authed(created.api_key), env);
    expect(afterRevoke.status).toBe(401);
  });

  it("requires admin permission", async () => {
    const seeded = await seedInbox();
    const readKey = await seedKey(seeded.org_id, "read");
    const res = await app.request("/v0/api-keys", authed(readKey), env);
    expect(res.status).toBe(403);
  });
});

describe("usage and metrics", () => {
  it("reports plan limits and current counts", async () => {
    const seeded = await seedInbox();
    const key = await seedKey(seeded.org_id);
    const res = await app.request("/v0/usage", authed(key), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plan: string;
      usage: { inboxes: { used: number; limit: number | null } };
    };
    expect(body.plan).toBe("free");
    expect(body.usage.inboxes.used).toBe(1);
    expect(body.usage.inboxes.limit).toBe(3);
  });

  it("aggregates event counts by bucket", async () => {
    const seeded = await seedInbox();
    const key = await seedKey(seeded.org_id);
    await env.DB.prepare(
      "INSERT INTO events (event_id, org_id, pod_id, inbox_id, type, payload, created_at) VALUES (?, ?, ?, ?, 'message.received', '{}', ?)"
    )
      .bind(`evt_${crypto.randomUUID().slice(0, 8)}`, seeded.org_id, seeded.pod_id, seeded.inbox_id, new Date().toISOString())
      .run();
    const res = await app.request("/v0/metrics?period=7d", authed(key), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totals: Record<string, number> };
    expect(body.totals["message.received"]).toBe(1);
  });

  it("rejects an unknown period", async () => {
    const seeded = await seedInbox();
    const key = await seedKey(seeded.org_id);
    const res = await app.request("/v0/metrics?period=1y", authed(key), env);
    expect(res.status).toBe(400);
  });
});
