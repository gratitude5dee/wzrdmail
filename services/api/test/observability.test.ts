import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashApiKey } from "../src/auth.js";
import { emitEvent } from "../src/lib/events.js";
import { seedInbox, NOW } from "./helpers.js";

const app = createApp();

async function seedKey(orgId: string, permissions = "admin"): Promise<string> {
  const key = `wm_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.prepare(
    "INSERT INTO api_keys (key_id, org_id, key_hash, key_prefix, permissions, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(`key_${crypto.randomUUID().slice(0, 8)}`, orgId, await hashApiKey(key), key.slice(0, 12), permissions, NOW)
    .run();
  return key;
}

function authed(key: string, init?: RequestInit): RequestInit {
  return {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }
  };
}

async function seedMessage(
  inbox: { org_id: string; pod_id: string; inbox_id: string },
  overrides?: { subject?: string; text?: string; html?: string }
): Promise<string> {
  const msgId = `msg_${crypto.randomUUID().slice(0, 12)}`;
  const threadId = `thread_${crypto.randomUUID().slice(0, 12)}`;
  await env.DB.prepare(
    `INSERT INTO threads (thread_id, org_id, pod_id, inbox_id, subject, normalized_subject, preview, last_message_at, message_count, labels, deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, '[]', NULL, ?, ?)`
  )
    .bind(threadId, inbox.org_id, inbox.pod_id, inbox.inbox_id,
      overrides?.subject ?? "Hello", (overrides?.subject ?? "hello").toLowerCase(),
      overrides?.text ?? "hi", NOW, NOW, NOW)
    .run();
  await env.DB.prepare(
    `INSERT INTO messages (msg_id, org_id, pod_id, inbox_id, thread_id, direction, state, from_addr, to_addrs, subject, text, html, labels, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'inbound', 'received', ?, ?, ?, ?, ?, '[]', ?, ?)`
  )
    .bind(
      msgId, inbox.org_id, inbox.pod_id, inbox.inbox_id, threadId,
      "sender@example.com", JSON.stringify([inbox.inbox_id]),
      overrides?.subject ?? "Hello", overrides?.text ?? "hi", overrides?.html ?? null, NOW, NOW
    )
    .run();
  return msgId;
}

async function createWebhook(key: string, url: string): Promise<{ webhook_id: string; secret: string }> {
  const res = await app.request("/v0/webhooks", authed(key, {
    method: "POST",
    body: JSON.stringify({ url })
  }), env);
  expect(res.status).toBe(201);
  return (await res.json()) as { webhook_id: string; secret: string };
}

describe("suppressions (R-MAIL-02)", () => {
  it("creates, lists, filters, and deletes suppressions with events", async () => {
    const inbox = await seedInbox({ address: `sup1-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);

    const create = await app.request("/v0/suppressions", authed(key, {
      method: "POST",
      body: JSON.stringify({ address: "Bad@Example.com" })
    }), env);
    expect(create.status).toBe(201);
    const created = (await create.json()) as { address: string; reason: string };
    expect(created.address).toBe("bad@example.com");
    expect(created.reason).toBe("manual");

    const dup = await app.request("/v0/suppressions", authed(key, {
      method: "POST",
      body: JSON.stringify({ address: "bad@example.com" })
    }), env);
    expect(dup.status).toBe(409);

    const list = await app.request("/v0/suppressions", authed(key), env);
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { suppressions: { address: string }[] };
    expect(listed.suppressions.map((s) => s.address)).toContain("bad@example.com");

    const filtered = await app.request("/v0/suppressions?reason=manual&address=bad@example.com", authed(key), env);
    const filteredJson = (await filtered.json()) as { suppressions: { address: string }[] };
    expect(filteredJson.suppressions).toHaveLength(1);
    const miss = await app.request("/v0/suppressions?reason=bounce", authed(key), env);
    expect(((await miss.json()) as { suppressions: unknown[] }).suppressions).toHaveLength(0);

    const badReason = await app.request("/v0/suppressions?reason=bogus", authed(key), env);
    expect(badReason.status).toBe(400);

    const evt = await env.DB.prepare(
      "SELECT payload FROM events WHERE org_id = ? AND type = 'suppression.added'"
    ).bind(inbox.org_id).first<{ payload: string }>();
    expect(evt).not.toBeNull();
    expect(JSON.parse(evt!.payload).data.address).toBe("bad@example.com");

    const del = await app.request("/v0/suppressions/bad%40example.com", authed(key, { method: "DELETE" }), env);
    expect(del.status).toBe(204);
    const again = await app.request("/v0/suppressions/bad%40example.com", authed(key, { method: "DELETE" }), env);
    expect(again.status).toBe(404);

    const removed = await env.DB.prepare(
      "SELECT payload FROM events WHERE org_id = ? AND type = 'suppression.removed'"
    ).bind(inbox.org_id).first<{ payload: string }>();
    expect(removed).not.toBeNull();
  });

  it("batch adds and removes, and scopes to the caller's org", async () => {
    const inbox = await seedInbox({ address: `sup2-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);

    const res = await app.request("/v0/suppressions/batch", authed(key, {
      method: "POST",
      body: JSON.stringify({ add: ["a@x.com", "b@x.com"], remove: ["ghost@x.com"] })
    }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { added: { address: string }[]; removed: string[] };
    expect(body.added.map((a) => a.address).sort()).toEqual(["a@x.com", "b@x.com"]);
    expect(body.removed).toEqual([]);

    const remove = await app.request("/v0/suppressions/batch", authed(key, {
      method: "POST",
      body: JSON.stringify({ remove: ["a@x.com"] })
    }), env);
    const removedBody = (await remove.json()) as { added: unknown[]; removed: string[] };
    expect(removedBody.removed).toEqual(["a@x.com"]);

    const empty = await app.request("/v0/suppressions/batch", authed(key, {
      method: "POST",
      body: JSON.stringify({})
    }), env);
    expect(empty.status).toBe(400);

    const stranger = await seedInbox({ address: `sup3-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const strangerKey = await seedKey(stranger.org_id);
    const foreign = await app.request("/v0/suppressions", authed(strangerKey), env);
    const foreignJson = (await foreign.json()) as { suppressions: { address: string }[] };
    expect(foreignJson.suppressions.map((s) => s.address)).not.toContain("b@x.com");
  });

  it("rejects writes from read-only keys but allows listing", async () => {
    const inbox = await seedInbox({ address: `sup4-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const readKey = await seedKey(inbox.org_id, "read");
    const list = await app.request("/v0/suppressions", authed(readKey), env);
    expect(list.status).toBe(200);
    const write = await app.request("/v0/suppressions", authed(readKey, {
      method: "POST",
      body: JSON.stringify({ address: "nope@x.com" })
    }), env);
    expect(write.status).toBe(403);
  });
});

describe("message event timeline (R-MAIL-03)", () => {
  it("returns events for the message in chronological order", async () => {
    const inbox = await seedInbox({ address: `evt1-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const msgId = await seedMessage(inbox);

    await emitEvent(env.DB, {
      type: "message.received",
      org_id: inbox.org_id,
      pod_id: inbox.pod_id,
      inbox_id: inbox.inbox_id,
      msg_id: msgId,
      data: { n: 1 }
    });
    await emitEvent(env.DB, {
      type: "message.delivered",
      org_id: inbox.org_id,
      pod_id: inbox.pod_id,
      inbox_id: inbox.inbox_id,
      msg_id: msgId,
      data: { n: 2 }
    });
    // unrelated event on another message must not appear
    await emitEvent(env.DB, {
      type: "message.received",
      org_id: inbox.org_id,
      pod_id: inbox.pod_id,
      inbox_id: inbox.inbox_id,
      msg_id: "msg_other",
      data: { n: 99 }
    });

    const res = await app.request(
      `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/${msgId}/events`,
      authed(key), env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { type: string; msg_id: string; data: { n: number } }[] };
    expect(body.events).toHaveLength(2);
    expect(body.events[0]!.type).toBe("message.received");
    expect(body.events[1]!.type).toBe("message.delivered");
    expect(body.events[0]!.msg_id).toBe(msgId);
  });
});

describe("webhook secret rotation + event views (R-MAIL-03)", () => {
  it("rotates the secret and serves event payloads over deliveries", async () => {
    const inbox = await seedInbox({ address: `whx-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const hook = await createWebhook(key, "https://hooks.example.com/wh");

    const rot = await app.request(`/v0/webhooks/${hook.webhook_id}/rotate-secret`, authed(key, { method: "POST" }), env);
    expect(rot.status).toBe(200);
    const rotated = (await rot.json()) as { secret: string };
    expect(rotated.secret).toMatch(/^whsec_/);
    expect(rotated.secret).not.toBe(hook.secret);
    const stored = await env.DB.prepare("SELECT secret FROM webhooks WHERE webhook_id = ?")
      .bind(hook.webhook_id).first<{ secret: string }>();
    expect(stored?.secret).toBe(rotated.secret);

    const eventId = await emitEvent(env.DB, {
      type: "message.received",
      org_id: inbox.org_id,
      pod_id: inbox.pod_id,
      inbox_id: inbox.inbox_id,
      data: { ok: true }
    });

    const list = await app.request(`/v0/webhooks/${hook.webhook_id}/events`, authed(key), env);
    expect(list.status).toBe(200);
    const events = (await list.json()) as { events: { event_id: string; type: string }[] };
    expect(events.events.map((e) => e.event_id)).toContain(eventId);

    const one = await app.request(`/v0/webhooks/${hook.webhook_id}/events/${eventId}`, authed(key), env);
    expect(one.status).toBe(200);
    const envelope = (await one.json()) as { type: string; data: { ok: boolean } };
    expect(envelope.data.ok).toBe(true);

    const missing = await app.request(`/v0/webhooks/${hook.webhook_id}/events/evt_missing`, authed(key), env);
    expect(missing.status).toBe(404);
  });
});

describe("share links (R-MAIL-03)", () => {
  it("mints a link, serves the snapshot publicly, and enforces expiry", async () => {
    const inbox = await seedInbox({ address: `shr1-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const msgId = await seedMessage(inbox, { html: "<p>Hello <b>world</b></p>", text: "Hello world" });

    const mint = await app.request(
      `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/${msgId}/share`,
      authed(key, { method: "POST", body: JSON.stringify({}) }), env
    );
    expect(mint.status).toBe(201);
    const link = (await mint.json()) as { share_id: string; share_url: string; expires_at: string };
    expect(link.share_id).toMatch(/^share_/);
    expect(new Date(link.expires_at).getTime()).toBeGreaterThan(Date.now());

    const pub = await app.request(`/v0/share/${link.share_id}`, undefined, env);
    expect(pub.status).toBe(200);
    expect(pub.headers.get("content-type")).toContain("text/html");
    expect(pub.headers.get("content-security-policy")).toContain("default-src 'none'");
    const doc = await pub.text();
    expect(doc).toContain("<b>world</b>");
    expect(doc).toContain("Content-Security-Policy");

    const gone = await app.request("/v0/share/share_nope", undefined, env);
    expect(gone.status).toBe(404);

    await env.DB.prepare("UPDATE share_links SET expires_at = ? WHERE share_id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), link.share_id).run();
    const expired = await app.request(`/v0/share/${link.share_id}`, undefined, env);
    expect(expired.status).toBe(404);
  });

  it("serves a text document when the message has no html", async () => {
    const inbox = await seedInbox({ address: `shr2-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const msgId = await seedMessage(inbox, { text: "plain <not-html>" });
    const mint = await app.request(
      `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/${msgId}/share`,
      authed(key, { method: "POST", body: JSON.stringify({ expires_in: 60 }) }), env
    );
    const link = (await mint.json()) as { share_id: string };
    const pub = await app.request(`/v0/share/${link.share_id}`, undefined, env);
    expect(pub.status).toBe(200);
    const doc = await pub.text();
    expect(doc).toContain("plain &lt;not-html&gt;");
  });
});

describe("metrics params + domain custom_return_path (R-MAIL-03)", () => {
  it("filters metrics by type, pod, and explicit since/until", async () => {
    const inbox = await seedInbox({ address: `met1-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    await emitEvent(env.DB, {
      type: "message.received", org_id: inbox.org_id, pod_id: inbox.pod_id,
      inbox_id: inbox.inbox_id, data: {}
    });
    await emitEvent(env.DB, {
      type: "message.sent", org_id: inbox.org_id, pod_id: inbox.pod_id,
      inbox_id: inbox.inbox_id, data: {}
    });

    const res = await app.request(
      `/v0/metrics?type=message.received&pod_id=${inbox.pod_id}&granularity=day`,
      authed(key), env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { granularity: string; totals: Record<string, number> };
    expect(body.granularity).toBe("day");
    expect(body.totals["message.received"]).toBe(1);
    expect(body.totals["message.sent"]).toBeUndefined();

    const bounded = await app.request(
      `/v0/metrics?since=2000-01-01T00:00:00Z&until=2000-01-02T00:00:00Z`,
      authed(key), env
    );
    const boundedJson = (await bounded.json()) as { totals: Record<string, number> };
    expect(Object.keys(boundedJson.totals)).toHaveLength(0);

    const bad = await app.request("/v0/metrics?granularity=minute", authed(key), env);
    expect(bad.status).toBe(400);
  });

  it("sets and clears custom_return_path on a domain", async () => {
    const inbox = await seedInbox({ address: `dom1-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    // the free plan allows no custom domains
    await env.DB.prepare("UPDATE organizations SET plan = 'developer' WHERE org_id = ?")
      .bind(inbox.org_id).run();
    const create = await app.request("/v0/domains", authed(key, {
      method: "POST",
      body: JSON.stringify({ domain: `d${crypto.randomUUID().slice(0, 6)}.example.com` })
    }), env);
    expect(create.status).toBe(201);
    const domain = (await create.json()) as { domain_id: string; custom_return_path: string | null };
    expect(domain.custom_return_path).toBeNull();

    const patch = await app.request(`/v0/domains/${domain.domain_id}`, authed(key, {
      method: "PATCH",
      body: JSON.stringify({ custom_return_path: "Bounce.Example.com" })
    }), env);
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as { custom_return_path: string };
    expect(patched.custom_return_path).toBe("bounce.example.com");

    const clear = await app.request(`/v0/domains/${domain.domain_id}`, authed(key, {
      method: "PATCH",
      body: JSON.stringify({ custom_return_path: null })
    }), env);
    const cleared = (await clear.json()) as { custom_return_path: string | null };
    expect(cleared.custom_return_path).toBeNull();

    const invalid = await app.request(`/v0/domains/${domain.domain_id}`, authed(key, {
      method: "PATCH",
      body: JSON.stringify({ custom_return_path: "not a domain!" })
    }), env);
    expect(invalid.status).toBe(400);
  });
});
