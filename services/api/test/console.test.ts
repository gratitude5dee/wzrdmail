import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const twEnv = new Proxy(env, {
  get: (target, prop) =>
    prop === "THIRDWEB_CLIENT_ID" ? "test-client" : Reflect.get(target, prop)
});

function stubThirdwebMe(status: number, email?: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      email
        ? Response.json(
            { result: { profiles: [{ type: "google", email, emailVerified: true }] } },
            { status }
          )
        : new Response("{}", { status })
    )
  );
}

async function postThirdweb(body: Record<string, string>): Promise<Response> {
  return app.request(
    "/v0/console/thirdweb",
    {
      method: "POST",
      body: JSON.stringify({ token: "tw_token_0123456789abcdef", ...body }),
      headers: { "content-type": "application/json" }
    },
    twEnv
  );
}

describe("console thirdweb exchange", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("signs in an existing org and marks it verified", async () => {
    const seeded = await seedInbox();
    const org = await env.DB.prepare(
      "SELECT human_email FROM organizations WHERE org_id = ?"
    )
      .bind(seeded.org_id)
      .first<{ human_email: string }>();
    stubThirdwebMe(200, org?.human_email);
    const res = await postThirdweb({});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { registered: boolean; organization_id: string };
    expect(body.registered).toBe(true);
    expect(body.organization_id).toBe(seeded.org_id);
    expect(res.headers.get("set-cookie")).toContain("wm_session=");
    const row = await env.DB.prepare("SELECT verified FROM organizations WHERE org_id = ?")
      .bind(seeded.org_id)
      .first<{ verified: number }>();
    expect(row?.verified).toBe(1);
  });

  it("asks for a username when the email is new", async () => {
    stubThirdwebMe(200, "newcomer@example.com");
    const res = await postThirdweb({});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { registered: boolean; email: string };
    expect(body.registered).toBe(false);
    expect(body.email).toBe("newcomer@example.com");
    expect(res.headers.get("set-cookie")).toBeNull();
    const org = await env.DB.prepare(
      "SELECT org_id FROM organizations WHERE human_email = 'newcomer@example.com'"
    ).first();
    expect(org).toBeNull();
  });

  it("creates the org, pod, and inbox when a username is supplied", async () => {
    stubThirdwebMe(200, "maker@example.com");
    const res = await postThirdweb({ username: "MakerBot" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { registered: boolean; organization_id: string };
    expect(body.registered).toBe(true);
    expect(res.headers.get("set-cookie")).toContain("wm_session=");
    const inbox = await env.DB.prepare(
      "SELECT inbox_id, org_id FROM inboxes WHERE username = 'makerbot' AND domain = 'wzrd.tech'"
    ).first<{ inbox_id: string; org_id: string }>();
    expect(inbox?.org_id).toBe(body.organization_id);
    const org = await env.DB.prepare("SELECT verified FROM organizations WHERE org_id = ?")
      .bind(body.organization_id)
      .first<{ verified: number }>();
    expect(org?.verified).toBe(1);
  });

  it("rejects a taken username", async () => {
    const seeded = await seedInbox();
    const inbox = await env.DB.prepare("SELECT username FROM inboxes WHERE inbox_id = ?")
      .bind(seeded.inbox_id)
      .first<{ username: string }>();
    stubThirdwebMe(200, "another@example.com");
    const res = await postThirdweb({ username: inbox?.username ?? "" });
    expect(res.status).toBe(409);
  });

  it("rejects an invalid token", async () => {
    stubThirdwebMe(401);
    const res = await postThirdweb({});
    expect(res.status).toBe(401);
  });

  it("returns a retryable error when thirdweb is unavailable", async () => {
    stubThirdwebMe(503);
    const res = await postThirdweb({});
    expect(res.status).toBe(500);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe("internal_error");
  });
});

describe("thirdweb otp availability", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function seedThirdwebOtp(orgId: string): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO otp_codes (org_id, purpose, code_hash, attempts, expires_at, created_at)
       VALUES (?, 'console_login', 'thirdweb', 0, ?, ?)`
    )
      .bind(orgId, new Date(Date.now() + 600_000).toISOString(), NOW)
      .run();
  }

  it("a transient thirdweb failure does not consume an attempt", async () => {
    const seeded = await seedInbox();
    const org = await env.DB.prepare("SELECT human_email FROM organizations WHERE org_id = ?")
      .bind(seeded.org_id)
      .first<{ human_email: string }>();
    await seedThirdwebOtp(seeded.org_id);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    const res = await app.request(
      "/v0/console/verify",
      {
        method: "POST",
        body: JSON.stringify({ email: org?.human_email, otp_code: "123456" }),
        headers: { "content-type": "application/json" }
      },
      twEnv
    );
    expect(res.status).toBe(500);
    const row = await env.DB.prepare(
      "SELECT attempts FROM otp_codes WHERE org_id = ? AND purpose = 'console_login'"
    )
      .bind(seeded.org_id)
      .first<{ attempts: number }>();
    expect(row?.attempts).toBe(0);
  });

  it("a definitive thirdweb rejection consumes an attempt", async () => {
    const seeded = await seedInbox();
    const org = await env.DB.prepare("SELECT human_email FROM organizations WHERE org_id = ?")
      .bind(seeded.org_id)
      .first<{ human_email: string }>();
    await seedThirdwebOtp(seeded.org_id);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    const res = await app.request(
      "/v0/console/verify",
      {
        method: "POST",
        body: JSON.stringify({ email: org?.human_email, otp_code: "999999" }),
        headers: { "content-type": "application/json" }
      },
      twEnv
    );
    expect(res.status).toBe(401);
    const row = await env.DB.prepare(
      "SELECT attempts FROM otp_codes WHERE org_id = ? AND purpose = 'console_login'"
    )
      .bind(seeded.org_id)
      .first<{ attempts: number }>();
    expect(row?.attempts).toBe(1);
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

describe("console signup", () => {
  const post = (body: object) =>
    app.request(
      "/v0/console/signup",
      { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } },
      env
    );

  async function seedPendingSignup(email: string, username: string, code: string): Promise<void> {
    const now = new Date();
    await env.CACHE.put(
      `signup_pending:${email}`,
      JSON.stringify({
        username,
        org_name: null,
        code_hash: await hashApiKey(code),
        attempts: 0,
        expires_at: new Date(now.getTime() + 600_000).toISOString(),
        created_at: now.toISOString()
      }),
      { expirationTtl: 600 }
    );
  }

  it("does not create any org, pod, or inbox before verification", async () => {
    const email = `human-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const username = `signup${crypto.randomUUID().slice(0, 8)}`;
    const res = await post({ email, username });
    expect(res.status).toBe(200);
    // Local test env has no EMAIL binding, so delivery honestly fails.
    const body = (await res.json()) as { delivered: boolean };
    expect(body.delivered).toBe(false);
    const org = await env.DB.prepare("SELECT org_id FROM organizations WHERE human_email = ?")
      .bind(email)
      .first();
    expect(org).toBeNull();
    const inbox = await env.DB.prepare("SELECT inbox_id FROM inboxes WHERE username = ?")
      .bind(username)
      .first();
    expect(inbox).toBeNull();
  });

  it("rejects an already registered email", async () => {
    const seeded = await seedInbox();
    const org = await env.DB.prepare("SELECT human_email FROM organizations WHERE org_id = ?")
      .bind(seeded.org_id)
      .first<{ human_email: string }>();
    const res = await post({ email: org?.human_email, username: `dupe${crypto.randomUUID().slice(0, 8)}` });
    expect(res.status).toBe(409);
  });

  it("rejects a taken username", async () => {
    const seeded = await seedInbox();
    const inbox = await env.DB.prepare("SELECT username FROM inboxes WHERE org_id = ?")
      .bind(seeded.org_id)
      .first<{ username: string }>();
    const res = await post({
      email: `b-${crypto.randomUUID().slice(0, 8)}@example.com`,
      username: inbox?.username
    });
    expect(res.status).toBe(409);
  });

  it("rejects an invalid username", async () => {
    const res = await post({ email: `c-${crypto.randomUUID().slice(0, 8)}@example.com`, username: "no spaces!" });
    expect(res.status).toBe(400);
  });

  it("verify with a pending signup creates the verified org, pod, and inbox", async () => {
    const email = `v-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const username = `verif${crypto.randomUUID().slice(0, 8)}`;
    await seedPendingSignup(email, username, "654321");
    const verify = await app.request(
      "/v0/console/verify",
      {
        method: "POST",
        body: JSON.stringify({ email, otp_code: "654321" }),
        headers: { "content-type": "application/json" }
      },
      env
    );
    expect(verify.status).toBe(200);
    const body = (await verify.json()) as { organization_id: string };
    const org = await env.DB.prepare("SELECT verified FROM organizations WHERE org_id = ?")
      .bind(body.organization_id)
      .first<{ verified: number }>();
    expect(org?.verified).toBe(1);
    const inbox = await env.DB.prepare("SELECT inbox_id FROM inboxes WHERE org_id = ?")
      .bind(body.organization_id)
      .first<{ inbox_id: string }>();
    expect(inbox?.inbox_id).toBe(`${username}@wzrd.tech`);
    const pod = await env.DB.prepare("SELECT pod_id FROM pods WHERE org_id = ?")
      .bind(body.organization_id)
      .first();
    expect(pod).not.toBeNull();
    // Pending record is consumed: the same code cannot be replayed.
    const replay = await app.request(
      "/v0/console/verify",
      {
        method: "POST",
        body: JSON.stringify({ email, otp_code: "654321" }),
        headers: { "content-type": "application/json" }
      },
      env
    );
    expect(replay.status).toBe(401);
  });

  it("verify with a wrong code does not create anything", async () => {
    const email = `w-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const username = `wrong${crypto.randomUUID().slice(0, 8)}`;
    await seedPendingSignup(email, username, "654321");
    const verify = await app.request(
      "/v0/console/verify",
      {
        method: "POST",
        body: JSON.stringify({ email, otp_code: "111111" }),
        headers: { "content-type": "application/json" }
      },
      env
    );
    expect(verify.status).toBe(401);
    const org = await env.DB.prepare("SELECT org_id FROM organizations WHERE human_email = ?")
      .bind(email)
      .first();
    expect(org).toBeNull();
  });

  it("caps pending-signup verification attempts", async () => {
    const email = `x-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const username = `caps${crypto.randomUUID().slice(0, 8)}`;
    await seedPendingSignup(email, username, "654321");
    for (let i = 0; i < 5; i++) {
      await app.request(
        "/v0/console/verify",
        {
          method: "POST",
          body: JSON.stringify({ email, otp_code: "000000" }),
          headers: { "content-type": "application/json" }
        },
        env
      );
    }
    const res = await app.request(
      "/v0/console/verify",
      {
        method: "POST",
        body: JSON.stringify({ email, otp_code: "654321" }),
        headers: { "content-type": "application/json" }
      },
      env
    );
    expect(res.status).toBe(403);
  });

  it("rate-limits repeated signups from the same IP", async () => {
    const ip = `10.0.0.${Math.floor(Math.random() * 255)}`;
    const request = () =>
      app.request(
        "/v0/console/signup",
        {
          method: "POST",
          body: JSON.stringify({
            email: `r-${crypto.randomUUID().slice(0, 8)}@example.com`,
            username: `rl${crypto.randomUUID().slice(0, 10)}`
          }),
          headers: { "content-type": "application/json", "cf-connecting-ip": ip }
        },
        env
      );
    let limited = false;
    for (let i = 0; i < 12; i++) {
      const res = await request();
      if (res.status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });
});

describe("inbox-scoped api keys", () => {
  async function seedInboxKey(orgId: string, inboxId: string, permissions = "admin"): Promise<string> {
    const key = `wm_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await env.DB.prepare(
      "INSERT INTO api_keys (key_id, org_id, pod_id, inbox_id, key_hash, key_prefix, permissions, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)"
    )
      .bind(`key_${crypto.randomUUID().slice(0, 8)}`, orgId, inboxId, await hashApiKey(key), key.slice(0, 12), permissions, NOW)
      .run();
    return key;
  }

  it("mints an inbox-scoped key that inherits the inbox's pod", async () => {
    const seeded = await seedInbox({ address: `ik1-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const admin = await seedKey(seeded.org_id);
    const res = await app.request(
      "/v0/api-keys",
      authed(admin, {
        method: "POST",
        body: JSON.stringify({ name: "box", inbox_id: seeded.inbox_id, permissions: ["read", "drafts"] })
      }),
      env
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { inbox_id: string; pod_id: string; api_key: string };
    expect(body.inbox_id).toBe(seeded.inbox_id);
    expect(body.pod_id).toBe(seeded.pod_id);

    const list = await app.request("/v0/api-keys", authed(admin), env);
    const listed = (await list.json()) as { api_keys: { inbox_id: string | null }[] };
    expect(listed.api_keys.some((k) => k.inbox_id === seeded.inbox_id)).toBe(true);
  });

  it("rejects inbox_id from another org or a mismatched pod", async () => {
    const seeded = await seedInbox({ address: `ik2-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const foreign = await seedInbox({ address: `ik3-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const admin = await seedKey(seeded.org_id);
    const cross = await app.request(
      "/v0/api-keys",
      authed(admin, { method: "POST", body: JSON.stringify({ name: "x", inbox_id: foreign.inbox_id }) }),
      env
    );
    expect(cross.status).toBe(404);
    const mismatch = await app.request(
      "/v0/api-keys",
      authed(admin, {
        method: "POST",
        body: JSON.stringify({ name: "x", inbox_id: seeded.inbox_id, pod_id: foreign.pod_id })
      }),
      env
    );
    expect(mismatch.status).toBe(404);
  });

  it("an inbox-scoped key only sees and touches its own inbox", async () => {
    const seeded = await seedInbox({ address: `ik4-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const sibling = await seedInbox({ address: `ik5-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    await env.DB.prepare("UPDATE inboxes SET org_id = ?, pod_id = ? WHERE inbox_id = ?")
      .bind(seeded.org_id, seeded.pod_id, sibling.inbox_id)
      .run();
    const inboxKey = await seedInboxKey(seeded.org_id, seeded.inbox_id);

    const list = await app.request("/v0/inboxes", authed(inboxKey), env);
    const listed = (await list.json()) as { inboxes: { inbox_id: string }[] };
    expect(listed.inboxes.map((i) => i.inbox_id)).toEqual([seeded.inbox_id]);

    const own = await app.request(`/v0/inboxes/${encodeURIComponent(seeded.inbox_id)}`, authed(inboxKey), env);
    expect(own.status).toBe(200);
    const other = await app.request(`/v0/inboxes/${encodeURIComponent(sibling.inbox_id)}`, authed(inboxKey), env);
    expect(other.status).toBe(403);
    const otherThreads = await app.request(
      `/v0/inboxes/${encodeURIComponent(sibling.inbox_id)}/threads`,
      authed(inboxKey),
      env
    );
    expect(otherThreads.status).toBe(403);

    const create = await app.request(
      "/v0/inboxes",
      authed(inboxKey, { method: "POST", body: JSON.stringify({ username: "escape" }) }),
      env
    );
    expect(create.status).toBe(403);
    for (const path of ["/v0/usage", "/v0/domains"]) {
      expect((await app.request(path, authed(inboxKey), env)).status).toBe(403);
    }
  });

  it("an inbox-scoped key cannot mint a key for another inbox or widen scope", async () => {
    const seeded = await seedInbox({ address: `ik6-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const sibling = await seedInbox({ address: `ik7-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    await env.DB.prepare("UPDATE inboxes SET org_id = ?, pod_id = ? WHERE inbox_id = ?")
      .bind(seeded.org_id, seeded.pod_id, sibling.inbox_id)
      .run();
    const inboxKey = await seedInboxKey(seeded.org_id, seeded.inbox_id);

    const widen = await app.request(
      "/v0/api-keys",
      authed(inboxKey, { method: "POST", body: JSON.stringify({ name: "widen", permissions: ["admin"] }) }),
      env
    );
    expect(widen.status).toBe(201);
    const widened = (await widen.json()) as { inbox_id: string | null; pod_id: string | null };
    expect(widened.inbox_id).toBe(seeded.inbox_id);
    expect(widened.pod_id).toBe(seeded.pod_id);

    const cross = await app.request(
      "/v0/api-keys",
      authed(inboxKey, { method: "POST", body: JSON.stringify({ name: "cross", inbox_id: sibling.inbox_id }) }),
      env
    );
    expect(cross.status).toBe(403);
  });

  it("an inbox-scoped key cannot see, create, or change org-level webhooks", async () => {
    const seeded = await seedInbox({ address: `ik8-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const admin = await seedKey(seeded.org_id);
    const orgHook = await app.request(
      "/v0/webhooks",
      authed(admin, { method: "POST", body: JSON.stringify({ url: "https://hooks.example.com/org" }) }),
      env
    );
    expect(orgHook.status).toBe(201);
    const hook = (await orgHook.json()) as { webhook_id: string };
    const inboxKey = await seedInboxKey(seeded.org_id, seeded.inbox_id);

    const list = await app.request("/v0/webhooks", authed(inboxKey), env);
    expect(((await list.json()) as { webhooks: unknown[] }).webhooks).toEqual([]);
    for (const path of [
      `/v0/webhooks/${hook.webhook_id}`,
      `/v0/webhooks/${hook.webhook_id}/headers`,
      `/v0/webhooks/${hook.webhook_id}/deliveries`
    ]) {
      expect((await app.request(path, authed(inboxKey), env)).status).toBe(404);
    }
    const patch = await app.request(
      `/v0/webhooks/${hook.webhook_id}`,
      authed(inboxKey, { method: "PATCH", body: JSON.stringify({ enabled: false }) }),
      env
    );
    expect(patch.status).toBe(404);
    const createOrg = await app.request(
      "/v0/webhooks",
      authed(inboxKey, { method: "POST", body: JSON.stringify({ url: "https://hooks.example.com/x" }) }),
      env
    );
    expect(createOrg.status).toBe(403);

    const own = await app.request(
      `/v0/inboxes/${encodeURIComponent(seeded.inbox_id)}/webhooks`,
      authed(inboxKey, { method: "POST", body: JSON.stringify({ url: "https://hooks.example.com/own" }) }),
      env
    );
    expect(own.status).toBe(201);
    const ownHook = (await own.json()) as { webhook_id: string };
    expect((await app.request(`/v0/webhooks/${ownHook.webhook_id}`, authed(inboxKey), env)).status).toBe(200);
  });
});
