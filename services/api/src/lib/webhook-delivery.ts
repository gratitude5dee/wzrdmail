import { newId, signWebhook } from "@wzrdmail/core";
import type { Env } from "../env.js";

export const MAX_ATTEMPTS = 6;

/** Backoff before attempt N+1, indexed by the attempt that just failed (§8.2). */
export const RETRY_BACKOFF_MS = [30_000, 300_000, 1_800_000, 7_200_000, 28_800_000] as const;

const REQUEST_TIMEOUT_MS = 10_000;
const SWEEP_BATCH = 25;

/** In-flight rows are leased this long before the sweep may reclaim them. */
const CLAIM_LEASE_MS = 60_000;

const RETENTION_DAYS = 30;

export interface DeliveryRow {
  delivery_id: string;
  webhook_id: string;
  org_id: string;
  event_id: string;
  event_type: string;
  attempt: number;
  manual: number;
  status: string;
  response_status: number | null;
  error: string | null;
  duration_ms: number | null;
  next_retry_at: string | null;
  created_at: string;
  updated_at: string;
}

export const DELIVERY_COLUMNS =
  "delivery_id, webhook_id, org_id, event_id, event_type, attempt, manual, status, response_status, error, duration_ms, next_retry_at, created_at, updated_at";

export function deliveryJson(row: DeliveryRow): Record<string, unknown> {
  return {
    delivery_id: row.delivery_id,
    webhook_id: row.webhook_id,
    event_id: row.event_id,
    event_type: row.event_type,
    attempt: row.attempt,
    manual: row.manual === 1,
    status: row.status,
    response_status: row.response_status,
    error: row.error,
    duration_ms: row.duration_ms,
    next_retry_at: row.next_retry_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function eventMatches(eventTypes: string, type: string): boolean {
  try {
    const parsed = JSON.parse(eventTypes) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return true;
    return (parsed as string[]).includes(type);
  } catch {
    return true;
  }
}

/**
 * Build one pending-delivery insert per subscribed webhook, for the caller to
 * batch atomically with the event insert. Rows are durable before any HTTP
 * happens, so a crash between enqueue and attempt can never drop an event —
 * the sweep picks the row up by its due time.
 */
export async function deliveryEnqueueStatements(
  db: D1Database,
  event: { event_id: string; type: string; org_id: string; inbox_id?: string }
): Promise<D1PreparedStatement[]> {
  const hooks = (
    await db
      .prepare(
        `SELECT webhook_id, event_types FROM webhooks
         WHERE org_id = ? AND enabled = 1 AND deleted_at IS NULL
           AND (inbox_id IS NULL OR inbox_id = ?)`
      )
      .bind(event.org_id, event.inbox_id ?? null)
      .all<{ webhook_id: string; event_types: string }>()
  ).results.filter((h) => eventMatches(h.event_types, event.type));
  const now = new Date().toISOString();
  return hooks.map((h) =>
    db
      .prepare(
        `INSERT INTO webhook_deliveries
           (delivery_id, webhook_id, org_id, event_id, event_type, attempt, manual, status, next_retry_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 0, 'pending', ?, ?, ?)`
      )
      .bind(newId("whd"), h.webhook_id, event.org_id, event.event_id, event.type, now, now, now)
  );
}

interface AttemptOutcome {
  ok: boolean;
  response_status: number | null;
  error: string | null;
  duration_ms: number;
}

async function attemptHttp(
  webhook: { url: string; secret: string; headers: string },
  eventId: string,
  payload: string
): Promise<AttemptOutcome> {
  const start = Date.now();
  let custom: Record<string, string> = {};
  try {
    custom = JSON.parse(webhook.headers) as Record<string, string>;
  } catch {
    custom = {};
  }
  try {
    const signed = await signWebhook(
      webhook.secret,
      eventId,
      Math.floor(Date.now() / 1000),
      payload
    );
    const res = await fetch(webhook.url, {
      method: "POST",
      headers: { ...custom, "content-type": "application/json", ...signed },
      body: payload,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    return {
      ok: res.ok,
      response_status: res.status,
      error: res.ok ? null : `endpoint responded ${res.status}`,
      duration_ms: Date.now() - start
    };
  } catch (err) {
    const summary = err instanceof Error ? `${err.name}: ${err.message}` : "request failed";
    return {
      ok: false,
      response_status: null,
      error: summary.slice(0, 300),
      duration_ms: Date.now() - start
    };
  }
}

/**
 * Run one claimed pending row to completion: POST the signed original event
 * payload, finalize the row, and (for automatic deliveries that still have
 * attempts left) enqueue the next attempt with exponential backoff.
 */
async function runDelivery(env: Env, row: DeliveryRow): Promise<void> {
  const webhook = await env.DB.prepare(
    "SELECT url, secret, headers, enabled, deleted_at FROM webhooks WHERE webhook_id = ?"
  )
    .bind(row.webhook_id)
    .first<{ url: string; secret: string; headers: string; enabled: number; deleted_at: string | null }>();
  const event = await env.DB.prepare("SELECT payload FROM events WHERE event_id = ?")
    .bind(row.event_id)
    .first<{ payload: string }>();
  const now = new Date().toISOString();
  if (!webhook || webhook.deleted_at !== null || webhook.enabled !== 1 || !event) {
    await env.DB.prepare(
      `UPDATE webhook_deliveries SET status = 'failed', error = ?, next_retry_at = NULL, updated_at = ?
       WHERE delivery_id = ?`
    )
      .bind(!event ? "event no longer exists" : "webhook disabled or deleted", now, row.delivery_id)
      .run();
    return;
  }
  const outcome = await attemptHttp(webhook, row.event_id, event.payload);
  const done = new Date().toISOString();
  const retryable = !outcome.ok && row.manual === 0 && row.attempt < MAX_ATTEMPTS;
  const finalize = env.DB.prepare(
    `UPDATE webhook_deliveries
     SET status = ?, response_status = ?, error = ?, duration_ms = ?, next_retry_at = NULL, updated_at = ?
     WHERE delivery_id = ?`
  ).bind(
    outcome.ok ? "success" : "failed",
    outcome.response_status,
    outcome.error,
    outcome.duration_ms,
    done,
    row.delivery_id
  );
  const statements = [finalize];
  if (retryable) {
    const backoff = RETRY_BACKOFF_MS[row.attempt - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]!;
    const due = new Date(Date.now() + backoff).toISOString();
    statements.push(
      env.DB.prepare(
        `INSERT INTO webhook_deliveries
           (delivery_id, webhook_id, org_id, event_id, event_type, attempt, manual, status, next_retry_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?, ?)`
      ).bind(newId("whd"), row.webhook_id, row.org_id, row.event_id, row.event_type, row.attempt + 1, due, done, done)
    );
  }
  await env.DB.batch(statements);
}

/**
 * Claim a specific pending row (compare-and-set on the due time, which acts
 * as the lease) and run it. Returns whether this caller won the claim.
 */
export async function claimAndRun(env: Env, row: DeliveryRow): Promise<boolean> {
  const lease = new Date(Date.now() + CLAIM_LEASE_MS).toISOString();
  const claimed = await env.DB.prepare(
    `UPDATE webhook_deliveries SET next_retry_at = ?, updated_at = ?
     WHERE delivery_id = ? AND status = 'pending' AND next_retry_at IS ?`
  )
    .bind(lease, new Date().toISOString(), row.delivery_id, row.next_retry_at)
    .run();
  if (claimed.meta.changes === 0) return false;
  await runDelivery(env, row);
  return true;
}

/** Deliver every pending row that is due, oldest first. */
export async function processDueDeliveries(env: Env): Promise<number> {
  let processed = 0;
  for (;;) {
    const due = (
      await env.DB.prepare(
        `SELECT ${DELIVERY_COLUMNS} FROM webhook_deliveries
         WHERE status = 'pending' AND next_retry_at <= ?
         ORDER BY next_retry_at LIMIT ?`
      )
        .bind(new Date().toISOString(), SWEEP_BATCH)
        .all<DeliveryRow>()
    ).results;
    if (due.length === 0) return processed;
    for (const row of due) {
      if (await claimAndRun(env, row)) processed += 1;
    }
    if (due.length < SWEEP_BATCH) return processed;
  }
}

/** Retention: delivery rows older than 30 days are dropped. */
export async function pruneDeliveries(db: D1Database): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await db
    .prepare("DELETE FROM webhook_deliveries WHERE created_at < ? AND status != 'pending'")
    .bind(cutoff)
    .run();
}
