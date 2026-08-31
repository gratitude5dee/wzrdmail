import { newId, type EventType } from "@wzrdmail/core";
import { deliveryEnqueueStatements } from "./webhook-delivery.js";

export interface EmitEventInput {
  type: EventType;
  org_id: string;
  pod_id: string;
  inbox_id?: string;
  data: Record<string, unknown>;
}

export interface BuiltEvent {
  event_id: string;
  created_at: string;
  values: [string, string, string, string, string | null, string, string];
}

export function buildEvent(input: EmitEventInput): BuiltEvent {
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
  return {
    event_id: eventId,
    created_at: createdAt,
    values: [
      eventId,
      input.type,
      input.org_id,
      input.pod_id,
      input.inbox_id ?? null,
      JSON.stringify(envelope),
      createdAt
    ]
  };
}

/**
 * Write one immutable event row (§8.1) and enqueue one pending
 * webhook_deliveries row per subscribed webhook, atomically. The HTTP
 * attempts happen out of band (processDueDeliveries via waitUntil / the
 * scheduled sweep), so an event is never dropped: its delivery rows are
 * durable first.
 */
export async function emitEvent(db: D1Database, input: EmitEventInput): Promise<string> {
  const built = buildEvent(input);
  const eventInsert = db
    .prepare(
      "INSERT INTO events (event_id, type, org_id, pod_id, inbox_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(...built.values);
  const deliveryInserts = await deliveryEnqueueStatements(db, {
    event_id: built.event_id,
    type: input.type,
    org_id: input.org_id,
    inbox_id: input.inbox_id
  });
  await db.batch([eventInsert, ...deliveryInserts]);
  return built.event_id;
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
