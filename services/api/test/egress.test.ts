import { env } from "cloudflare:test";
import type { MailProvider, OutboundMime, SendOutcome } from "@wzrdmail/core";
import { describe, expect, it } from "vitest";
import { hashApiKey } from "../src/auth.js";
import { sendMessage, type SendContext } from "../src/egress/send.js";
import { createApp } from "../src/app.js";
import { seedInbox, NOW } from "./helpers.js";

class StubProvider implements MailProvider {
  sent: OutboundMime[] = [];
  fail = false;
  failAddresses: string[] = [];
  send(msg: OutboundMime): Promise<SendOutcome> {
    if (this.fail) return Promise.reject(new Error("provider says no"));
    this.sent.push(msg);
    const rejected = msg.to
      .filter((a) => this.failAddresses.includes(a))
      .map((address) => ({ address, error: "mailbox full" }));
    const accepted = msg.to.filter((a) => !this.failAddresses.includes(a));
    return Promise.resolve({ providerMessageId: "prov-1", accepted, rejected });
  }
  requiredDnsRecords(): never[] {
    return [];
  }
  verifyDomain(): Promise<{ verified: boolean; pending: never[] }> {
    return Promise.resolve({ verified: true, pending: [] });
  }
}

function ctxFor(inbox: { org_id: string; pod_id: string; inbox_id: string }): SendContext {
  return {
    inbox_id: inbox.inbox_id,
    org_id: inbox.org_id,
    pod_id: inbox.pod_id,
    org_verified: true,
    human_email: "owner@example.com"
  };
}

describe("outbound pipeline (§6.2)", () => {
  it("builds MIME, persists the message, and emits message.sent", async () => {
    const inbox = await seedInbox();
    const provider = new StubProvider();
    const result = await sendMessage(env, provider, ctxFor(inbox), {
      to: ["dest@example.com"],
      cc: [],
      bcc: [],
      subject: "Hello",
      text: "Hi there",
      labels: []
    });
    expect(result.state).toBe("sent");
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]!.raw).toContain(`Message-ID: ${result.rfc822_message_id}`);

    const msg = await env.DB.prepare("SELECT * FROM messages WHERE msg_id = ?")
      .bind(result.message_id)
      .first<Record<string, unknown>>();
    expect(msg?.direction).toBe("outbound");
    expect(msg?.state).toBe("sent");
    expect(msg?.rfc822_message_id).toBe(result.rfc822_message_id);

    const raw = await env.MAIL.get(`raw/${inbox.inbox_id}/${result.message_id}.eml`);
    expect(await raw?.text()).toContain("Hi there");

    const event = await env.DB.prepare(
      "SELECT event_id FROM events WHERE org_id = ? AND type = 'message.sent'"
    )
      .bind(inbox.org_id)
      .first();
    expect(event).not.toBeNull();

    const lookup = await env.DB.prepare(
      "SELECT msg_id FROM message_id_lookup WHERE inbox_id = ? AND rfc822_message_id = ?"
    )
      .bind(inbox.inbox_id, result.rfc822_message_id)
      .first<{ msg_id: string }>();
    expect(lookup?.msg_id).toBe(result.message_id);
  });

  it("marks the message rejected and emits message.rejected on provider failure", async () => {
    const inbox = await seedInbox();
    const provider = new StubProvider();
    provider.fail = true;
    const result = await sendMessage(env, provider, ctxFor(inbox), {
      to: ["dest@example.com"],
      cc: [],
      bcc: [],
      subject: "Hello",
      text: "Hi",
      labels: []
    });
    expect(result.state).toBe("rejected");
    const event = await env.DB.prepare(
      "SELECT payload FROM events WHERE org_id = ? AND type = 'message.rejected'"
    )
      .bind(inbox.org_id)
      .first<{ payload: string }>();
    expect(event?.payload).toContain("provider says no");
  });

  it("refuses suppressed recipients", async () => {
    const inbox = await seedInbox();
    await env.DB.prepare(
      "INSERT INTO suppressions (org_id, address, reason, created_at) VALUES (?, 'gone@example.com', 'bounce', ?)"
    )
      .bind(inbox.org_id, NOW)
      .run();
    await expect(
      sendMessage(env, new StubProvider(), ctxFor(inbox), {
        to: ["gone@example.com"],
        cc: [],
        bcc: [],
        subject: "x",
        text: "y",
        labels: []
      })
    ).rejects.toMatchObject({ name: "suppressed_recipient" });
  });

  it("restricts unverified orgs to the org's human_email", async () => {
    const inbox = await seedInbox();
    const ctx = { ...ctxFor(inbox), org_verified: false };
    await expect(
      sendMessage(env, new StubProvider(), ctx, {
        to: ["stranger@example.com"],
        cc: [],
        bcc: [],
        subject: "x",
        text: "y",
        labels: []
      })
    ).rejects.toMatchObject({ name: "forbidden" });
    const ok = await sendMessage(env, new StubProvider(), ctx, {
      to: ["owner@example.com"],
      cc: [],
      bcc: [],
      subject: "x",
      text: "y",
      labels: []
    });
    expect(ok.state).toBe("sent");
  });

  it("threads an outbound reply into the referenced thread", async () => {
    const inbox = await seedInbox();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO threads (thread_id, org_id, pod_id, inbox_id, subject, normalized_subject, last_message_at, created_at, updated_at)
         VALUES ('thread_o1', ?, ?, ?, 'Hello', 'hello', ?, ?, ?)`
      ).bind(inbox.org_id, inbox.pod_id, inbox.inbox_id, NOW, NOW, NOW),
      env.DB.prepare(
        `INSERT INTO message_id_lookup (inbox_id, rfc822_message_id, thread_id, msg_id)
         VALUES (?, '<inbound-1@example.com>', 'thread_o1', 'msg_o1')`
      ).bind(inbox.inbox_id)
    ]);
    const result = await sendMessage(env, new StubProvider(), ctxFor(inbox), {
      to: ["dest@example.com"],
      cc: [],
      bcc: [],
      subject: "Re: Hello",
      text: "replying",
      headers: { "In-Reply-To": "<inbound-1@example.com>" },
      labels: []
    });
    expect(result.thread_id).toBe("thread_o1");
  });

  it("rejects overrides of transport-managed headers", async () => {
    const inbox = await seedInbox();
    await expect(
      sendMessage(env, new StubProvider(), ctxFor(inbox), {
        to: ["dest@example.com"],
        cc: [],
        bcc: [],
        subject: "x",
        text: "y",
        headers: { From: "spoofed@example.com" },
        labels: []
      })
    ).rejects.toMatchObject({ name: "validation_error" });
  });

  it("replays the stored response for a repeated client_id without re-sending", async () => {
    const inbox = await seedInbox();
    const provider = new StubProvider();
    const input = {
      to: ["dest@example.com"],
      cc: [],
      bcc: [],
      subject: "once",
      text: "only once",
      client_id: "cli-1",
      labels: []
    };
    const first = await sendMessage(env, provider, ctxFor(inbox), input);
    const second = await sendMessage(env, provider, ctxFor(inbox), input);
    expect(second.message_id).toBe(first.message_id);
    expect(provider.sent).toHaveLength(1);
  });

  it("rejects a concurrent request while a fresh reservation is in flight", async () => {
    const inbox = await seedInbox();
    const provider = new StubProvider();
    await env.DB.prepare(
      `INSERT INTO idempotency_keys (org_id, resource_type, client_id, response, created_at, owner)
       VALUES (?, 'message', 'cli-busy', '', ?, 'other-invocation')`
    )
      .bind(inbox.org_id, new Date().toISOString())
      .run();
    await expect(
      sendMessage(env, provider, ctxFor(inbox), {
        to: ["dest@example.com"],
        cc: [],
        bcc: [],
        subject: "x",
        text: "y",
        client_id: "cli-busy",
        labels: []
      })
    ).rejects.toMatchObject({ name: "conflict" });
    expect(provider.sent).toHaveLength(0);
  });

  it("takes over a stale reservation and locks out the previous owner", async () => {
    const inbox = await seedInbox();
    const provider = new StubProvider();
    const staleAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    await env.DB.prepare(
      `INSERT INTO idempotency_keys (org_id, resource_type, client_id, response, created_at, owner)
       VALUES (?, 'message', 'cli-stale', '', ?, 'dead-invocation')`
    )
      .bind(inbox.org_id, staleAt)
      .run();
    const result = await sendMessage(env, provider, ctxFor(inbox), {
      to: ["dest@example.com"],
      cc: [],
      bcc: [],
      subject: "resumed",
      text: "resumed send",
      client_id: "cli-stale",
      labels: []
    });
    expect(result.state).toBe("sent");
    expect(provider.sent).toHaveLength(1);

    // The previous owner's token no longer matches: an expired claimant that
    // resumes cannot renew its lease, reach the provider, or commit a result.
    const staleRenew = await env.DB.prepare(
      `UPDATE idempotency_keys SET created_at = ?
       WHERE org_id = ? AND resource_type = 'message' AND client_id = 'cli-stale'
         AND response = '' AND owner = 'dead-invocation'`
    )
      .bind(new Date().toISOString(), inbox.org_id)
      .run();
    expect(staleRenew.meta.changes).toBe(0);

    // The takeover's response is durable: a later retry replays it.
    const replay = await sendMessage(env, provider, ctxFor(inbox), {
      to: ["dest@example.com"],
      cc: [],
      bcc: [],
      subject: "resumed",
      text: "resumed send",
      client_id: "cli-stale",
      labels: []
    });
    expect(replay.message_id).toBe(result.message_id);
    expect(provider.sent).toHaveLength(1);
  });

  it("keeps a partially delivered message sent and reports rejected recipients", async () => {
    const inbox = await seedInbox();
    const provider = new StubProvider();
    provider.failAddresses = ["bad@example.com"];
    const result = await sendMessage(env, provider, ctxFor(inbox), {
      to: ["good@example.com", "bad@example.com"],
      cc: [],
      bcc: [],
      subject: "partial",
      text: "hi",
      labels: []
    });
    expect(result.state).toBe("sent");
    expect(result.rejected_recipients).toEqual([
      { address: "bad@example.com", error: "mailbox full" }
    ]);
  });
});

describe("POST /v0/inboxes/:id/messages/send", () => {
  it("rejects missing keys with the error envelope", async () => {
    const app = createApp();
    const res = await app.request(
      "/v0/inboxes/scout%40wzrd.tech/messages/send",
      { method: "POST", body: JSON.stringify({ to: ["a@b.c"] }) },
      env
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ name: "unauthorized" });
  });

  it("authenticates a seeded key and reaches the provider", async () => {
    const inbox = await seedInbox();
    const key = "wm_test_key_123";
    await env.DB.prepare(
      "INSERT INTO api_keys (key_id, org_id, key_hash, key_prefix, created_at) VALUES ('key_t1', ?, ?, 'wm_test', ?)"
    )
      .bind(inbox.org_id, await hashApiKey(key), NOW)
      .run();
    const app = createApp();
    const res = await app.request(
      `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/send`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ to: ["dest@example.com"], subject: "hi", text: "hello" })
      },
      env
    );
    // No EMAIL binding in tests: the provider rejects, but the request is
    // authenticated, validated, and the message row persisted.
    expect(res.status).toBe(200);
    const body = await res.json<{ state: string; message_id: string }>();
    expect(body.state).toBe("rejected");
    const msg = await env.DB.prepare("SELECT state FROM messages WHERE msg_id = ?")
      .bind(body.message_id)
      .first<{ state: string }>();
    expect(msg?.state).toBe("rejected");
  });

  it("treats an Idempotency-Key header as the send client_id", async () => {
    const inbox = await seedInbox();
    const key = "wm_test_key_idem";
    await env.DB.prepare(
      "INSERT INTO api_keys (key_id, org_id, key_hash, key_prefix, created_at) VALUES ('key_idem', ?, ?, 'wm_test', ?)"
    )
      .bind(inbox.org_id, await hashApiKey(key), NOW)
      .run();
    const app = createApp();
    const send = () =>
      app.request(
        `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/send`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
            "Idempotency-Key": "idem-abc-1"
          },
          body: JSON.stringify({ to: ["dest@example.com"], subject: "hi", text: "hello" })
        },
        env
      );
    const first = await send();
    expect(first.status).toBe(200);
    const firstBody = await first.json<{ message_id: string }>();
    const second = await send();
    expect(second.status).toBe(200);
    const secondBody = await second.json<{ message_id: string }>();
    expect(secondBody.message_id).toBe(firstBody.message_id);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE inbox_id = ? AND direction = 'outbound'"
    )
      .bind(inbox.inbox_id)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("rejects send for a read-only key", async () => {
    const inbox = await seedInbox();
    const key = "wm_readonly_key";
    await env.DB.prepare(
      "INSERT INTO api_keys (key_id, org_id, key_hash, key_prefix, permissions, created_at) VALUES ('key_ro', ?, ?, 'wm_read', 'read', ?)"
    )
      .bind(inbox.org_id, await hashApiKey(key), NOW)
      .run();
    const app = createApp();
    const res = await app.request(
      `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/send`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ to: ["dest@example.com"], subject: "hi", text: "hello" })
      },
      env
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ name: "forbidden" });
  });
});
