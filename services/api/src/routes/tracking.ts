import { ApiError } from "@wzrdmail/core";
import { Hono } from "hono";
import type { Env } from "../env.js";
import { emitEvent } from "../lib/events.js";
import {
  OPEN_DEDUPE_TTL_S,
  PIXEL_GIF,
  clickSignature,
  openDedupeKey,
  openToken,
  tokenEquals,
  trackingSecret
} from "../lib/tracking.js";

/**
 * Public open/click tracking endpoints (spec §4): unauthenticated by design —
 * the truncated-HMAC tokens in each URL are the capability. They are mounted
 * under /v0 alongside the authenticated routes.
 */
export const tracking = new Hono<{ Bindings: Env }>();

const PIXEL_HEADERS = {
  "content-type": "image/gif",
  "cache-control": "no-store, no-cache, must-revalidate",
  pragma: "no-cache",
  expires: "0",
  "x-content-type-options": "nosniff"
};

interface TrackedMessage {
  org_id: string;
  pod_id: string;
  inbox_id: string;
  thread_id: string;
}

async function trackedMessage(db: D1Database, msgId: string): Promise<TrackedMessage | null> {
  // Only outbound rows can produce tracking hits: a valid token alone never
  // mints counters on inbound mail.
  return db
    .prepare(
      "SELECT org_id, pod_id, inbox_id, thread_id FROM messages WHERE msg_id = ? AND direction = 'outbound'"
    )
    .bind(msgId)
    .first<TrackedMessage>();
}

function messagePayload(msg: TrackedMessage, msgId: string): Record<string, unknown> {
  return {
    message_id: msgId,
    inbox_id: msg.inbox_id,
    thread_id: msg.thread_id,
    organization_id: msg.org_id,
    pod_id: msg.pod_id,
    direction: "outbound"
  };
}

tracking.get("/o/:msg_id/:tok", async (c) => {
  const msgId = c.req.param("msg_id");
  const secret = trackingSecret(c.env);
  if (!tokenEquals(await openToken(msgId, secret), c.req.param("tok"))) {
    throw new ApiError("not_found", "no such resource");
  }
  const msg = await trackedMessage(c.env.DB, msgId);
  if (!msg) throw new ApiError("not_found", "no such resource");

  // Consecutive opens by the same client within the window count once —
  // mail scanners and image reloads must not inflate x_open_count.
  const ua = c.req.header("user-agent") ?? "";
  let fresh = true;
  try {
    const key = await openDedupeKey(msgId, ua);
    fresh = (await c.env.CACHE.get(key)) === null;
    if (fresh) await c.env.CACHE.put(key, "1", { expirationTtl: OPEN_DEDUPE_TTL_S });
  } catch {
    // KV unavailable: count the open rather than fail the pixel.
    fresh = true;
  }

  if (fresh) {
    const now = new Date().toISOString();
    await c.env.DB.prepare(
      "UPDATE messages SET x_open_count = x_open_count + 1, x_last_opened_at = ?, updated_at = ? WHERE msg_id = ?"
    )
      .bind(now, now, msgId)
      .run();
    await emitEvent(c.env.DB, {
      type: "message.opened",
      org_id: msg.org_id,
      pod_id: msg.pod_id,
      inbox_id: msg.inbox_id,
      data: { message: messagePayload(msg, msgId), user_agent: ua || null }
    });
  }

  return new Response(PIXEL_GIF, { headers: PIXEL_HEADERS });
});

tracking.get("/c/:msg_id/:sig", async (c) => {
  const msgId = c.req.param("msg_id");
  const url = c.req.query("u") ?? "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiError("validation_error", "u must be a valid URL");
  }
  // Open-redirect hardening: only http(s) targets, no control characters that
  // could smuggle extra response headers into the 302.
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || /[\x00-\x1f\x7f]/.test(url)) {
    throw new ApiError("validation_error", "u must be an http(s) URL");
  }
  const secret = trackingSecret(c.env);
  if (!tokenEquals(await clickSignature(msgId, url, secret), c.req.param("sig"))) {
    throw new ApiError("not_found", "no such resource");
  }
  const msg = await trackedMessage(c.env.DB, msgId);
  if (!msg) throw new ApiError("not_found", "no such resource");

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE messages SET x_click_count = x_click_count + 1, x_last_clicked_at = ?, updated_at = ? WHERE msg_id = ?"
  )
    .bind(now, now, msgId)
    .run();
  await emitEvent(c.env.DB, {
    type: "message.clicked",
    org_id: msg.org_id,
    pod_id: msg.pod_id,
    inbox_id: msg.inbox_id,
    data: { message: messagePayload(msg, msgId), url }
  });

  return c.redirect(url, 302);
});
