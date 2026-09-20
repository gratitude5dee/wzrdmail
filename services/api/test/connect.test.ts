import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashApiKey } from "../src/auth.js";
import { seedInbox } from "./helpers.js";

const app = createApp();

const SECRET = "test-connect-secret-0123456789";

/** The API only serves /v0/connect/* once CONNECT_SECRET is provisioned. */
const connectEnv = new Proxy(env, {
  get: (target, prop) => (prop === "CONNECT_SECRET" ? SECRET : Reflect.get(target, prop))
});

async function post(
  path: string,
  body: unknown,
  options?: { secret?: string; provisioned?: boolean; ip?: string }
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const secret = options?.secret === undefined ? SECRET : options.secret;
  if (secret !== "") headers["x-connect-secret"] = secret;
  if (options?.ip) headers["x-wzrdmail-client-ip"] = options.ip;
  return await app.request(
    path,
    { method: "POST", body: JSON.stringify(body), headers },
    options?.provisioned === false ? env : connectEnv
  );
}

function uniqueEmail(tag: string): string {
  return `${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
}

function uniqueUsername(tag: string): string {
  return `${tag}${crypto.randomUUID().slice(0, 8)}`;
}

async function orgEmail(orgId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT human_email FROM organizations WHERE org_id = ?")
    .bind(orgId)
    .first<{ human_email: string }>();
  return row?.human_email ?? "";
}

async function seedOtp(
  orgId: string,
  purpose: "connect_login" | "console_login",
  code: string,
  createdAt = new Date().toISOString()
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO otp_codes (org_id, purpose, code_hash, attempts, expires_at, created_at)
     VALUES (?, ?, ?, 0, ?, ?)
     ON CONFLICT (org_id, purpose) DO UPDATE
       SET code_hash = excluded.code_hash, attempts = 0,
           expires_at = excluded.expires_at, created_at = excluded.created_at`
  )
    .bind(orgId, purpose, await hashApiKey(code), new Date(Date.now() + 600_000).toISOString(), createdAt)
    .run();
}

async function seedPending(prefix: string, email: string, username: string, code: string): Promise<void> {
  const now = new Date();
  await env.CACHE.put(
    `${prefix}${email}`,
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

interface VerifyBody {
  connect_token: string;
  organization_id: string;
  new_user: boolean;
  inboxes: { inbox_id: string; display_name: string | null }[];
}

describe("connect secret gate", () => {
  const routes: [string, unknown][] = [
    ["/v0/connect/start", { email: "someone@example.com" }],
    ["/v0/connect/signup", { email: "someone@example.com", username: "someone" }],
    ["/v0/connect/verify", { email: "someone@example.com", otp_code: "123456" }],
    [
      "/v0/connect/complete",
      { connect_token: "a".repeat(64), inbox_id: "a@wzrd.tech", permissions: ["read"], name: "x" }
    ]
  ];

  it("answers the ordinary 404 envelope when no secret is presented", async () => {
    for (const [path, body] of routes) {
      const res = await post(path, body, { secret: "" });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ name: "not_found", message: "no such endpoint" });
    }
  });

  it("answers 404 for a wrong secret", async () => {
    for (const [path, body] of routes) {
      const res = await post(path, body, { secret: `${SECRET}x` });
      expect(res.status).toBe(404);
    }
  });

  it("answers 404 while CONNECT_SECRET is unset, even with a header", async () => {
    for (const [path, body] of routes) {
      const res = await post(path, body, { provisioned: false });
      expect(res.status).toBe(404);
    }
  });

  it("does not create anything behind a failed gate", async () => {
    const email = uniqueEmail("gated");
    const res = await post("/v0/connect/signup", { email, username: uniqueUsername("gated") }, { secret: "" });
    expect(res.status).toBe(404);
    const org = await env.DB.prepare("SELECT org_id FROM organizations WHERE human_email = ?")
      .bind(email)
      .first();
    expect(org).toBeNull();
  });
});

describe("connect start", () => {
  it("reports an unknown email as unregistered", async () => {
    const res = await post("/v0/connect/start", { email: uniqueEmail("unknown") });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { registered: boolean };
    expect(body.registered).toBe(false);
  });

  it("claims the cooldown for a known email and answers 429 with Retry-After inside it", async () => {
    const seeded = await seedInbox({ address: `cd-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const email = await orgEmail(seeded.org_id);
    const first = await post("/v0/connect/start", { email });
    expect(first.status).toBe(200);
    const body = (await first.json()) as { registered: boolean; delivered: boolean };
    expect(body.registered).toBe(true);
    // No EMAIL binding in tests, so delivery honestly fails and the claim is
    // released; a live code is what starts the cooldown.
    expect(body.delivered).toBe(false);

    await seedOtp(seeded.org_id, "connect_login", "123456");
    const second = await post("/v0/connect/start", { email });
    expect(second.status).toBe(429);
    const retry = Number(second.headers.get("Retry-After"));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(60);
    expect(((await second.json()) as { name: string }).name).toBe("rate_limited");
    // The pending code survives a throttled resend.
    const row = await env.DB.prepare(
      "SELECT code_hash FROM otp_codes WHERE org_id = ? AND purpose = 'connect_login'"
    )
      .bind(seeded.org_id)
      .first<{ code_hash: string }>();
    expect(row?.code_hash).toBe(await hashApiKey("123456"));
  });

  it("caps starts at twenty per forwarded IP per hour", async () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    let limited = false;
    for (let i = 0; i < 21; i++) {
      const res = await post("/v0/connect/start", { email: uniqueEmail(`ipcap${i}`) }, { ip });
      if (res.status === 429) {
        limited = true;
        expect(Number(res.headers.get("Retry-After"))).toBe(3600);
        break;
      }
      expect(res.status).toBe(200);
    }
    expect(limited).toBe(true);
  });

  it("caps codes at five per email per hour", async () => {
    const email = uniqueEmail("capped");
    let limited = false;
    for (let i = 0; i < 6; i++) {
      const res = await post("/v0/connect/start", { email });
      if (res.status === 429) {
        limited = true;
        expect(Number(res.headers.get("Retry-After"))).toBe(3600);
        break;
      }
      expect(res.status).toBe(200);
    }
    expect(limited).toBe(true);
  });
});

describe("connect existing-org path", () => {
  it("start → verify → complete mints an inbox-scoped oauth key", async () => {
    const seeded = await seedInbox({ address: `ex-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const email = await orgEmail(seeded.org_id);
    await env.DB.prepare("UPDATE organizations SET verified = 0 WHERE org_id = ?")
      .bind(seeded.org_id)
      .run();

    const start = await post("/v0/connect/start", { email });
    expect(start.status).toBe(200);
    expect(((await start.json()) as { registered: boolean }).registered).toBe(true);

    await seedOtp(seeded.org_id, "connect_login", "424242");
    const verify = await post("/v0/connect/verify", { email, otp_code: "424242" });
    expect(verify.status).toBe(200);
    const verified = (await verify.json()) as VerifyBody;
    expect(verified.organization_id).toBe(seeded.org_id);
    expect(verified.new_user).toBe(false);
    expect(verified.connect_token).toMatch(/^[0-9a-f]{64}$/);
    expect(verified.inboxes).toEqual([{ inbox_id: seeded.inbox_id, display_name: null }]);
    // The OTP proved ownership of human_email, so the org is verified.
    const org = await env.DB.prepare("SELECT verified FROM organizations WHERE org_id = ?")
      .bind(seeded.org_id)
      .first<{ verified: number }>();
    expect(org?.verified).toBe(1);
    // The code is consumed, not replayable.
    const replay = await post("/v0/connect/verify", { email, otp_code: "424242" });
    expect(replay.status).toBe(401);

    const complete = await post("/v0/connect/complete", {
      connect_token: verified.connect_token,
      inbox_id: seeded.inbox_id,
      permissions: ["read", "send"],
      name: "Muse",
      client_id: "client_muse_test"
    });
    expect(complete.status).toBe(201);
    const minted = (await complete.json()) as {
      api_key: string;
      key_id: string;
      inbox_id: string;
      organization_id: string;
      permissions: string[];
    };
    expect(minted.api_key).toMatch(/^wm_live_/);
    expect(minted.inbox_id).toBe(seeded.inbox_id);
    expect(minted.organization_id).toBe(seeded.org_id);
    expect(minted.permissions).toEqual(["read", "send"]);

    const row = await env.DB.prepare(
      "SELECT org_id, pod_id, inbox_id, permissions, name, source, client_id, key_hash FROM api_keys WHERE key_id = ?"
    )
      .bind(minted.key_id)
      .first<{
        org_id: string;
        pod_id: string | null;
        inbox_id: string | null;
        permissions: string;
        name: string | null;
        source: string;
        client_id: string | null;
        key_hash: string;
      }>();
    expect(row?.org_id).toBe(seeded.org_id);
    expect(row?.pod_id).toBe(seeded.pod_id);
    expect(row?.inbox_id).toBe(seeded.inbox_id);
    expect(row?.permissions).toBe("read,send");
    expect(row?.source).toBe("oauth");
    expect(row?.client_id).toBe("client_muse_test");
    // Only the hash is at rest.
    expect(row?.key_hash).toBe(await hashApiKey(minted.api_key));

    const me = await app.request(
      "/v0/auth/me",
      { headers: { Authorization: `Bearer ${minted.api_key}` } },
      env
    );
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { organization_id: string; permissions: string[] };
    expect(meBody.organization_id).toBe(seeded.org_id);
    expect(meBody.permissions).toEqual(["read", "send"]);
  });

  it("spends the connect token exactly once", async () => {
    const seeded = await seedInbox({ address: `su-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const email = await orgEmail(seeded.org_id);
    await seedOtp(seeded.org_id, "connect_login", "555555");
    const verify = await post("/v0/connect/verify", { email, otp_code: "555555" });
    const { connect_token } = (await verify.json()) as VerifyBody;

    const body = {
      connect_token,
      inbox_id: seeded.inbox_id,
      permissions: ["read"],
      name: "Muse",
      client_id: "client_once"
    };
    expect((await post("/v0/connect/complete", body)).status).toBe(201);
    const replay = await post("/v0/connect/complete", body);
    expect(replay.status).toBe(401);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM api_keys WHERE org_id = ? AND source = 'oauth'"
    )
      .bind(seeded.org_id)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("rejects admin permissions without spending the token", async () => {
    const seeded = await seedInbox({ address: `ad-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const email = await orgEmail(seeded.org_id);
    await seedOtp(seeded.org_id, "connect_login", "666666");
    const verify = await post("/v0/connect/verify", { email, otp_code: "666666" });
    const { connect_token } = (await verify.json()) as VerifyBody;

    const denied = await post("/v0/connect/complete", {
      connect_token,
      inbox_id: seeded.inbox_id,
      permissions: ["read", "admin"],
      name: "Muse",
      client_id: "client_admin"
    });
    expect(denied.status).toBe(400);
    expect(((await denied.json()) as { name: string }).name).toBe("validation_error");

    const allowed = await post("/v0/connect/complete", {
      connect_token,
      inbox_id: seeded.inbox_id,
      permissions: ["read"],
      name: "Muse",
      client_id: "client_admin"
    });
    expect(allowed.status).toBe(201);
  });

  it("refuses an inbox that belongs to another organization", async () => {
    const seeded = await seedInbox({ address: `mi-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const foreign = await seedInbox({ address: `fo-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const email = await orgEmail(seeded.org_id);
    await seedOtp(seeded.org_id, "connect_login", "777777");
    const verify = await post("/v0/connect/verify", { email, otp_code: "777777" });
    const { connect_token } = (await verify.json()) as VerifyBody;

    const res = await post("/v0/connect/complete", {
      connect_token,
      inbox_id: foreign.inbox_id,
      permissions: ["read"],
      name: "Muse",
      client_id: "client_cross"
    });
    expect(res.status).toBe(404);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE org_id = ?")
      .bind(foreign.org_id)
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });
});

describe("connect new-user path", () => {
  it("signup → verify creates a verified org and its @wzrd.tech inbox, then complete mints the key", async () => {
    const email = uniqueEmail("newbie");
    const username = uniqueUsername("newbie");

    const signup = await post("/v0/connect/signup", { email, username });
    expect(signup.status).toBe(200);
    // No EMAIL binding in tests, so delivery honestly fails; either way
    // nothing is written to D1 before verification.
    expect(((await signup.json()) as { delivered: boolean }).delivered).toBe(false);
    expect(
      await env.DB.prepare("SELECT org_id FROM organizations WHERE human_email = ?").bind(email).first()
    ).toBeNull();

    await seedPending("connect_pending:", email, username, "321321");
    const verify = await post("/v0/connect/verify", { email, otp_code: "321321" });
    expect(verify.status).toBe(200);
    const verified = (await verify.json()) as VerifyBody;
    expect(verified.new_user).toBe(true);
    expect(verified.inboxes.map((i) => i.inbox_id)).toEqual([`${username}@wzrd.tech`]);

    const org = await env.DB.prepare(
      "SELECT org_id, verified FROM organizations WHERE human_email = ?"
    )
      .bind(email)
      .first<{ org_id: string; verified: number }>();
    expect(org?.org_id).toBe(verified.organization_id);
    expect(org?.verified).toBe(1);
    const inbox = await env.DB.prepare(
      "SELECT inbox_id, pod_id FROM inboxes WHERE org_id = ?"
    )
      .bind(verified.organization_id)
      .first<{ inbox_id: string; pod_id: string }>();
    expect(inbox?.inbox_id).toBe(`${username}@wzrd.tech`);
    // The pending record is consumed.
    expect(await env.CACHE.get(`connect_pending:${email}`)).toBeNull();

    const complete = await post("/v0/connect/complete", {
      connect_token: verified.connect_token,
      inbox_id: `${username}@wzrd.tech`,
      permissions: ["read", "drafts"],
      name: "Muse",
      client_id: "client_newbie"
    });
    expect(complete.status).toBe(201);
    const minted = (await complete.json()) as { key_id: string; api_key: string };
    const row = await env.DB.prepare(
      "SELECT inbox_id, pod_id, permissions, source, client_id FROM api_keys WHERE key_id = ?"
    )
      .bind(minted.key_id)
      .first<{
        inbox_id: string | null;
        pod_id: string | null;
        permissions: string;
        source: string;
        client_id: string | null;
      }>();
    expect(row?.inbox_id).toBe(`${username}@wzrd.tech`);
    expect(row?.pod_id).toBe(inbox?.pod_id);
    expect(row?.permissions).toBe("read,drafts");
    expect(row?.source).toBe("oauth");
    expect(row?.client_id).toBe("client_newbie");

    // Inbox-scoped: the key cannot reach org-level resources.
    const usage = await app.request(
      "/v0/usage",
      { headers: { Authorization: `Bearer ${minted.api_key}` } },
      env
    );
    expect(usage.status).toBe(403);
  });

  it("rejects an email that already has an organization", async () => {
    const seeded = await seedInbox({ address: `du-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const res = await post("/v0/connect/signup", {
      email: await orgEmail(seeded.org_id),
      username: uniqueUsername("dupe")
    });
    expect(res.status).toBe(409);
  });

  it("keeps its pending record separate from a console sign-up for the same email", async () => {
    const email = uniqueEmail("both");
    const connectName = uniqueUsername("conn");
    const consoleName = uniqueUsername("cons");
    await seedPending("connect_pending:", email, connectName, "111111");
    await seedPending("signup_pending:", email, consoleName, "222222");

    // The connector code does not unlock the console's pending record...
    const wrongLane = await post("/v0/connect/verify", { email, otp_code: "222222" });
    expect(wrongLane.status).toBe(401);

    const verify = await post("/v0/connect/verify", { email, otp_code: "111111" });
    expect(verify.status).toBe(200);
    const verified = (await verify.json()) as VerifyBody;
    expect(verified.inboxes.map((i) => i.inbox_id)).toEqual([`${connectName}@wzrd.tech`]);
    // The console's pending record is untouched.
    const consolePending = await env.CACHE.get<{ username: string }>(`signup_pending:${email}`, "json");
    expect(consolePending?.username).toBe(consoleName);
  });
});

describe("connect_login and console_login coexist", () => {
  it("one organization can hold both codes without clobbering either", async () => {
    const seeded = await seedInbox({ address: `co-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const email = await orgEmail(seeded.org_id);
    await seedOtp(seeded.org_id, "console_login", "100001");
    await seedOtp(seeded.org_id, "connect_login", "200002");

    // A connector code cannot be spent as a console code and vice versa.
    const crossed = await post("/v0/connect/verify", { email, otp_code: "100001" });
    expect(crossed.status).toBe(401);

    const connect = await post("/v0/connect/verify", { email, otp_code: "200002" });
    expect(connect.status).toBe(200);
    // Spending the connector code leaves the console code intact.
    const consoleRow = await env.DB.prepare(
      "SELECT code_hash, attempts FROM otp_codes WHERE org_id = ? AND purpose = 'console_login'"
    )
      .bind(seeded.org_id)
      .first<{ code_hash: string; attempts: number }>();
    expect(consoleRow?.code_hash).toBe(await hashApiKey("100001"));
    expect(consoleRow?.attempts).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT code_hash FROM otp_codes WHERE org_id = ? AND purpose = 'connect_login'"
      )
        .bind(seeded.org_id)
        .first()
    ).toBeNull();

    const consoleLogin = await app.request(
      "/v0/console/verify",
      {
        method: "POST",
        body: JSON.stringify({ email, otp_code: "100001" }),
        headers: { "content-type": "application/json" }
      },
      env
    );
    expect(consoleLogin.status).toBe(200);
  });
});

describe("api key provenance", () => {
  it("lists source and client_id additively on GET /v0/api-keys", async () => {
    const seeded = await seedInbox({ address: `pv-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const adminKey = `wm_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await env.DB.prepare(
      `INSERT INTO api_keys (key_id, org_id, pod_id, key_hash, key_prefix, permissions, created_at)
       VALUES (?, ?, NULL, ?, ?, 'admin', ?)`
    )
      .bind(
        `key_${crypto.randomUUID().slice(0, 8)}`,
        seeded.org_id,
        await hashApiKey(adminKey),
        adminKey.slice(0, 12),
        new Date().toISOString()
      )
      .run();

    await seedOtp(seeded.org_id, "connect_login", "909090");
    const verify = await post("/v0/connect/verify", {
      email: await orgEmail(seeded.org_id),
      otp_code: "909090"
    });
    const { connect_token } = (await verify.json()) as VerifyBody;
    await post("/v0/connect/complete", {
      connect_token,
      inbox_id: seeded.inbox_id,
      permissions: ["read"],
      name: "Muse",
      client_id: "client_listing"
    });

    const list = await app.request(
      "/v0/api-keys",
      { headers: { Authorization: `Bearer ${adminKey}` } },
      env
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      api_keys: { name: string | null; source: string; client_id: string | null; key_preview: string }[];
    };
    const connected = body.api_keys.find((k) => k.source === "oauth");
    expect(connected?.client_id).toBe("client_listing");
    expect(connected?.name).toBe("Muse");
    // The console-minted key defaults to source 'console'.
    expect(body.api_keys.some((k) => k.source === "console")).toBe(true);
  });

  it("marks agent sign-up keys with source 'agent' and throttles the route per IP", async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    const signUp = (n: number) =>
      app.request(
        "/v0/agent/sign-up",
        {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": ip },
          body: JSON.stringify({
            human_email: uniqueEmail(`ag${n}`),
            username: uniqueUsername(`ag${n}`)
          })
        },
        env
      );

    const first = await signUp(0);
    expect(first.status).toBe(201);
    const created = (await first.json()) as { organization_id: string };
    const row = await env.DB.prepare("SELECT source FROM api_keys WHERE org_id = ?")
      .bind(created.organization_id)
      .first<{ source: string }>();
    expect(row?.source).toBe("agent");

    let limited = false;
    for (let i = 1; i < 7; i++) {
      const res = await signUp(i);
      if (res.status === 429) {
        limited = true;
        expect(Number(res.headers.get("Retry-After"))).toBe(3600);
        expect(((await res.json()) as { name: string }).name).toBe("rate_limited");
        break;
      }
    }
    expect(limited).toBe(true);
  });
});
