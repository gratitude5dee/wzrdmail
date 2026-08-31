import { ApiError, PLANS, type PlanName } from "@wzrdmail/core";
import { Hono } from "hono";
import { authenticate } from "../auth.js";
import type { Env } from "../env.js";

export const usage = new Hono<{ Bindings: Env }>();

const PERIODS = { "24h": 1, "7d": 7, "30d": 30 } as const;
type Period = keyof typeof PERIODS;

/** Current-month metrics vs plan limits — drives every console capacity bar. */
usage.get("/usage", async (c) => {
  const auth = await authenticate(c);
  const org = await c.env.DB.prepare("SELECT plan FROM organizations WHERE org_id = ?")
    .bind(auth.org_id)
    .first<{ plan: string }>();
  const plan = (org?.plan ?? "free") as PlanName;
  const limits = PLANS[plan] ?? PLANS.free;
  const month = new Date().toISOString().slice(0, 7);
  const counters = await c.env.DB.prepare(
    "SELECT metric, value FROM usage_counters WHERE org_id = ? AND month = ?"
  )
    .bind(auth.org_id, month)
    .all<{ metric: string; value: number }>();
  const byMetric = new Map(counters.results.map((r) => [r.metric, r.value]));
  const inboxCount = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM inboxes WHERE org_id = ? AND deleted_at IS NULL"
  )
    .bind(auth.org_id)
    .first<{ n: number }>();
  const domainCount = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM domains WHERE org_id = ?"
  )
    .bind(auth.org_id)
    .first<{ n: number }>();
  const cap = (n: number): number | null => (n === Number.MAX_SAFE_INTEGER ? null : n);
  return c.json({
    plan,
    month,
    usage: {
      inboxes: { used: inboxCount?.n ?? 0, limit: cap(limits.inboxes) },
      emails: {
        used: (byMetric.get("emails_sent") ?? 0) + (byMetric.get("emails_received") ?? 0),
        limit: cap(limits.emailsPerMonth)
      },
      emails_sent: { used: byMetric.get("emails_sent") ?? 0, limit: null },
      emails_received: { used: byMetric.get("emails_received") ?? 0, limit: null },
      storage_bytes: { used: byMetric.get("storage_bytes") ?? 0, limit: cap(limits.storageBytes) },
      custom_domains: { used: domainCount?.n ?? 0, limit: cap(limits.customDomains) },
      seats: { used: 1, limit: cap(limits.seats) }
    }
  });
});

/** SDK/CLI contract (§goal.md): month + flat metric list vs plan limits. */
usage.get("/metrics/usage", async (c) => {
  const auth = await authenticate(c);
  const org = await c.env.DB.prepare("SELECT plan FROM organizations WHERE org_id = ?")
    .bind(auth.org_id)
    .first<{ plan: string }>();
  const plan = (org?.plan ?? "free") as PlanName;
  const limits = PLANS[plan] ?? PLANS.free;
  const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
  const counters = await c.env.DB.prepare(
    "SELECT metric, value FROM usage_counters WHERE org_id = ? AND month = ?"
  )
    .bind(auth.org_id, month)
    .all<{ metric: string; value: number }>();
  const byMetric = new Map(counters.results.map((r) => [r.metric, r.value]));
  const inboxCount = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM inboxes WHERE org_id = ? AND deleted_at IS NULL"
  )
    .bind(auth.org_id)
    .first<{ n: number }>();
  const cap = (n: number): number | null => (n === Number.MAX_SAFE_INTEGER ? null : n);
  return c.json({
    month,
    metrics: [
      { metric: "inboxes", used: inboxCount?.n ?? 0, limit: cap(limits.inboxes) },
      {
        metric: "emails",
        used: (byMetric.get("emails_sent") ?? 0) + (byMetric.get("emails_received") ?? 0),
        limit: cap(limits.emailsPerMonth)
      },
      { metric: "emails_sent", used: byMetric.get("emails_sent") ?? 0, limit: null },
      { metric: "emails_received", used: byMetric.get("emails_received") ?? 0, limit: null },
      {
        metric: "storage_bytes",
        used: byMetric.get("storage_bytes") ?? 0,
        limit: cap(limits.storageBytes)
      }
    ]
  });
});

/** Event-count aggregates bucketed by day (hour for 24h) for charts. */
usage.get("/metrics", async (c) => {
  const auth = await authenticate(c);
  const period = (c.req.query("period") ?? "7d") as Period;
  const days = PERIODS[period];
  if (!days) throw new ApiError("validation_error", "period must be one of 24h, 7d, 30d");
  const inboxId = c.req.query("inbox_id") ?? null;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const bucket = period === "24h" ? "%Y-%m-%dT%H:00" : "%Y-%m-%d";
  const rows = await c.env.DB.prepare(
    `SELECT strftime('${bucket}', created_at) AS bucket, type, COUNT(*) AS n
     FROM events
     WHERE org_id = ? AND created_at >= ? ${inboxId ? "AND inbox_id = ?" : ""}
     GROUP BY bucket, type ORDER BY bucket`
  )
    .bind(...(inboxId ? [auth.org_id, since, inboxId] : [auth.org_id, since]))
    .all<{ bucket: string; type: string; n: number }>();
  const totals: Record<string, number> = {};
  for (const row of rows.results) {
    totals[row.type] = (totals[row.type] ?? 0) + row.n;
  }
  return c.json({
    period,
    since,
    totals,
    series: rows.results.map((r) => ({ bucket: r.bucket, type: r.type, count: r.n }))
  });
});
