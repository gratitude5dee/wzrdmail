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
import { webhookJson, type WebhookRow } from "../lib/serialize.js";

export const webhooks = new Hono<{ Bindings: Env }>();

const WEBHOOK_COLUMNS =
  "webhook_id, org_id, inbox_id, url, secret, enabled, event_types, headers, client_id, created_at, updated_at";

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
    (inboxId !== undefined && row.inbox_id !== inboxId)
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
    items: page.items.map(webhookJson),
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
  if (inboxId !== undefined) {
    await requireInbox(c, auth, inboxId);
  }
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
        `INSERT INTO webhooks (webhook_id, org_id, inbox_id, url, secret, enabled, event_types, headers, client_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          row.webhook_id,
          row.org_id,
          row.inbox_id,
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
      return webhookJson(row);
    }
  );
  return c.json(result, 201);
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
    updated_at: new Date().toISOString()
  };
  await c.env.DB.prepare(
    "UPDATE webhooks SET url = ?, enabled = ?, event_types = ?, updated_at = ? WHERE webhook_id = ?"
  )
    .bind(next.url, next.enabled, next.event_types, next.updated_at, next.webhook_id)
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
