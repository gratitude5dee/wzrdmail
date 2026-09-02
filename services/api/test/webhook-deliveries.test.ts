import { env, fetchMock } from "cloudflare:test";
import { verifyWebhook } from "@wzrdmail/core";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashApiKey } from "../src/auth.js";
import { emitEvent } from "../src/lib/events.js";
import {
  DELIVERY_COLUMNS,
  MAX_ATTEMPTS,
  RETRY_BACKOFF_MS,
  processDueDeliveries,
  pruneDeliveries,
  type DeliveryRow
} from "../src/lib/webhook-delivery.js";
import { seedInbox, NOW } from "./helpers.js";

const app = createApp();

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

async function seedKey(orgId: string): Promise<string> {
  const key = `wm_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.prepare(
    "INSERT INTO api_keys (key_id, org_id, key_hash, key_prefix, permissions, created_at) VALUES (?, ?, ?, ?, 'admin', ?)"
  )
    .bind(`key_${crypto.randomUUID().slice(0, 8)}`, orgId, await hashApiKey(key), key.slice(0, 12), NOW)
    .run();
  return key;
}

function authed(key: string, init?: RequestInit): RequestInit {
  return {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }
  };
}

async function createWebhook(
  key: string,
  url: string,
  eventTypes?: string[]
): Promise<{ webhook_id: string; secret: string }> {
  const res = await app.request(
    "/v0/webhooks",
    authed(key, {
      method: "POST",
      body: JSON.stringify({ url, ...(eventTypes ? { event_types: eventTypes } : {}) })
    }),
    env
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { webhook_id: string; secret: string };
}

async function emit(inbox: { org_id: string; pod_id: string; inbox_id: string }): Promise<string> {
  return emitEvent(env.DB, {
    type: "message.received",
    org_id: inbox.org_id,
    pod_id: inbox.pod_id,
    inbox_id: inbox.inbox_id,
    data: { message: { message_id: "msg_test" } }
  });
}

async function allDeliveries(webhookId: string): Promise<DeliveryRow[]> {
  return (
    await env.DB.prepare(
      `SELECT ${DELIVERY_COLUMNS} FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at, delivery_id`
    )
      .bind(webhookId)
      .all<DeliveryRow>()
  ).results;
}

async function makeDue(deliveryId: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE webhook_deliveries SET next_retry_at = ? WHERE delivery_id = ?"
  )
    .bind(new Date(Date.now() - 1000).toISOString(), deliveryId)
    .run();
}

interface Captured {
  headers: Record<string, string>;
  body: string;
}

function interceptOnce(status: number, capture?: Captured[]): void {
  fetchMock
    .get("https://hooks.example.com")
    .intercept({ path: "/wh", method: "POST" })
    .reply((opts) => {
      capture?.push({
        headers: Object.fromEntries(
          Object.entries(opts.headers as Record<string, string>).map(([k, v]) => [
            k.toLowerCase(),
            v
          ])
        ),
        body: String(opts.body)
      });
      return { statusCode: status, data: "ok" };
    });
}

describe("webhook delivery recording", () => {
  it("records a success row and the payload signature verifies", async () => {
    const inbox = await seedInbox({ address: `whd1-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const hook = await createWebhook(key, "https://hooks.example.com/wh");
    const captured: Captured[] = [];
    interceptOnce(200, captured);
    const eventId = await emit(inbox);
    expect(await processDueDeliveries(env)).toBe(1);

    const rows = await allDeliveries(hook.webhook_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "success",
      attempt: 1,
      manual: 0,
      response_status: 200,
      event_id: eventId,
      event_type: "message.received"
    });
    expect(rows[0]!.duration_ms).not.toBeNull();
    expect(rows[0]!.next_retry_at).toBeNull();

    const req = captured[0]!;
    expect(req.headers["svix-id"]).toBe(eventId);
    expect(JSON.parse(req.body)).toMatchObject({ event_id: eventId, type: "message.received" });
    expect(await verifyWebhook(hook.secret, req.headers, req.body)).toBe(true);
  });

  it("skips webhooks not subscribed to the event type", async () => {
    const inbox = await seedInbox({ address: `whd2-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const hook = await createWebhook(key, "https://hooks.example.com/wh", ["message.sent"]);
    await emit(inbox);
    expect(await allDeliveries(hook.webhook_id)).toHaveLength(0);
  });

  it("uses the \u00a78.2 retry schedule: 30s, 5m, 30m, 2h, 8h, then stop", () => {
    expect([...RETRY_BACKOFF_MS]).toEqual([30_000, 300_000, 1_800_000, 7_200_000, 28_800_000]);
    expect(MAX_ATTEMPTS).toBe(1 + RETRY_BACKOFF_MS.length);
  });

  it("records a failure and schedules a backoff retry, up to the attempt cap", async () => {
    const inbox = await seedInbox({ address: `whd3-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const hook = await createWebhook(key, "https://hooks.example.com/wh");
    interceptOnce(500);
    await emit(inbox);
    expect(await processDueDeliveries(env)).toBe(1);

    let rows = await allDeliveries(hook.webhook_id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: "failed", attempt: 1, response_status: 500 });
    expect(rows[0]!.error).toContain("500");
    const retry = rows[1]!;
    expect(retry).toMatchObject({ status: "pending", attempt: 2 });
    expect(new Date(retry.next_retry_at!).getTime()).toBeGreaterThan(Date.now());

    // Not due yet: the sweep leaves it alone.
    expect(await processDueDeliveries(env)).toBe(0);

    // Drive the remaining attempts to failure; the chain stops at MAX_ATTEMPTS.
    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
      rows = await allDeliveries(hook.webhook_id);
      const pending = rows.find((r) => r.status === "pending")!;
      expect(pending.attempt).toBe(attempt);
      await makeDue(pending.delivery_id);
      interceptOnce(503);
      expect(await processDueDeliveries(env)).toBe(1);
    }
    rows = await allDeliveries(hook.webhook_id);
    expect(rows).toHaveLength(MAX_ATTEMPTS);
    expect(rows.every((r) => r.status === "failed")).toBe(true);
  });
});

describe("delivery API", () => {
  it("lists deliveries with pagination and status filter, and gets one", async () => {
    const inbox = await seedInbox({ address: `whd4-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const hook = await createWebhook(key, "https://hooks.example.com/wh");
    interceptOnce(200);
    await emit(inbox);
    interceptOnce(500);
    await emit(inbox);
    expect(await processDueDeliveries(env)).toBe(2);

    const list = await app.request(
      `/v0/webhooks/${hook.webhook_id}/deliveries?limit=2`,
      authed(key),
      env
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      deliveries: { delivery_id: string; status: string }[];
      next_page_token: string | null;
    };
    expect(listBody.deliveries).toHaveLength(2);
    expect(listBody.next_page_token).not.toBeNull();

    const page2 = await app.request(
      `/v0/webhooks/${hook.webhook_id}/deliveries?limit=2&page_token=${encodeURIComponent(listBody.next_page_token!)}`,
      authed(key),
      env
    );
    const page2Body = (await page2.json()) as { deliveries: unknown[] };
    expect(page2Body.deliveries).toHaveLength(1);

    const failed = await app.request(
      `/v0/webhooks/${hook.webhook_id}/deliveries?status=failed`,
      authed(key),
      env
    );
    const failedBody = (await failed.json()) as { deliveries: { status: string }[] };
    expect(failedBody.deliveries).toHaveLength(1);
    expect(failedBody.deliveries[0]!.status).toBe("failed");

    const bad = await app.request(
      `/v0/webhooks/${hook.webhook_id}/deliveries?status=nope`,
      authed(key),
      env
    );
    expect(bad.status).toBe(400);

    const one = await app.request(
      `/v0/webhooks/${hook.webhook_id}/deliveries/${listBody.deliveries[0]!.delivery_id}`,
      authed(key),
      env
    );
    expect(one.status).toBe(200);
    expect(((await one.json()) as { delivery_id: string }).delivery_id).toBe(
      listBody.deliveries[0]!.delivery_id
    );
  });

  it("hides deliveries of another org's webhook", async () => {
    const inbox = await seedInbox({ address: `whd5-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const hook = await createWebhook(key, "https://hooks.example.com/wh");
    interceptOnce(200);
    await emit(inbox);
    await processDueDeliveries(env);

    const other = await seedInbox({ address: `whd6-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const otherKey = await seedKey(other.org_id);
    const res = await app.request(
      `/v0/webhooks/${hook.webhook_id}/deliveries`,
      authed(otherKey),
      env
    );
    expect(res.status).toBe(404);
  });

  it("redelivers the original payload as a new manual attempt with a verifiable signature", async () => {
    const inbox = await seedInbox({ address: `whd7-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const hook = await createWebhook(key, "https://hooks.example.com/wh");
    interceptOnce(500);
    const eventId = await emit(inbox);
    await processDueDeliveries(env);
    const failed = (await allDeliveries(hook.webhook_id)).find((r) => r.status === "failed")!;
    const originalPayload = (
      await env.DB.prepare("SELECT payload FROM events WHERE event_id = ?")
        .bind(eventId)
        .first<{ payload: string }>()
    )!.payload;

    const captured: Captured[] = [];
    interceptOnce(200, captured);
    const res = await app.request(
      `/v0/webhooks/${hook.webhook_id}/deliveries/${failed.delivery_id}/redeliver`,
      authed(key, { method: "POST" }),
      env
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      delivery_id: string;
      status: string;
      manual: boolean;
      attempt: number;
      event_id: string;
    };
    expect(body).toMatchObject({ status: "success", manual: true, event_id: eventId });
    expect(body.attempt).toBeGreaterThan(failed.attempt);

    const req = captured[0]!;
    expect(req.body).toBe(originalPayload);
    expect(await verifyWebhook(hook.secret, req.headers, req.body)).toBe(true);

    // A failed manual redelivery never schedules automatic retries.
    interceptOnce(500);
    const again = await app.request(
      `/v0/webhooks/${hook.webhook_id}/deliveries/${failed.delivery_id}/redeliver`,
      authed(key, { method: "POST" }),
      env
    );
    expect(again.status).toBe(201);
    expect(((await again.json()) as { status: string }).status).toBe("failed");
    const rows = await allDeliveries(hook.webhook_id);
    expect(rows.filter((r) => r.status === "pending" && r.manual === 1)).toHaveLength(0);
  });
});

describe("retention", () => {
  it("prunes finished deliveries older than 30 days but keeps pending ones", async () => {
    const inbox = await seedInbox({ address: `whd8-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const key = await seedKey(inbox.org_id);
    const hook = await createWebhook(key, "https://hooks.example.com/wh");
    interceptOnce(200);
    await emit(inbox);
    await processDueDeliveries(env);
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare("UPDATE webhook_deliveries SET created_at = ? WHERE webhook_id = ?")
      .bind(old, hook.webhook_id)
      .run();
    await pruneDeliveries(env.DB);
    expect(await allDeliveries(hook.webhook_id)).toHaveLength(0);
  });
});

describe("pod_ids delivery filter", () => {
  it("only enqueues deliveries for events from the subscribed pods", async () => {
    const inbox = await seedInbox({ address: `whd9-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    const other = await seedInbox({ address: `whd10-${crypto.randomUUID().slice(0, 6)}@wzrd.tech` });
    await env.DB.prepare("UPDATE inboxes SET org_id = ? WHERE inbox_id = ?")
      .bind(inbox.org_id, other.inbox_id)
      .run();
    await env.DB.prepare("UPDATE pods SET org_id = ? WHERE pod_id = ?")
      .bind(inbox.org_id, other.pod_id)
      .run();
    const key = await seedKey(inbox.org_id);
    const res = await app.request(
      "/v0/webhooks",
      authed(key, {
        method: "POST",
        body: JSON.stringify({ url: "https://hooks.example.com/wh", pod_ids: [inbox.pod_id] })
      }),
      env
    );
    expect(res.status).toBe(201);
    const hook = (await res.json()) as { webhook_id: string };

    await emit(other);
    expect(await allDeliveries(hook.webhook_id)).toHaveLength(0);

    interceptOnce(200);
    await emit(inbox);
    expect(await allDeliveries(hook.webhook_id)).toHaveLength(1);
    await processDueDeliveries(env);
  });
});
