import { env } from "cloudflare:test";
import type { MailProvider, OutboundMime, SendOutcome } from "@wzrdmail/core";
import { describe, expect, it } from "vitest";
import { hashApiKey } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { sendMessage, type SendContext } from "../src/egress/send.js";
import {
  clickSignature,
  openToken,
  trackingBase,
  trackingSecret
} from "../src/lib/tracking.js";
import { NOW, seedInbox } from "./helpers.js";

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

function ctxFor(inbox: { org_id: string; pod_id: string; inbox_id: string }): SendContext {
  return {
    inbox_id: inbox.inbox_id,
    org_id: inbox.org_id,
    pod_id: inbox.pod_id,
    org_verified: true,
    human_email: "owner@example.com"
  };
}

async function setFlags(
  inboxId: string,
  flags: { open?: boolean; click?: boolean }
): Promise<void> {
  await env.DB.prepare(
    "UPDATE inboxes SET x_open_tracking = ?, x_click_tracking = ? WHERE inbox_id = ?"
  )
    .bind(flags.open ? 1 : 0, flags.click ? 1 : 0, inboxId)
    .run();
}

async function seedKey(orgId: string, key = "wm_test_admin"): Promise<string> {
  await env.DB.prepare(
    `INSERT INTO api_keys (key_id, org_id, key_hash, key_prefix, created_at)
     VALUES (?, ?, ?, 'wm_test', ?)`
  )
    .bind(`key_${crypto.randomUUID().slice(0, 8)}`, orgId, await hashApiKey(key), NOW)
    .run();
  return key;
}

const HTML_BODY =
  '<html><body>See <a href="https://example.com/docs?a=1&b=2">docs</a> or ' +
  '<a href="mailto:help@example.com">mail us</a>.</body></html>';

async function sendHtml(inbox: { org_id: string; pod_id: string; inbox_id: string }) {
  const provider = new StubProvider();
  const result = await sendMessage(env, provider, ctxFor(inbox), {
    to: ["dest@example.com"],
    cc: [],
    bcc: [],
    subject: "Tracked",
    html: HTML_BODY,
    labels: []
  });
  return { provider, result };
}

describe("PATCH /v0/inboxes/:id tracking flags", () => {
  it("round-trips x_open_tracking and x_click_tracking", async () => {
    const inbox = await seedInbox();
    const key = await seedKey(inbox.org_id);
    const app = createApp();
    const res = await app.request(
      `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ x_open_tracking: true, x_click_tracking: true })
      },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ x_open_tracking: boolean; x_click_tracking: boolean }>();
    expect(body.x_open_tracking).toBe(true);
    expect(body.x_click_tracking).toBe(true);

    const get = await app.request(
      `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}`,
      { headers: { authorization: `Bearer ${key}` } },
      env
    );
    const got = await get.json<{ x_open_tracking: boolean; x_click_tracking: boolean }>();
    expect(got.x_open_tracking).toBe(true);
    expect(got.x_click_tracking).toBe(true);

    // Omitted flags keep their stored values.
    const off = await app.request(
      `/v0/inboxes/${encodeURIComponent(inbox.inbox_id)}`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ x_click_tracking: false })
      },
      env
    );
    const offBody = await off.json<{ x_open_tracking: boolean; x_click_tracking: boolean }>();
    expect(offBody.x_open_tracking).toBe(true);
    expect(offBody.x_click_tracking).toBe(false);
  });
});

describe("egress tracking injection", () => {
  it("appends a 1px open pixel to the transmitted MIME only", async () => {
    const inbox = await seedInbox();
    await setFlags(inbox.inbox_id, { open: true });
    const { provider, result } = await sendHtml(inbox);
    const raw = provider.sent[0]!.raw;
    const tok = await openToken(result.message_id, trackingSecret(env));
    expect(raw).toContain(`${trackingBase(env)}/o/${result.message_id}/${tok}`);
    expect(raw).toContain('width="1" height="1"');
    // The stored html is the author's original — no self-counted console views.
    const row = await env.DB.prepare("SELECT html FROM messages WHERE msg_id = ?")
      .bind(result.message_id)
      .first<{ html: string }>();
    expect(row?.html).toBe(HTML_BODY);
  });

  it("rewrites http(s) hrefs to signed /c redirects and leaves mailto alone", async () => {
    const inbox = await seedInbox();
    await setFlags(inbox.inbox_id, { click: true });
    const { provider, result } = await sendHtml(inbox);
    const raw = provider.sent[0]!.raw;
    const sig = await clickSignature(
      result.message_id,
      "https://example.com/docs?a=1&b=2",
      trackingSecret(env)
    );
    expect(raw).toContain(
      `${trackingBase(env)}/c/${result.message_id}/${sig}?u=${encodeURIComponent("https://example.com/docs?a=1&b=2")}`
    );
    expect(raw).toContain('href="mailto:help@example.com"');
  });

  it("injects nothing when both flags are off", async () => {
    const inbox = await seedInbox();
    const { provider, result } = await sendHtml(inbox);
    const raw = provider.sent[0]!.raw;
    expect(raw).not.toContain(`/o/${result.message_id}/`);
    expect(raw).not.toContain(`/c/${result.message_id}/`);
    expect(raw).toContain('href="https://example.com/docs?a=1&b=2"');
  });
});

describe("GET /v0/o/:msg_id/:tok", () => {
  it("returns the pixel, bumps x_open_count, and emits message.opened", async () => {
    const inbox = await seedInbox();
    await setFlags(inbox.inbox_id, { open: true });
    const { result } = await sendHtml(inbox);
    const msgId = result.message_id;
    const tok = await openToken(msgId, trackingSecret(env));
    const app = createApp();
    const res = await app.request(
      `/v0/o/${msgId}/${tok}`,
      { headers: { "user-agent": "TestMail/1.0" } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body[0]).toBe(0x47); // 'G' of GIF89a

    const row = await env.DB.prepare(
      "SELECT x_open_count, x_last_opened_at FROM messages WHERE msg_id = ?"
    )
      .bind(msgId)
      .first<{ x_open_count: number; x_last_opened_at: string | null }>();
    expect(row?.x_open_count).toBe(1);
    expect(row?.x_last_opened_at).not.toBeNull();

    const event = await env.DB.prepare(
      "SELECT payload FROM events WHERE org_id = ? AND type = 'message.opened'"
    )
      .bind(inbox.org_id)
      .first<{ payload: string }>();
    expect(event).not.toBeNull();
    expect(event!.payload).toContain(msgId);
  });

  it("dedupes repeat opens per msg+UA within the window", async () => {
    const inbox = await seedInbox();
    await setFlags(inbox.inbox_id, { open: true });
    const { result } = await sendHtml(inbox);
    const msgId = result.message_id;
    const tok = await openToken(msgId, trackingSecret(env));
    const app = createApp();
    const hit = (ua: string) =>
      app.request(`/v0/o/${msgId}/${tok}`, { headers: { "user-agent": ua } }, env);
    expect((await hit("Scanner/1.0")).status).toBe(200);
    expect((await hit("Scanner/1.0")).status).toBe(200);
    expect((await hit("Reader/2.0")).status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT x_open_count FROM messages WHERE msg_id = ?"
    )
      .bind(msgId)
      .first<{ x_open_count: number }>();
    expect(row?.x_open_count).toBe(2);

    const events = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE org_id = ? AND type = 'message.opened'"
    )
      .bind(inbox.org_id)
      .first<{ n: number }>();
    expect(events?.n).toBe(2);
  });

  it("404s on a bad token and on an unknown message", async () => {
    const inbox = await seedInbox();
    await setFlags(inbox.inbox_id, { open: true });
    const { result } = await sendHtml(inbox);
    const app = createApp();
    const bad = await app.request(`/v0/o/${result.message_id}/deadbeef`, {}, env);
    expect(bad.status).toBe(404);
    // Well-formed token for a message that does not exist.
    const ghost = await app.request(
      `/v0/o/msg_${"0".repeat(26)}/${await openToken(`msg_${"0".repeat(26)}`, trackingSecret(env))}`,
      {},
      env
    );
    expect(ghost.status).toBe(404);
  });
});

describe("GET /v0/c/:msg_id/:sig", () => {
  it("302s to the target, bumps x_click_count, and emits message.clicked with the url", async () => {
    const inbox = await seedInbox();
    await setFlags(inbox.inbox_id, { click: true });
    const { provider, result } = await sendHtml(inbox);
    const raw = provider.sent[0]!.raw;
    const msgId = result.message_id;
    // Pull the rewritten link back out of the MIME body and follow it like a
    // real recipient would.
    const tracked = /href="([^"]+\/c\/[^"]+)"/.exec(raw)?.[1];
    expect(tracked).toBeDefined();
    const url = new URL(tracked!);
    const app = createApp();
    const res = await app.request(url.pathname + url.search, {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/docs?a=1&b=2");

    const row = await env.DB.prepare(
      "SELECT x_click_count, x_last_clicked_at FROM messages WHERE msg_id = ?"
    )
      .bind(msgId)
      .first<{ x_click_count: number; x_last_clicked_at: string | null }>();
    expect(row?.x_click_count).toBe(1);
    expect(row?.x_last_clicked_at).not.toBeNull();

    const event = await env.DB.prepare(
      "SELECT payload FROM events WHERE org_id = ? AND type = 'message.clicked'"
    )
      .bind(inbox.org_id)
      .first<{ payload: string }>();
    expect(event!.payload).toContain("https://example.com/docs");
  });

  it("rejects a forged signature and a non-http target", async () => {
    const inbox = await seedInbox();
    await setFlags(inbox.inbox_id, { click: true });
    const { result } = await sendHtml(inbox);
    const msgId = result.message_id;
    const app = createApp();
    const forged = await app.request(
      `/v0/c/${msgId}/badc0ffee?u=${encodeURIComponent("https://example.com/docs?a=1&b=2")}`,
      {},
      env
    );
    expect(forged.status).toBe(404);

    // A correctly-signed non-http(s) target is refused before redirect.
    const sig = await clickSignature(msgId, "javascript:alert(1)", trackingSecret(env));
    const js = await app.request(
      `/v0/c/${msgId}/${sig}?u=${encodeURIComponent("javascript:alert(1)")}`,
      {},
      env
    );
    expect(js.status).toBe(400);
  });
});
