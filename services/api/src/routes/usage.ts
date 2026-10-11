import { ApiError, PLANS, type PlanName } from "@wzrdmail/core";
import { Hono } from "hono";
import { authenticate } from "../auth.js";
import type { Env } from "../env.js";

export const usage = new Hono<{ Bindings: Env }>();

const PERIODS = { "24h": 1, "7d": 7, "30d": 30 } as const;
type Period = keyof typeof PERIODS;

/** Usage counters are org-wide, so pod-scoped keys may not read them. */
function requireOrgScope(auth: { pod_id: string | null }): void {
  if (auth.pod_id) {
    throw new ApiError("forbidden", "usage metrics require an organization-scoped key");
  }
}

/** Current-month metrics vs plan limits — drives every console capacity bar. */
usage.get("/usage", async (c) => {
  const auth = await authenticate(c);
  requireOrgScope(auth);
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
  requireOrgScope(auth);
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
  const currentMonth = new Date().toISOString().slice(0, 7);
  // Inbox counts are a point-in-time resource, not a metered counter, so they
  // are only reported for the current month.
  const inboxCount =
    month === currentMonth
      ? await c.env.DB.prepare(
          "SELECT COUNT(*) AS n FROM inboxes WHERE org_id = ? AND deleted_at IS NULL"
        )
          .bind(auth.org_id)
          .first<{ n: number }>()
      : null;
  const cap = (n: number): number | null => (n === Number.MAX_SAFE_INTEGER ? null : n);
  return c.json({
    month,
    metrics: [
      ...(inboxCount !== null
        ? [{ metric: "inboxes", used: inboxCount.n, limit: cap(limits.inboxes) }]
        : []),
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

function parseIsoParam(value: string, param: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new ApiError("validation_error", `${param} must be an ISO timestamp`);
  }
  return new Date(ms).toISOString();
}

/**
 * Event-count aggregates bucketed by day/hour for charts (spec §4 metrics):
 * since/until bound the window (period still sets the default span and
 * granularity), type/inbox_id/pod_id filter the counted events.
 */
usage.get("/metrics", async (c) => {
  const auth = await authenticate(c);
  requireOrgScope(auth);
  const period = (c.req.query("period") ?? "7d") as Period;
  const days = PERIODS[period];
  if (!days) throw new ApiError("validation_error", "period must be one of 24h, 7d, 30d");
  const granularity = c.req.query("granularity") ?? (period === "24h" ? "hour" : "day");
  if (granularity !== "hour" && granularity !== "day") {
    throw new ApiError("validation_error", "granularity must be hour or day");
  }
  const sinceParam = c.req.query("since");
  const untilParam = c.req.query("until");
  const since = sinceParam
    ? parseIsoParam(sinceParam, "since")
    : new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const until = untilParam
    ? parseIsoParam(untilParam, "until")
    : new Date().toISOString();
  const inboxId = c.req.query("inbox_id") ?? null;
  const podId = c.req.query("pod_id") ?? null;
  const types = (c.req.query("type") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  const bucket = granularity === "hour" ? "%Y-%m-%dT%H:00" : "%Y-%m-%d";
  const conditions = ["org_id = ?", "created_at >= ?", "created_at <= ?"];
  const binds: string[] = [auth.org_id, since, until];
  if (inboxId) {
    conditions.push("inbox_id = ?");
    binds.push(inboxId);
  }
  if (podId) {
    conditions.push("pod_id = ?");
    binds.push(podId);
  }
  if (types.length > 0) {
    conditions.push(`type IN (${types.map(() => "?").join(",")})`);
    binds.push(...types);
  }
  const rows = await c.env.DB.prepare(
    `SELECT strftime('${bucket}', created_at) AS bucket, type, COUNT(*) AS n
     FROM events
     WHERE ${conditions.join(" AND ")}
     GROUP BY bucket, type ORDER BY bucket`
  )
    .bind(...binds)
    .all<{ bucket: string; type: string; n: number }>();
  const totals: Record<string, number> = {};
  for (const row of rows.results) {
    totals[row.type] = (totals[row.type] ?? 0) + row.n;
  }
  return c.json({
    period,
    granularity,
    since,
    until,
    totals,
    series: rows.results.map((r) => ({ bucket: r.bucket, type: r.type, count: r.n }))
  });
});
