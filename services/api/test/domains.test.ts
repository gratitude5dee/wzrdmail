import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { hashApiKey } from "../src/auth.js";
import { ingestEmail } from "../src/ingress/pipeline.js";
import { fixtureBuffer, seedInbox, NOW } from "./helpers.js";

const app = createApp();

async function seedOrg(options?: { plan?: string; podId?: boolean }): Promise<{
  org_id: string;
  pod_id: string;
  key: string;
}> {
  const orgId = `org_test_${crypto.randomUUID().slice(0, 8)}`;
  const podId = `pod_test_${crypto.randomUUID().slice(0, 8)}`;
  const key = `wm_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organizations (org_id, name, human_email, plan, verified, created_at, updated_at) VALUES (?, 'test', ?, ?, 1, ?, ?)"
    ).bind(orgId, `${orgId}@example.com`, options?.plan ?? "developer", NOW, NOW),
    env.DB.prepare("INSERT INTO pods (pod_id, org_id, created_at) VALUES (?, ?, ?)").bind(
      podId,
      orgId,
      NOW
    ),
    env.DB.prepare(
      "INSERT INTO api_keys (key_id, org_id, pod_id, key_hash, key_prefix, permissions, created_at) VALUES (?, ?, NULL, ?, ?, 'admin', ?)"
    ).bind(`key_${crypto.randomUUID().slice(0, 8)}`, orgId, await hashApiKey(key), key.slice(0, 12), NOW)
  ]);
  return { org_id: orgId, pod_id: podId, key };
}

function authed(key: string, init?: RequestInit): RequestInit {
  return {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string> | undefined)
    }
  };
}

async function createDomain(key: string, name = "acme.com"): Promise<Record<string, unknown>> {
  const res = await app.request(
    "/v0/domains",
    authed(key, { method: "POST", body: JSON.stringify({ domain: name }) }),
    env
  );
  expect(res.status).toBe(201);
  return (await res.json()) as Record<string, unknown>;
}

interface MockZone {
  ownership?: string[];
  mx?: string[];
  apexTxt?: string[];
  servfail?: boolean;
}

/** Stub global fetch to answer cloudflare-dns.com DoH queries from a fixture map. */
function mockDns(name: string, zone: MockZone): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe("cloudflare-dns.com");
      if (zone.servfail) {
        return Response.json({ Status: 2, Answer: [] });
      }
      const qname = url.searchParams.get("name");
      const qtype = url.searchParams.get("type");
      let answers: { name: string; type: number; data: string }[] = [];
      if (qname === `_wzrdmail.${name}` && qtype === "TXT") {
        answers = (zone.ownership ?? []).map((d) => ({ name: qname, type: 16, data: `"${d}"` }));
      } else if (qname === name && qtype === "MX") {
        answers = (zone.mx ?? []).map((d) => ({ name: qname, type: 15, data: d }));
      } else if (qname === name && qtype === "TXT") {
        answers = (zone.apexTxt ?? []).map((d) => ({ name: qname, type: 16, data: `"${d}"` }));
      }
      return Response.json({ Status: answers.length ? 0 : 3, Answer: answers });
    })
  );
}

function fullZone(token: string): MockZone {
  return {
    ownership: [`wzrdmail-verify=${token}`],
    mx: ["10 route.wzrd.tech."],
    apexTxt: ["v=spf1 include:_spf.wzrd.tech ~all"]
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("domains CRUD (§6.6)", () => {
  it("creates a domain with the required DNS records", async () => {
    const { org_id, key } = await seedOrg();
    const body = await createDomain(key);
    expect(body.organization_id).toBe(org_id);
    expect(body.name).toBe("acme.com");
    expect(body.status).toBe("pending");
    expect(body.verified).toBe(false);
    const records = body.dns_records as { type: string; name: string; value: string }[];
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ type: "TXT", name: "_wzrdmail.acme.com" });
    expect(records[0]!.value).toMatch(/^wzrdmail-verify=[0-9a-f]{32}$/);
    expect(records[1]).toMatchObject({ type: "MX", name: "acme.com", value: "route.wzrd.tech" });
    expect(records[2]!.value).toContain("include:_spf.wzrd.tech");
  });

  it("normalizes case and rejects invalid or platform domains", async () => {
    const { key } = await seedOrg();
    const body = await createDomain(key, "MAIL.Acme.COM.");
    expect(body.name).toBe("mail.acme.com");
    for (const bad of ["not a domain", "wzrd.tech", "sub.wzrd.tech", "-x.com"]) {
      const res = await app.request(
        "/v0/domains",
        authed(key, { method: "POST", body: JSON.stringify({ domain: bad }) }),
        env
      );
      expect(res.status).toBe(400);
    }
  });

  it("rejects duplicate names across organizations", async () => {
    const first = await seedOrg();
    const second = await seedOrg();
    await createDomain(first.key);
    const res = await app.request(
      "/v0/domains",
      authed(second.key, { method: "POST", body: JSON.stringify({ domain: "acme.com" }) }),
      env
    );
    expect(res.status).toBe(409);
  });

  it("enforces the plan's custom-domain limit (free = 0)", async () => {
    const { key } = await seedOrg({ plan: "free" });
    const res = await app.request(
      "/v0/domains",
      authed(key, { method: "POST", body: JSON.stringify({ domain: "acme.com" }) }),
      env
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe("plan_limit_exceeded");
  });

  it("forbids pod-scoped keys from managing domains", async () => {
    const { org_id, pod_id } = await seedOrg();
    const podKey = `wm_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await env.DB.prepare(
      "INSERT INTO api_keys (key_id, org_id, pod_id, key_hash, key_prefix, permissions, created_at) VALUES (?, ?, ?, ?, ?, 'admin', ?)"
    )
      .bind(`key_${crypto.randomUUID().slice(0, 8)}`, org_id, pod_id, await hashApiKey(podKey), podKey.slice(0, 12), NOW)
      .run();
    const res = await app.request(
      "/v0/domains",
      authed(podKey, { method: "POST", body: JSON.stringify({ domain: "acme.com" }) }),
      env
    );
    expect(res.status).toBe(403);
  });

  it("lists with pagination and gets by id; foreign domains 404", async () => {
    const { key } = await seedOrg();
    await createDomain(key, "one.example");
    const created = await createDomain(key, "two.example");
    const list = await app.request("/v0/domains?limit=1", authed(key), env);
    expect(list.status).toBe(200);
    const page = (await list.json()) as { domains: unknown[]; next_page_token: string | null };
    expect(page.domains).toHaveLength(1);
    expect(page.next_page_token).not.toBeNull();

    const get = await app.request(`/v0/domains/${created.domain_id}`, authed(key), env);
    expect(get.status).toBe(200);

    const stranger = await seedOrg();
    const foreign = await app.request(`/v0/domains/${created.domain_id}`, authed(stranger.key), env);
    expect(foreign.status).toBe(404);
  });

  it("deletes a domain, but not while it has active inboxes", async () => {
    const { key } = await seedOrg();
    const created = await createDomain(key);
    const token = ((created.dns_records as { value: string }[])[0]!.value).replace(
      "wzrdmail-verify=",
      ""
    );
    mockDns("acme.com", fullZone(token));
    await app.request(`/v0/domains/${created.domain_id}/verify`, authed(key, { method: "POST" }), env);

    const inboxRes = await app.request(
      "/v0/inboxes",
      authed(key, { method: "POST", body: JSON.stringify({ username: "bot", domain: "acme.com" }) }),
      env
    );
    expect(inboxRes.status).toBe(201);

    const blocked = await app.request(
      `/v0/domains/${created.domain_id}`,
      authed(key, { method: "DELETE" }),
      env
    );
    expect(blocked.status).toBe(409);

    await app.request("/v0/inboxes/bot%40acme.com", authed(key, { method: "DELETE" }), env);
    const deleted = await app.request(
      `/v0/domains/${created.domain_id}`,
      authed(key, { method: "DELETE" }),
      env
    );
    expect(deleted.status).toBe(204);
    const gone = await app.request(`/v0/domains/${created.domain_id}`, authed(key), env);
    expect(gone.status).toBe(404);
  });
});

describe("verification state machine", () => {
  async function verify(key: string, domainId: unknown): Promise<Record<string, unknown>> {
    const res = await app.request(`/v0/domains/${domainId}/verify`, authed(key, { method: "POST" }), env);
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  it("pending → verified when all records resolve, emitting domain.verified once", async () => {
    const { org_id, key } = await seedOrg();
    const created = await createDomain(key);
    const token = ((created.dns_records as { value: string }[])[0]!.value).replace(
      "wzrdmail-verify=",
      ""
    );
    mockDns("acme.com", fullZone(token));
    const body = await verify(key, created.domain_id);
    expect(body.status).toBe("verified");
    expect(body.verified).toBe(true);
    expect(body.failure_reason).toBeNull();
    expect((body.checks as { ok: boolean }[]).every((c) => c.ok)).toBe(true);

    // Idempotent re-verify: still verified, no second event.
    await verify(key, created.domain_id);
    const events = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE org_id = ? AND type = 'domain.verified'"
    )
      .bind(org_id)
      .first<{ n: number }>();
    expect(events?.n).toBe(1);
  });

  it("pending → failed on missing records, with per-check detail, then failed → verified", async () => {
    const { key } = await seedOrg();
    const created = await createDomain(key);
    const token = ((created.dns_records as { value: string }[])[0]!.value).replace(
      "wzrdmail-verify=",
      ""
    );
    mockDns("acme.com", { ownership: [`wzrdmail-verify=${token}`] });
    const failedBody = await verify(key, created.domain_id);
    expect(failedBody.status).toBe("failed");
    expect(failedBody.failure_reason).toContain("MX acme.com");
    const checks = failedBody.checks as { type: string; ok: boolean }[];
    expect(checks.find((c) => c.type === "MX")?.ok).toBe(false);
    expect(checks.find((c) => c.type === "TXT")?.ok).toBe(true);

    mockDns("acme.com", fullZone(token));
    const verifiedBody = await verify(key, created.domain_id);
    expect(verifiedBody.status).toBe("verified");
  });

  it("rejects a wrong ownership token", async () => {
    const { key } = await seedOrg();
    const created = await createDomain(key);
    mockDns("acme.com", { ...fullZone("wrongtoken"), ownership: ["wzrdmail-verify=wrongtoken"] });
    const body = await verify(key, created.domain_id);
    expect(body.status).toBe("failed");
    expect(body.failure_reason).toContain("_wzrdmail.acme.com");
  });

  it("keeps state on resolver failure and returns 500", async () => {
    const { key } = await seedOrg();
    const created = await createDomain(key);
    mockDns("acme.com", { servfail: true });
    const res = await app.request(
      `/v0/domains/${created.domain_id}/verify`,
      authed(key, { method: "POST" }),
      env
    );
    expect(res.status).toBe(500);
    const row = await env.DB.prepare("SELECT status FROM domains WHERE domain_id = ?")
      .bind(created.domain_id)
      .first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });
});

describe("domain-aware inboxes and ingress", () => {
  it("rejects inbox creation on an unverified domain, allows it once verified", async () => {
    const { key } = await seedOrg();
    const created = await createDomain(key);
    const rejected = await app.request(
      "/v0/inboxes",
      authed(key, { method: "POST", body: JSON.stringify({ username: "bot", domain: "acme.com" }) }),
      env
    );
    expect(rejected.status).toBe(400);

    const token = ((created.dns_records as { value: string }[])[0]!.value).replace(
      "wzrdmail-verify=",
      ""
    );
    mockDns("acme.com", fullZone(token));
    await app.request(`/v0/domains/${created.domain_id}/verify`, authed(key, { method: "POST" }), env);

    const ok = await app.request(
      "/v0/inboxes",
      authed(key, { method: "POST", body: JSON.stringify({ username: "bot", domain: "acme.com" }) }),
      env
    );
    expect(ok.status).toBe(201);
    const inbox = (await ok.json()) as { inbox_id: string; domain: string };
    expect(inbox.inbox_id).toBe("bot@acme.com");
    expect(inbox.domain).toBe("acme.com");
  });

  it("does not allow one org to use another org's verified domain", async () => {
    const owner = await seedOrg();
    const created = await createDomain(owner.key);
    const token = ((created.dns_records as { value: string }[])[0]!.value).replace(
      "wzrdmail-verify=",
      ""
    );
    mockDns("acme.com", fullZone(token));
    await app.request(
      `/v0/domains/${created.domain_id}/verify`,
      authed(owner.key, { method: "POST" }),
      env
    );

    const other = await seedOrg();
    const res = await app.request(
      "/v0/inboxes",
      authed(other.key, { method: "POST", body: JSON.stringify({ username: "bot", domain: "acme.com" }) }),
      env
    );
    expect(res.status).toBe(400);
  });

  it("routes inbound mail addressed to a custom-domain inbox", async () => {
    const inbox = await seedInbox({ address: "scout@acme.com" });
    const result = await ingestEmail(env, {
      raw: fixtureBuffer(env.TEST_FIXTURES, "simple.eml"),
      rawKey: `raw/test/${crypto.randomUUID()}.eml`,
      envelopeFrom: "sender@example.com",
      envelopeTo: "Scout@Acme.com"
    });
    expect(result.kind).toBe("stored");
    if (result.kind !== "stored") return;
    const msg = await env.DB.prepare("SELECT inbox_id FROM messages WHERE msg_id = ?")
      .bind(result.msg_id)
      .first<{ inbox_id: string }>();
    expect(msg?.inbox_id).toBe(inbox.inbox_id);
  });
});
