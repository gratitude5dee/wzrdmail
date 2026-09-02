import {
  ApiError,
  CreateWebhookInput,
  UpdateWebhookInput,
  WebhookHeadersInput,
  newId
} from "@wzrdmail/core";
import { Hono } from "hono";
import type { Context } from "hono";
import { authenticate, requirePermission, type AuthedKey } from "../auth.js";
import type { Env } from "../env.js";
import {
  collection,
  parseBody,
  parsePagination,
  requireInbox,
  withIdempotency
} from "../lib/http.js";
import {
  claimAndRun,
  deliveryJson,
  DELIVERY_COLUMNS,
  type DeliveryRow
} from "../lib/webhook-delivery.js";
import { webhookJson, type WebhookRow } from "../lib/serialize.js";

export const webhooks = new Hono<{ Bindings: Env }>();

const WEBHOOK_COLUMNS =
  "webhook_id, org_id, inbox_id, pod_ids, url, secret, enabled, event_types, headers, client_id, created_at, updated_at";

function randomSecret(): string {
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  return `whsec_${[...buf].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** SSRF guard (§8.2): HTTPS only, and never private/link-local/metadata hosts. */
function assertSafeUrl(raw: string, env: Env["WZRDMAIL_ENV"]): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError("validation_error", "invalid webhook url");
  }
  if (env === "dev" && url.hostname === "localhost") return;
  if (url.protocol !== "https:") {
    throw new ApiError("validation_error", "webhook url must be https");
  }
  const host = url.hostname;
  const privateHost =
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
    host === "[::1]" ||
    host.startsWith("[fd") ||
    host.startsWith("[fe80") ||
    host === "metadata.google.internal";
  if (privateHost) {
    throw new ApiError("validation_error", "webhook url resolves to a private address");
  }
}

async function requireWebhook(
  c: Context<{ Bindings: Env }>,
  auth: AuthedKey,
  webhookId: string,
  inboxId?: string
): Promise<WebhookRow> {
  const row = await c.env.DB.prepare(
    `SELECT ${WEBHOOK_COLUMNS} FROM webhooks WHERE webhook_id = ? AND deleted_at IS NULL`
  )
    .bind(webhookId)
    .first<WebhookRow>();
  if (
    !row ||
    row.org_id !== auth.org_id ||
    (inboxId !== undefined && row.inbox_id !== inboxId) ||
    (auth.inbox_id !== null && row.inbox_id !== auth.inbox_id)
  ) {
    throw new ApiError("not_found", "no such webhook");
  }
  return row;
}

async function listWebhooks(
  c: Context<{ Bindings: Env }>,
  auth: AuthedKey,
  inboxId?: string
): Promise<Response> {
  const { limit, cursor } = parsePagination(c);
  const conditions = ["org_id = ?", "deleted_at IS NULL"];
  const binds: string[] = [auth.org_id];
  if (auth.inbox_id) {
    if (inboxId !== undefined && inboxId !== auth.inbox_id) {
      throw new ApiError("not_found", "inbox not found");
    }
    inboxId = auth.inbox_id;
  }
  if (inboxId !== undefined) {
    conditions.push("inbox_id = ?");
    binds.push(inboxId);
  }
  if (cursor) {
    conditions.push("(created_at > ? OR (created_at = ? AND webhook_id > ?))");
    binds.push(cursor.v, cursor.v, cursor.id);
  }
  const rows = (
    await c.env.DB.prepare(
      `SELECT ${WEBHOOK_COLUMNS} FROM webhooks WHERE ${conditions.join(" AND ")}
       ORDER BY created_at, webhook_id LIMIT ?`
    )
      .bind(...binds, limit + 1)
      .all<WebhookRow>()
  ).results;
  const page = collection(rows, limit, (r) => ({ v: r.created_at, id: r.webhook_id }));
  return c.json({
    webhooks: page.items.map((r) => webhookJson(r)),
    next_page_token: page.next_page_token ?? null
  });
}

async function createWebhook(
  c: Context<{ Bindings: Env }>,
  auth: AuthedKey,
  forcedInboxId?: string
): Promise<Response> {
  const input = await parseBody(c, CreateWebhookInput);
  assertSafeUrl(input.url, c.env.WZRDMAIL_ENV);
  const inboxId = forcedInboxId ?? input.inbox_id?.toLowerCase();
  if (auth.inbox_id && inboxId === undefined) {
    throw new ApiError("forbidden", "inbox-scoped keys can only create webhooks for their own inbox");
  }
  if (inboxId !== undefined) {
    await requireInbox(c, auth, inboxId);
  }
  const podIds = await validatePodIds(c, auth, input.pod_ids);
  const result = await withIdempotency(
    c.env.DB,
    auth.org_id,
    "webhook",
    input.client_id,
    async () => {
      const webhookId = newId("wh");
      const now = new Date().toISOString();
      const row: WebhookRow = {
        webhook_id: webhookId,
        org_id: auth.org_id,
        inbox_id: inboxId ?? null,
        pod_ids: JSON.stringify(podIds),
        url: input.url,
        secret: randomSecret(),
        enabled: input.enabled === false ? 0 : 1,
        event_types: JSON.stringify(input.event_types ?? []),
        headers: "{}",
        client_id: input.client_id ?? null,
        created_at: now,
        updated_at: now
      };
      await c.env.DB.prepare(
        `INSERT INTO webhooks (webhook_id, org_id, inbox_id, pod_ids, url, secret, enabled, event_types, headers, client_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          row.webhook_id,
          row.org_id,
          row.inbox_id,
          row.pod_ids,
          row.url,
          row.secret,
          row.enabled,
          row.event_types,
          row.headers,
          row.client_id,
          row.created_at,
          row.updated_at
        )
        .run();
      return webhookJson(row, { includeSecret: true });
    }
  );
  return c.json(result, 201);
}

/** Dedupe and verify every pod is the caller's (pod-scoped keys: only their own). */
async function validatePodIds(
  c: Context<{ Bindings: Env }>,
  auth: AuthedKey,
  requested: string[] | undefined
): Promise<string[]> {
  const podIds = [...new Set(requested ?? [])];
  if (podIds.length === 0) return podIds;
  if (auth.pod_id && podIds.some((p) => p !== auth.pod_id)) {
    throw new ApiError("forbidden", "pod-scoped keys can only subscribe to their own pod");
  }
  const known = (
    await c.env.DB.prepare(
      `SELECT pod_id FROM pods WHERE org_id = ? AND pod_id IN (${podIds.map(() => "?").join(",")})`
    )
      .bind(auth.org_id, ...podIds)
      .all<{ pod_id: string }>()
  ).results.map((r) => r.pod_id);
  const missing = podIds.find((p) => !known.includes(p));
  if (missing) throw new ApiError("not_found", `no such pod: ${missing}`);
  return podIds;
}

async function updateWebhook(
  c: Context<{ Bindings: Env }>,
  auth: AuthedKey,
  webhookId: string,
  inboxId?: string
): Promise<Response> {
  const row = await requireWebhook(c, auth, webhookId, inboxId);
  const input = await parseBody(c, UpdateWebhookInput);
  if (input.url !== undefined) assertSafeUrl(input.url, c.env.WZRDMAIL_ENV);
  const next: WebhookRow = {
    ...row,
    url: input.url ?? row.url,
    enabled: input.enabled === undefined ? row.enabled : input.enabled ? 1 : 0,
    event_types:
      input.event_types === undefined ? row.event_types : JSON.stringify(input.event_types),
    pod_ids:
      input.pod_ids === undefined
        ? row.pod_ids
        : JSON.stringify(await validatePodIds(c, auth, input.pod_ids)),
    updated_at: new Date().toISOString()
  };
  await c.env.DB.prepare(
    "UPDATE webhooks SET url = ?, enabled = ?, event_types = ?, pod_ids = ?, updated_at = ? WHERE webhook_id = ?"
  )
    .bind(next.url, next.enabled, next.event_types, next.pod_ids, next.updated_at, next.webhook_id)
    .run();
  return c.json(webhookJson(next));
}

async function deleteWebhook(
  c: Context<{ Bindings: Env }>,
  auth: AuthedKey,
  webhookId: string,
  inboxId?: string
): Promise<Response> {
  const row = await requireWebhook(c, auth, webhookId, inboxId);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE webhooks SET deleted_at = ?, updated_at = ? WHERE webhook_id = ?"
  )
    .bind(now, now, row.webhook_id)
    .run();
  return c.body(null, 204);
}

// Org-wide
webhooks.get("/webhooks", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  return listWebhooks(c, auth);
});

webhooks.post("/webhooks", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  return createWebhook(c, auth);
});

webhooks.get("/webhooks/:webhook_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  const row = await requireWebhook(c, auth, c.req.param("webhook_id"));
  return c.json(webhookJson(row));
});

webhooks.patch("/webhooks/:webhook_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  return updateWebhook(c, auth, c.req.param("webhook_id"));
});

webhooks.delete("/webhooks/:webhook_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  return deleteWebhook(c, auth, c.req.param("webhook_id"));
});

webhooks.get("/webhooks/:webhook_id/headers", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  const row = await requireWebhook(c, auth, c.req.param("webhook_id"));
  return c.json(JSON.parse(row.headers) as Record<string, string>);
});

webhooks.patch("/webhooks/:webhook_id/headers", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  const row = await requireWebhook(c, auth, c.req.param("webhook_id"));
  const input = await parseBody(c, WebhookHeadersInput);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE webhooks SET headers = ?, updated_at = ? WHERE webhook_id = ?"
  )
    .bind(JSON.stringify(input), now, row.webhook_id)
    .run();
  return c.json(input);
});

const DELIVERY_STATUSES = new Set(["pending", "success", "failed"]);

async function requireDelivery(
  c: Context<{ Bindings: Env }>,
  webhook: WebhookRow,
  deliveryId: string
): Promise<DeliveryRow> {
  const row = await c.env.DB.prepare(
    `SELECT ${DELIVERY_COLUMNS} FROM webhook_deliveries WHERE delivery_id = ?`
  )
    .bind(deliveryId)
    .first<DeliveryRow>();
  if (!row || row.webhook_id !== webhook.webhook_id || row.org_id !== webhook.org_id) {
    throw new ApiError("not_found", "no such delivery");
  }
  return row;
}

// Delivery log (newest first)
webhooks.get("/webhooks/:webhook_id/deliveries", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  const webhook = await requireWebhook(c, auth, c.req.param("webhook_id"));
  const { limit, cursor } = parsePagination(c);
  const status = c.req.query("status");
  if (status !== undefined && !DELIVERY_STATUSES.has(status)) {
    throw new ApiError("validation_error", "status must be pending, success, or failed");
  }
  const conditions = ["webhook_id = ?"];
  const binds: string[] = [webhook.webhook_id];
  if (status) {
    conditions.push("status = ?");
    binds.push(status);
  }
  if (cursor) {
    conditions.push("(created_at < ? OR (created_at = ? AND delivery_id < ?))");
    binds.push(cursor.v, cursor.v, cursor.id);
  }
  const rows = (
    await c.env.DB.prepare(
      `SELECT ${DELIVERY_COLUMNS} FROM webhook_deliveries WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC, delivery_id DESC LIMIT ?`
    )
      .bind(...binds, limit + 1)
      .all<DeliveryRow>()
  ).results;
  const page = collection(rows, limit, (r) => ({ v: r.created_at, id: r.delivery_id }));
  return c.json({
    deliveries: page.items.map((r) => deliveryJson(r)),
    next_page_token: page.next_page_token ?? null
  });
});

webhooks.get("/webhooks/:webhook_id/deliveries/:delivery_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  const webhook = await requireWebhook(c, auth, c.req.param("webhook_id"));
  const row = await requireDelivery(c, webhook, c.req.param("delivery_id"));
  return c.json(deliveryJson(row));
});

// Manual redelivery: records a fresh attempt of the original event payload
// and runs it inline. Always safe to repeat — each call is a new attempt row
// signed with the same svix-id (the event id), so consumers can dedupe.
webhooks.post("/webhooks/:webhook_id/deliveries/:delivery_id/redeliver", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  const webhook = await requireWebhook(c, auth, c.req.param("webhook_id"));
  const source = await requireDelivery(c, webhook, c.req.param("delivery_id"));
  const last = await c.env.DB.prepare(
    "SELECT MAX(attempt) AS max_attempt FROM webhook_deliveries WHERE webhook_id = ? AND event_id = ?"
  )
    .bind(webhook.webhook_id, source.event_id)
    .first<{ max_attempt: number }>();
  const deliveryId = newId("whd");
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO webhook_deliveries
       (delivery_id, webhook_id, org_id, event_id, event_type, attempt, manual, status, next_retry_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?, ?)`
  )
    .bind(
      deliveryId,
      webhook.webhook_id,
      webhook.org_id,
      source.event_id,
      source.event_type,
      (last?.max_attempt ?? 0) + 1,
      now,
      now,
      now
    )
    .run();
  const inserted = await requireDelivery(c, webhook, deliveryId);
  await claimAndRun(c.env, inserted);
  const finished = await requireDelivery(c, webhook, deliveryId);
  return c.json(deliveryJson(finished), 201);
});

// Inbox-scoped mirrors
webhooks.get("/inboxes/:inbox_id/webhooks", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  return listWebhooks(c, auth, inbox.inbox_id);
});

webhooks.post("/inboxes/:inbox_id/webhooks", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  return createWebhook(c, auth, inbox.inbox_id);
});

webhooks.get("/inboxes/:inbox_id/webhooks/:webhook_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "read");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  const row = await requireWebhook(c, auth, c.req.param("webhook_id"), inbox.inbox_id);
  return c.json(webhookJson(row));
});

webhooks.patch("/inboxes/:inbox_id/webhooks/:webhook_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  return updateWebhook(c, auth, c.req.param("webhook_id"), inbox.inbox_id);
});

webhooks.delete("/inboxes/:inbox_id/webhooks/:webhook_id", async (c) => {
  const auth = await authenticate(c);
  requirePermission(auth, "admin");
  const inbox = await requireInbox(c, auth, c.req.param("inbox_id"));
  return deleteWebhook(c, auth, c.req.param("webhook_id"), inbox.inbox_id);
});
