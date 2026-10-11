import { env } from "cloudflare:test";
import type { MailProvider, OutboundMime, SendOutcome } from "@wzrdmail/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashApiKey } from "../src/auth.js";
import { deliverDueScheduled } from "../src/egress/scheduled.js";
import { sendMessage, type SendContext } from "../src/egress/send.js";
import { seedInbox, NOW } from "./helpers.js";

const app = createApp();
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

class StubProvider implements MailProvider {
  sent: OutboundMime[] = [];
  send(msg: OutboundMime): Promise<SendOutcome> {
    this.sent.push(msg);
    return Promise.resolve({ providerMessageId: "prov-1", accepted: msg.to, rejected: [] });
  }
  requiredDnsRecords(): never[] {
    return [];
  }
  verifyDomain(): Promise<{ verified: boolean; pending: never[] }> {
    return Promise.resolve({ verified: true, pending: [] });
  }
}

async function seedKey(orgId: string): Promise<string> {
  const key = `wm_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.prepare(
    "INSERT INTO api_keys (key_id, org_id, pod_id, key_hash, key_prefix, permissions, created_at) VALUES (?, ?, NULL, ?, ?, 'admin', ?)"
  )
    .bind(`key_${crypto.randomUUID().slice(0, 8)}`, orgId, await hashApiKey(key), key.slice(0, 12), NOW)
    .run();
  return key;
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

function ctxFor(inbox: { org_id: string; pod_id: string; inbox_id: string }): SendContext {
  return {
    inbox_id: inbox.inbox_id,
    org_id: inbox.org_id,
    pod_id: inbox.pod_id,
    org_verified: true,
    human_email: "owner@example.com"
  };
}

async function scheduledMessage(
  key: string,
  inboxId: string
): Promise<{ message_id: string; state: string }> {
  const res = await app.request(
    `/v0/inboxes/${encodeURIComponent(inboxId)}/messages/send`,
    authed(key, {
      method: "POST",
      body: JSON.stringify({ to: ["x@example.com"], subject: "s", send_at: FUTURE })
    }),
    env
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { message_id: string; state: string };
}

describe("send lifecycle", () => {
  it("joins a reply_to array into one header", async () => {
    const inbox = await seedInbox({ address: `r1-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const provider = new StubProvider();
    await sendMessage(env, provider, ctxFor(inbox), {
      to: ["x@example.com"],
      subject: "reply-to",
      reply_to: ["a@x.com", "b@x.com"]
    });
    expect(provider.sent[0]!.raw).toContain("Reply-To: a@x.com, b@x.com");
  });

  it("marks attachments with content_id as inline with a Content-ID header", async () => {
    const inbox = await seedInbox({ address: `r2-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const provider = new StubProvider();
    await sendMessage(env, provider, ctxFor(inbox), {
      to: ["x@example.com"],
      subject: "inline",
      html: '<img src="cid:logo">',
      attachments: [
        {
          filename: "logo.png",
          content_type: "image/png",
          content: "aGVsbG8=",
          content_id: "logo"
        }
      ]
    });
    expect(provider.sent[0]!.raw).toContain("Content-ID: <logo>");
    expect(provider.sent[0]!.raw).toMatch(/Content-Disposition: inline.*logo\.png/);
  });

  it("batch-sends messages and reports per-item errors", async () => {
    const inbox = await seedInbox({ address: `r3-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    await env.DB.prepare(
      "INSERT INTO suppressions (org_id, address, reason, created_at) VALUES (?, 'blocked@example.com', 'manual', ?)"
    )
      .bind(inbox.org_id, NOW)
      .run();
    const res = await app.request(
      `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/batch-send`,
      authed(key, {
        method: "POST",
        body: JSON.stringify({
          messages: [
            { to: ["a@example.com"], subject: "one" },
            { to: ["blocked@example.com"], subject: "two" },
            { to: ["c@example.com"], subject: "three", send_at: FUTURE }
          ]
        })
      }),
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: ({ index: number; state?: string; message_id?: string; error?: { name: string } })[]
    };
    expect(body.results).toHaveLength(3);
    expect(body.results[0]!.index).toBe(0);
    expect(body.results[0]!.error).toBeUndefined();
    expect(body.results[0]!.message_id).toBeTruthy();
    expect(body.results[1]!.error?.name).toBe("suppressed_recipient");
    expect(body.results[2]!.state).toBe("scheduled");
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE inbox_id = ?"
    )
      .bind(inbox.inbox_id)
      .first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it("dedupes a retried batch-send by Idempotency-Key", async () => {
    const inbox = await seedInbox({ address: `r4-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const url = `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/batch-send`;
    const init = authed(key, {
      method: "POST",
      headers: { "Idempotency-Key": `batch-${crypto.randomUUID()}` },
      body: JSON.stringify({ messages: [{ to: ["a@example.com"], subject: "one" }] })
    });
    const first = await app.request(url, init, env);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { results: { message_id?: string }[] };
    const second = await app.request(url, init, env);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { results: { message_id?: string }[] };
    expect(secondBody.results[0]!.message_id).toBe(firstBody.results[0]!.message_id);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE inbox_id = ?")
      .bind(inbox.inbox_id)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("cancels a scheduled send via POST cancel and re-arms via PATCH send_at", async () => {
    const inbox = await seedInbox({ address: `r5-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const provider = new StubProvider();
    const msg = await scheduledMessage(key, inbox.inbox_id);
    expect(msg.state).toBe("scheduled");

    const cancelled = await app.request(
      `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/${msg.message_id}/cancel`,
      authed(key, { method: "POST" }),
      env
    );
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as { state: string }).state).toBe("cancelled");
    const cancelEvent = await env.DB.prepare(
      "SELECT event_id FROM events WHERE org_id = ? AND type = 'message.cancelled'"
    )
      .bind(inbox.org_id)
      .first();
    expect(cancelEvent).not.toBeNull();

    // A cancelled message is never dispatched.
    const later = new Date(new Date(FUTURE).getTime() + 1000);
    expect(await deliverDueScheduled(env, provider, later)).toBe(0);

    // Re-arm: PATCH send_at flips cancelled back to scheduled.
    const newWhen = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const patched = await app.request(
      `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/${msg.message_id}`,
      authed(key, { method: "PATCH", body: JSON.stringify({ send_at: newWhen }) }),
      env
    );
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as { state: string; send_at: string };
    expect(patchedBody.state).toBe("scheduled");
    expect(patchedBody.send_at).toBe(newWhen);
  });

  it("rejects cancel for a sent message and reschedule for a past send_at", async () => {
    const inbox = await seedInbox({ address: `r6-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const send = await app.request(
      `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/send`,
      authed(key, { method: "POST", body: JSON.stringify({ to: ["x@example.com"] }) }),
      env
    );
    const sent = (await send.json()) as { message_id: string };
    const cancel = await app.request(
      `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/${sent.message_id}/cancel`,
      authed(key, { method: "POST" }),
      env
    );
    expect(cancel.status).toBe(409);

    const msg = await scheduledMessage(key, inbox.inbox_id);
    const reschedule = await app.request(
      `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/${msg.message_id}`,
      authed(key, {
        method: "PATCH",
        body: JSON.stringify({ send_at: new Date(Date.now() - 1000).toISOString() })
      }),
      env
    );
    expect(reschedule.status).toBe(400);
  });

  it("lists attachments for a message", async () => {
    const inbox = await seedInbox({ address: `r7-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const send = await app.request(
      `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/send`,
      authed(key, {
        method: "POST",
        body: JSON.stringify({
          to: ["x@example.com"],
          attachments: [{ filename: "a.txt", content_type: "text/plain", content: "aGk=" }]
        })
      }),
      env
    );
    const sent = (await send.json()) as { message_id: string };
    const res = await app.request(
      `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/${sent.message_id}/attachments`,
      authed(key),
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attachments: { filename: string }[] };
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]!.filename).toBe("a.txt");
  });

  it("renames an api key via PATCH", async () => {
    const inbox = await seedInbox({ address: `r8-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const list = await app.request("/v0/api-keys", authed(key), env);
    const { api_keys } = (await list.json()) as { api_keys: { key_id: string }[] };
    const keyId = api_keys[0]!.key_id;
    const res = await app.request(
      `/v0/api-keys/${keyId}`,
      authed(key, { method: "PATCH", body: JSON.stringify({ name: "ci key" }) }),
      env
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe("ci key");
    const row = await env.DB.prepare("SELECT name FROM api_keys WHERE key_id = ?")
      .bind(keyId)
      .first<{ name: string }>();
    expect(row?.name).toBe("ci key");
  });
});
