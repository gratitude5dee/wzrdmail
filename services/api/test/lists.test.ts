import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashApiKey } from "../src/auth.js";
import { ingestEmail } from "../src/ingress/pipeline.js";
import { fixtureBuffer, seedInbox, NOW } from "./helpers.js";

const app = createApp();

async function seedKey(orgId: string, permissions = "admin"): Promise<string> {
  const key = `wm_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.prepare(
    "INSERT INTO api_keys (key_id, org_id, pod_id, key_hash, key_prefix, permissions, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)"
  )
    .bind(
      `key_${crypto.randomUUID().slice(0, 8)}`,
      orgId,
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
});
