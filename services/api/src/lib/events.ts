import { newId, type EventType } from "@wzrdmail/core";
import { enqueueDeliveries } from "./webhook-delivery.js";

export interface EmitEventInput {
  type: EventType;
  org_id: string;
  pod_id: string;
  inbox_id?: string;
  data: Record<string, unknown>;
}

/**
 * Write one immutable event row (§8.1) and enqueue one pending
 * webhook_deliveries row per subscribed webhook. The HTTP attempts happen
 * out of band (processDueDeliveries via waitUntil / the scheduled sweep),
 * so an event is never dropped: its delivery rows are durable first.
 */
export async function emitEvent(db: D1Database, input: EmitEventInput): Promise<string> {
  const eventId = newId("evt");
  const createdAt = new Date().toISOString();
  const envelope = {
    event_id: eventId,
    type: input.type,
    created_at: createdAt,
    organization_id: input.org_id,
    pod_id: input.pod_id,
    ...(input.inbox_id ? { inbox_id: input.inbox_id } : {}),
    data: input.data
  };
  await db
    .prepare(
      "INSERT INTO events (event_id, type, org_id, pod_id, inbox_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(
      eventId,
      input.type,
      input.org_id,
      input.pod_id,
      input.inbox_id ?? null,
      JSON.stringify(envelope),
      createdAt
    )
    .run();
  await enqueueDeliveries(db, {
    event_id: eventId,
    type: input.type,
    org_id: input.org_id,
    inbox_id: input.inbox_id
  });
  return eventId;
}

export async function bumpUsage(
  db: D1Database,
  orgId: string,
  metric: string,
  delta: number
): Promise<void> {
  const month = new Date().toISOString().slice(0, 7);
  await db
    .prepare(
      `INSERT INTO usage_counters (org_id, month, metric, value) VALUES (?, ?, ?, ?)
       ON CONFLICT (org_id, month, metric) DO UPDATE SET value = value + excluded.value`
    )
    .bind(orgId, month, metric, delta)
    .run();
}
