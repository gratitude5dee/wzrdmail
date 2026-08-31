import { newId, type EventType } from "@wzrdmail/core";

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
 * Write one immutable event row (§8.1). Queue fanout to webhooks/WS is M3;
 * until then the events table is the delivery log consumers poll.
 */
export async function emitEvent(db: D1Database, input: EmitEventInput): Promise<string> {
  const built = buildEvent(input);
  await db
    .prepare(
      "INSERT INTO events (event_id, type, org_id, pod_id, inbox_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(...built.values)
    .run();
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
