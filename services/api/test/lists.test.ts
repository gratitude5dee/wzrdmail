import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashApiKey } from "../src/auth.js";
import { ingestEmail } from "../src/ingress/pipeline.js";
import { fixtureBuffer, seedInbox, NOW } from "./helpers.js";

const app = createApp();

async function seedKey(
  orgId: string,
  permissions = "admin",
  podId: string | null = null
): Promise<string> {
  const key = `wm_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.prepare(
    "INSERT INTO api_keys (key_id, org_id, pod_id, key_hash, key_prefix, permissions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(
      `key_${crypto.randomUUID().slice(0, 8)}`,
      orgId,
      podId,
      await hashApiKey(key),
      key.slice(0, 12),
      permissions,
      NOW
    )
    .run();
  return key;
}

function authed(key: string, init?: RequestInit): RequestInit {
  return {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }
  };
}

async function createEntry(
  key: string,
  body: Record<string, unknown>
): Promise<Response> {
  return app.request("/v0/lists", authed(key, { method: "POST", body: JSON.stringify(body) }), env);
}

// simple.eml is From: ada@example.com
function ingest(envelopeFrom = "ada@example.com", envelopeTo = "scout@wzrd.tech") {
  return ingestEmail(env, {
    raw: fixtureBuffer(env.TEST_FIXTURES, "simple.eml"),
    rawKey: `raw/test/${crypto.randomUUID()}.eml`,
    envelopeFrom,
    envelopeTo
  });
}

describe("allow/block list API", () => {
  it("creates, lists, filters, and deletes entries", async () => {
    const inbox = await seedInbox();
    const key = await seedKey(inbox.org_id);

    const created = await createEntry(key, { kind: "block", pattern: "Spammer@Evil.com" });
    expect(created.status).toBe(201);
    const entry = (await created.json()) as { entry_id: string; pattern: string; inbox_id: string | null };
    expect(entry.entry_id).toMatch(/^lst_/);
    expect(entry.pattern).toBe("spammer@evil.com");
    expect(entry.inbox_id).toBeNull();

    const scoped = await createEntry(key, {
      kind: "allow",
      pattern: "@partner.com",
      inbox_id: inbox.inbox_id
    });
    expect(scoped.status).toBe(201);

    const all = await app.request("/v0/lists", authed(key), env);
    expect(all.status).toBe(200);
    const listBody = (await all.json()) as { list_entries: unknown[]; next_page_token: string | null };
    expect(listBody.list_entries).toHaveLength(2);
    expect(listBody.next_page_token).toBeNull();

    const allowOnly = await app.request("/v0/lists?kind=allow", authed(key), env);
    const allowBody = (await allowOnly.json()) as { list_entries: { kind: string }[] };
    expect(allowBody.list_entries).toHaveLength(1);
    expect(allowBody.list_entries[0]?.kind).toBe("allow");

    const byInbox = await app.request(
      `/v0/lists?inbox_id=${encodeURIComponent(inbox.inbox_id)}`,
      authed(key),
      env
    );
    const inboxBody = (await byInbox.json()) as { list_entries: { pattern: string }[] };
    expect(inboxBody.list_entries).toHaveLength(1);
    expect(inboxBody.list_entries[0]?.pattern).toBe("@partner.com");

    const del = await app.request(
      `/v0/lists/${entry.entry_id}`,
      authed(key, { method: "DELETE" }),
      env
    );
    expect(del.status).toBe(204);
    const delAgain = await app.request(
      `/v0/lists/${entry.entry_id}`,
      authed(key, { method: "DELETE" }),
      env
    );
    expect(delAgain.status).toBe(404);
  });

  it("rejects invalid patterns and kinds", async () => {
    const inbox = await seedInbox();
    const key = await seedKey(inbox.org_id);
    for (const pattern of ["not-an-address", "@", "@nodot", "a b@c.com"]) {
      const res = await createEntry(key, { kind: "block", pattern });
      expect(res.status).toBe(400);
    }
    const badKind = await createEntry(key, { kind: "deny", pattern: "a@b.com" });
    expect(badKind.status).toBe(400);
    const badFilter = await app.request("/v0/lists?kind=deny", authed(key), env);
    expect(badFilter.status).toBe(400);
  });

  it("rejects duplicate entries in the same scope with 409", async () => {
    const inbox = await seedInbox();
    const key = await seedKey(inbox.org_id);
    expect((await createEntry(key, { kind: "block", pattern: "@spam.com" })).status).toBe(201);
    expect((await createEntry(key, { kind: "block", pattern: "@spam.com" })).status).toBe(409);
    // Same pattern in a different scope is a distinct entry.
    const scoped = await createEntry(key, {
      kind: "block",
      pattern: "@spam.com",
      inbox_id: inbox.inbox_id
    });
    expect(scoped.status).toBe(201);
  });

  it("scopes entries to the key's org", async () => {
    const a = await seedInbox({ address: "a@wzrd.tech" });
    const b = await seedInbox({ address: "b@wzrd.tech" });
    const keyA = await seedKey(a.org_id);
    const keyB = await seedKey(b.org_id);
    const created = await createEntry(keyA, { kind: "block", pattern: "x@y.com" });
    const entry = (await created.json()) as { entry_id: string };

    const foreignList = await app.request("/v0/lists", authed(keyB), env);
    const body = (await foreignList.json()) as { list_entries: unknown[] };
    expect(body.list_entries).toHaveLength(0);

    const foreignDelete = await app.request(
      `/v0/lists/${entry.entry_id}`,
      authed(keyB, { method: "DELETE" }),
      env
    );
    expect(foreignDelete.status).toBe(404);
  });

  it("requires admin permission for writes", async () => {
    const inbox = await seedInbox();
    const readKey = await seedKey(inbox.org_id, "read");
    const res = await createEntry(readKey, { kind: "block", pattern: "a@b.com" });
    expect(res.status).toBe(403);
  });

  it("serves a single entry by id", async () => {
    const inbox = await seedInbox();
    const key = await seedKey(inbox.org_id);
    const created = await createEntry(key, { kind: "block", pattern: "x@y.com" });
    const entry = (await created.json()) as { entry_id: string };

    const got = await app.request(`/v0/lists/${entry.entry_id}`, authed(key), env);
    expect(got.status).toBe(200);
    const body = (await got.json()) as { entry_id: string; pattern: string };
    expect(body.entry_id).toBe(entry.entry_id);
    expect(body.pattern).toBe("x@y.com");

    const other = await seedInbox({ address: "other@wzrd.tech" });
    const foreignKey = await seedKey(other.org_id);
    const foreign = await app.request(`/v0/lists/${entry.entry_id}`, authed(foreignKey), env);
    expect(foreign.status).toBe(404);
  });

  it("exposes inbox-scoped mirror routes", async () => {
    const inbox = await seedInbox();
    const key = await seedKey(inbox.org_id);
    const base = `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/lists`;

    const created = await app.request(
      base,
      authed(key, { method: "POST", body: JSON.stringify({ kind: "allow", pattern: "@partner.com" }) }),
      env
    );
    expect(created.status).toBe(201);
    const entry = (await created.json()) as { entry_id: string; inbox_id: string | null };
    expect(entry.inbox_id).toBe(inbox.inbox_id);

    // An org-wide entry is not visible through the inbox-scoped collection.
    await createEntry(key, { kind: "block", pattern: "@spam.net" });
    const listed = await app.request(base, authed(key), env);
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as { list_entries: { entry_id: string }[] };
    expect(listBody.list_entries).toHaveLength(1);
    expect(listBody.list_entries[0]?.entry_id).toBe(entry.entry_id);

    const got = await app.request(`${base}/${entry.entry_id}`, authed(key), env);
    expect(got.status).toBe(200);

    const orgWide = await app.request("/v0/lists", authed(key), env);
    const orgBody = (await orgWide.json()) as { list_entries: { entry_id: string; inbox_id: string | null }[] };
    const orgEntry = orgBody.list_entries.find((e) => e.inbox_id === null);
    // A different scope's entry 404s through the inbox path.
    const wrongScope = await app.request(`${base}/${orgEntry?.entry_id}`, authed(key), env);
    expect(wrongScope.status).toBe(404);

    const del = await app.request(`${base}/${entry.entry_id}`, authed(key, { method: "DELETE" }), env);
    expect(del.status).toBe(204);
  });

  it("restricts pod-scoped keys to their pod and forbids org-wide writes", async () => {
    const inbox = await seedInbox();
    const orgKey = await seedKey(inbox.org_id);
    const podKey = await seedKey(inbox.org_id, "admin", inbox.pod_id);
    const otherPodId = `pod_test_${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.prepare("INSERT INTO pods (pod_id, org_id, created_at) VALUES (?, ?, ?)")
      .bind(otherPodId, inbox.org_id, NOW)
      .run();
    const otherPodKey = await seedKey(inbox.org_id, "admin", otherPodId);

    // Org-wide create/delete require an org-scoped key.
    const orgWideCreate = await createEntry(podKey, { kind: "block", pattern: "@spam.net" });
    expect(orgWideCreate.status).toBe(403);
    const orgWide = await createEntry(orgKey, { kind: "block", pattern: "@spam.net" });
    const orgEntry = (await orgWide.json()) as { entry_id: string };
    const orgWideDelete = await app.request(
      `/v0/lists/${orgEntry.entry_id}`,
      authed(podKey, { method: "DELETE" }),
      env
    );
    expect(orgWideDelete.status).toBe(403);

    // Inbox-scoped entries work within the key's pod but not from another pod.
    const scoped = await createEntry(podKey, {
      kind: "allow",
      pattern: "@partner.com",
      inbox_id: inbox.inbox_id
    });
    expect(scoped.status).toBe(201);
    const scopedEntry = (await scoped.json()) as { entry_id: string };

    const foreignCreate = await createEntry(otherPodKey, {
      kind: "allow",
      pattern: "@other.com",
      inbox_id: inbox.inbox_id
    });
    expect(foreignCreate.status).toBe(403);
    const foreignDelete = await app.request(
      `/v0/lists/${scopedEntry.entry_id}`,
      authed(otherPodKey, { method: "DELETE" }),
      env
    );
    expect(foreignDelete.status).toBe(403);

    // Pod keys see org-wide entries plus their own pod's inbox entries only.
    const listed = await app.request("/v0/lists", authed(otherPodKey), env);
    const body = (await listed.json()) as { list_entries: { inbox_id: string | null }[] };
    expect(body.list_entries).toHaveLength(1);
    expect(body.list_entries[0]?.inbox_id).toBeNull();

    const podDelete = await app.request(
      `/v0/lists/${scopedEntry.entry_id}`,
      authed(podKey, { method: "DELETE" }),
      env
    );
    expect(podDelete.status).toBe(204);
  });
});

describe("ingress enforcement", () => {
  async function addEntry(
    org_id: string,
    kind: "allow" | "block",
    pattern: string,
    inbox_id: string | null = null
  ): Promise<void> {
    await env.DB.prepare(
      "INSERT INTO list_entries (entry_id, org_id, inbox_id, kind, pattern, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(`lst_${crypto.randomUUID().slice(0, 8)}`, org_id, inbox_id, kind, pattern, NOW)
      .run();
  }

  async function expectNoMessagesAndRejectedEvent(org_id: string): Promise<void> {
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE org_id = ?")
      .bind(org_id)
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
    const event = await env.DB.prepare(
      "SELECT payload FROM events WHERE org_id = ? AND type = 'message.rejected'"
    )
      .bind(org_id)
      .first<{ payload: string }>();
    expect(event).not.toBeNull();
  }

  it("blocks an exact sender address and records an event without a message row", async () => {
    const inbox = await seedInbox();
    await addEntry(inbox.org_id, "block", "ada@example.com");
    const result = await ingest();
    expect(result).toEqual({ kind: "blocked", reason: "block_entry" });
    await expectNoMessagesAndRejectedEvent(inbox.org_id);
  });

  it("blocks a whole sender domain", async () => {
    const inbox = await seedInbox();
    await addEntry(inbox.org_id, "block", "@example.com");
    const result = await ingest();
    expect(result).toEqual({ kind: "blocked", reason: "block_entry" });
    await expectNoMessagesAndRejectedEvent(inbox.org_id);
  });

  it("delivers when no entry matches", async () => {
    const inbox = await seedInbox();
    await addEntry(inbox.org_id, "block", "@other.com");
    const result = await ingest();
    expect(result.kind).toBe("stored");
  });

  it("allowlist mode: only allowed senders are delivered", async () => {
    const inbox = await seedInbox();
    await addEntry(inbox.org_id, "allow", "friend@example.com");
    const blocked = await ingest();
    expect(blocked).toEqual({ kind: "blocked", reason: "not_allowlisted" });
    await expectNoMessagesAndRejectedEvent(inbox.org_id);

    await addEntry(inbox.org_id, "allow", "ada@example.com");
    const stored = await ingest();
    expect(stored.kind).toBe("stored");
  });

  it("inbox-level allow overrides an org-level block", async () => {
    const inbox = await seedInbox();
    await addEntry(inbox.org_id, "block", "@example.com");
    await addEntry(inbox.org_id, "allow", "ada@example.com", inbox.inbox_id);
    const result = await ingest();
    expect(result.kind).toBe("stored");
  });

  it("inbox-level block applies alongside org-level entries", async () => {
    const inbox = await seedInbox();
    await addEntry(inbox.org_id, "allow", "ada@example.com");
    await addEntry(inbox.org_id, "block", "ada@example.com", inbox.inbox_id);
    const result = await ingest();
    expect(result).toEqual({ kind: "blocked", reason: "block_entry" });
  });

  it("org-level entries do not affect other orgs' inboxes", async () => {
    const other = await seedInbox({ address: "other@wzrd.tech" });
    const inbox = await seedInbox();
    await addEntry(other.org_id, "block", "ada@example.com");
    const result = await ingest("ada@example.com", inbox.inbox_id);
    expect(result.kind).toBe("stored");
  });

  it("DSN reports bypass allowlist mode (empty envelope sender)", async () => {
    const inbox = await seedInbox();
    await addEntry(inbox.org_id, "allow", "friend@example.com");
    const result = await ingestEmail(env, {
      raw: fixtureBuffer(env.TEST_FIXTURES, "dsn-bounce.eml"),
      rawKey: `raw/test/${crypto.randomUUID()}.eml`,
      envelopeFrom: "",
      envelopeTo: inbox.inbox_id
    });
    expect(result).toEqual({ kind: "dsn", event: "message.bounced" });
    const suppression = await env.DB.prepare(
      "SELECT reason FROM suppressions WHERE org_id = ? AND address = 'gone@nowhere.example.com'"
    )
      .bind(inbox.org_id)
      .first<{ reason: string }>();
    expect(suppression?.reason).toBe("bounce");
  });

  it("ARF reports bypass a blocklisted reporter domain", async () => {
    const inbox = await seedInbox();
    await addEntry(inbox.org_id, "block", "@freemail.example.org");
    const result = await ingestEmail(env, {
      raw: fixtureBuffer(env.TEST_FIXTURES, "arf-complaint.eml"),
      rawKey: `raw/test/${crypto.randomUUID()}.eml`,
      envelopeFrom: "complaints@freemail.example.org",
      envelopeTo: inbox.inbox_id
    });
    expect(result).toEqual({ kind: "dsn", event: "message.complained" });
  });
});

describe("AgentMail-compatible receive/block aliases", () => {
  it("adds, lists, and removes block entries by pattern and by id", async () => {
    const inbox = await seedInbox({ address: `blk-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const base = `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/lists/receive/block`;

    const byPattern = await app.request(
      base,
      authed(key, { method: "POST", body: JSON.stringify({ pattern: "Spam@Example.com" }) }),
      env
    );
    expect(byPattern.status).toBe(201);
    const entry = (await byPattern.json()) as { entry_id: string; kind: string; pattern: string; inbox_id: string };
    expect(entry.kind).toBe("block");
    expect(entry.pattern).toBe("spam@example.com");
    expect(entry.inbox_id).toBe(inbox.inbox_id);

    const byDomain = await app.request(
      base,
      authed(key, { method: "POST", body: JSON.stringify({ domain: "junk.example" }) }),
      env
    );
    expect(byDomain.status).toBe(201);
    expect(((await byDomain.json()) as { pattern: string }).pattern).toBe("@junk.example");

    const missing = await app.request(base, authed(key, { method: "POST", body: JSON.stringify({}) }), env);
    expect(missing.status).toBe(400);

    const list = await app.request(base, authed(key), env);
    const listed = (await list.json()) as { list_entries: { pattern: string; kind: string }[] };
    expect(listed.list_entries.every((e) => e.kind === "block")).toBe(true);
    expect(listed.list_entries.map((e) => e.pattern).sort()).toEqual(["@junk.example", "spam@example.com"]);

    // native /lists still sees the same rows
    const native = await app.request(
      `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/lists?kind=block`,
      authed(key),
      env
    );
    expect(((await native.json()) as { list_entries: unknown[] }).list_entries).toHaveLength(2);

    const delByPattern = await app.request(
      `${base}/${encodeURIComponent("spam@example.com")}`,
      authed(key, { method: "DELETE" }),
      env
    );
    expect(delByPattern.status).toBe(204);
    const remaining = (await (await app.request(base, authed(key), env)).json()) as {
      list_entries: { entry_id: string }[];
    };
    const delById = await app.request(
      `${base}/${remaining.list_entries[0]!.entry_id}`,
      authed(key, { method: "DELETE" }),
      env
    );
    expect(delById.status).toBe(204);
    const gone = await app.request(`${base}/${encodeURIComponent("nobody@example.com")}`, authed(key, { method: "DELETE" }), env);
    expect(gone.status).toBe(404);
    const empty = (await (await app.request(base, authed(key), env)).json()) as { list_entries: unknown[] };
    expect(empty.list_entries).toHaveLength(0);
  });
});
