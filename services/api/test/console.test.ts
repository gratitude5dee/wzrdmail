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
      {
        method: "POST",
        headers: { cookie: token, origin: "https://console.mail.wzrd.tech" }
      },
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

  it("serves the SDK usage contract at /metrics/usage", async () => {
    const seeded = await seedInbox();
    const key = await seedKey(seeded.org_id);
    const res = await app.request("/v0/metrics/usage", authed(key), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      month: string;
      metrics: { metric: string; used: number; limit?: number | null }[];
    };
    expect(body.month).toMatch(/^\d{4}-\d{2}$/);
    const inboxes = body.metrics.find((m) => m.metric === "inboxes");
    expect(inboxes?.used).toBe(1);
    expect(inboxes?.limit).toBe(3);
  });

  it("omits the point-in-time inboxes metric for past months", async () => {
    const seeded = await seedInbox();
    const key = await seedKey(seeded.org_id);
    const res = await app.request("/v0/metrics/usage?month=2020-01", authed(key), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { month: string; metrics: { metric: string }[] };
    expect(body.month).toBe("2020-01");
    expect(body.metrics.find((m) => m.metric === "inboxes")).toBeUndefined();
    expect(body.metrics.find((m) => m.metric === "emails")).toBeDefined();
  });
});

describe("pod-scoped api keys", () => {
  async function seedPodKey(orgId: string, podId: string): Promise<string> {
    const key = `wm_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await env.DB.prepare(
      "INSERT INTO api_keys (key_id, org_id, pod_id, key_hash, key_prefix, permissions, created_at) VALUES (?, ?, ?, ?, ?, 'admin', ?)"
    )
      .bind(`key_${crypto.randomUUID().slice(0, 8)}`, orgId, podId, await hashApiKey(key), key.slice(0, 12), NOW)
      .run();
    return key;
  }

  it("a pod-scoped key cannot mint an org-wide key by omitting pod_id", async () => {
    const seeded = await seedInbox();
    const podKey = await seedPodKey(seeded.org_id, seeded.pod_id);
    const res = await app.request(
      "/v0/api-keys",
      authed(podKey, { method: "POST", body: JSON.stringify({ name: "escalate", permissions: ["admin"] }) }),
      env
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { pod_id: string | null };
    expect(body.pod_id).toBe(seeded.pod_id);
  });

  it("a pod-scoped key cannot mint a key for another pod", async () => {
    const seeded = await seedInbox();
    const other = await seedInbox({ address: "otherpod@wzrd.tech" });
    const podKey = await seedPodKey(seeded.org_id, seeded.pod_id);
    const res = await app.request(
      "/v0/api-keys",
      authed(podKey, {
        method: "POST",
        body: JSON.stringify({ name: "cross-pod", pod_id: other.pod_id, permissions: ["admin"] })
      }),
      env
    );
    expect(res.status).toBe(403);
  });

  it("a pod-scoped key cannot read org-wide usage metrics", async () => {
    const seeded = await seedInbox();
    const podKey = await seedPodKey(seeded.org_id, seeded.pod_id);
    for (const path of ["/v0/usage", "/v0/metrics/usage", "/v0/metrics"]) {
      const res = await app.request(path, authed(podKey), env);
      expect(res.status).toBe(403);
    }
  });
});

describe("csrf protection", () => {
  it("blocks session-cookie writes from untrusted origins", async () => {
    const res = await app.request(
      "/v0/console/logout",
      {
        method: "POST",
        headers: { cookie: "wm_session=wms_bogus", origin: "https://evil.example.com" }
      },
      env
    );
    expect(res.status).toBe(403);
  });

  it("blocks session-cookie writes with no origin header", async () => {
    const res = await app.request(
      "/v0/console/logout",
      { method: "POST", headers: { cookie: "wm_session=wms_bogus" } },
      env
    );
    expect(res.status).toBe(403);
  });

  it("allows session-cookie writes from the console origin", async () => {
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
        headers: { "content-type": "application/json", origin: "https://console.mail.wzrd.tech" }
      },
      env
    );
    expect(verify.status).toBe(200);
    const token = (verify.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const out = await app.request(
      "/v0/console/logout",
      { method: "POST", headers: { cookie: token, origin: "https://console.mail.wzrd.tech" } },
      env
    );
    expect(out.status).toBe(200);
  });

  it("does not affect API-key requests without a session cookie", async () => {
    const seeded = await seedInbox();
    const key = await seedKey(seeded.org_id);
    const res = await app.request(
      "/v0/api-keys",
      authed(key, { method: "POST", body: JSON.stringify({ name: "agent", permissions: ["read"] }) }),
      env
    );
    expect(res.status).toBe(201);
  });
});

describe("console login cooldown claim", () => {
  it("releases the first-time claim when delivery fails (no leftover placeholder)", async () => {
    // No EMAIL binding in tests, so delivery fails; the claimed placeholder
    // row must be removed so a retry is possible immediately.
    const seeded = await seedInbox();
    const org = await env.DB.prepare("SELECT human_email FROM organizations WHERE org_id = ?")
      .bind(seeded.org_id)
      .first<{ human_email: string }>();
    const res = await app.request(
      "/v0/console/login",
      {
        method: "POST",
        body: JSON.stringify({ email: org?.human_email }),
        headers: { "content-type": "application/json" }
      },
      env
    );
    expect(res.status).toBe(200);
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM otp_codes WHERE org_id = ? AND purpose = 'console_login'"
    )
      .bind(seeded.org_id)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("restores the previous cooldown timestamp when a post-cooldown resend fails", async () => {
    const seeded = await seedInbox();
    const org = await env.DB.prepare("SELECT human_email FROM organizations WHERE org_id = ?")
      .bind(seeded.org_id)
      .first<{ human_email: string }>();
    const staleCreatedAt = new Date(Date.now() - 120_000).toISOString();
    await env.DB.prepare(
      `INSERT INTO otp_codes (org_id, purpose, code_hash, attempts, expires_at, created_at)
       VALUES (?, 'console_login', ?, 0, ?, ?)`
    )
      .bind(
        seeded.org_id,
        await hashApiKey("123456"),
        new Date(Date.now() + 600_000).toISOString(),
        staleCreatedAt
      )
      .run();
    const res = await app.request(
      "/v0/console/login",
      {
        method: "POST",
        body: JSON.stringify({ email: org?.human_email }),
        headers: { "content-type": "application/json" }
      },
      env
    );
    expect(res.status).toBe(200);
    // Delivery failed (no EMAIL binding): the old code and its created_at
    // must be intact so the delivered code stays valid with no new cooldown.
    const row = await env.DB.prepare(
      "SELECT code_hash, created_at FROM otp_codes WHERE org_id = ? AND purpose = 'console_login'"
    )
      .bind(seeded.org_id)
      .first<{ code_hash: string; created_at: string }>();
    expect(row?.code_hash).toBe(await hashApiKey("123456"));
    expect(row?.created_at).toBe(staleCreatedAt);
  });

  it("a second login within the cooldown does not overwrite the pending code", async () => {
    const seeded = await seedInbox();
    const org = await env.DB.prepare("SELECT human_email FROM organizations WHERE org_id = ?")
      .bind(seeded.org_id)
      .first<{ human_email: string }>();
    await seedConsoleOtp(seeded.org_id, "123456");
    const before = await env.DB.prepare(
      "SELECT code_hash FROM otp_codes WHERE org_id = ? AND purpose = 'console_login'"
    )
      .bind(seeded.org_id)
      .first<{ code_hash: string }>();
    const res = await app.request(
      "/v0/console/login",
      {
        method: "POST",
        body: JSON.stringify({ email: org?.human_email }),
        headers: { "content-type": "application/json" }
      },
      env
    );
    expect(res.status).toBe(200);
    const after = await env.DB.prepare(
      "SELECT code_hash FROM otp_codes WHERE org_id = ? AND purpose = 'console_login'"
    )
      .bind(seeded.org_id)
      .first<{ code_hash: string }>();
    expect(after?.code_hash).toBe(before?.code_hash);
  });
});
