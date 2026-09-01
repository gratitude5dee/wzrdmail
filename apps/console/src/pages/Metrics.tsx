import { useEffect, useState } from "react";
import { api, type Metrics, type Usage } from "../api";
import { ActivityChart, type ActivityPoint } from "../components/ActivityChart";
import { CapacityBar } from "../components/CapacityBar";
import { HealthRing } from "../components/HealthRing";

const PERIODS = ["24h", "7d", "30d"] as const;

export function MetricsPage() {
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>("7d");
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);

  useEffect(() => {
    void api<Metrics>(`/metrics?period=${period}`).then(setMetrics).catch(() => setMetrics(null));
  }, [period]);
  useEffect(() => {
    void api<Usage>("/usage").then(setUsage).catch(() => setUsage(null));
  }, []);

  const totals = metrics?.totals ?? {};
  const sent = totals["message.sent"] ?? 0;
  const received = totals["message.received"] ?? 0;
  const bounced = totals["message.bounced"] ?? 0;
  const complained = totals["message.complained"] ?? 0;
  const rejected = totals["message.rejected"] ?? 0;
  const bounceRate = sent === 0 ? 0 : (bounced / sent) * 100;
  const complaintRate = sent === 0 ? 0 : (complained / sent) * 100;

  const buckets = new Map<string, ActivityPoint>();
  for (const point of metrics?.series ?? []) {
    const entry = buckets.get(point.bucket) ?? { bucket: point.bucket, sent: 0, received: 0 };
    if (point.type === "message.sent") entry.sent += point.count;
    if (point.type === "message.received") entry.received += point.count;
    buckets.set(point.bucket, entry);
  }
  const chart = [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));

  return (
    <div>
      <div className="page-head">
        <h1>Metrics</h1>
        <div className="actions">
          {PERIODS.map((p) => (
            <button
              key={p}
              className={`btn sm${p === period ? " primary" : ""}`}
              onClick={() => setPeriod(p)}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      <div className="grid stats" style={{ marginBottom: 14 }}>
        <div className="card stat">
          <div className="label">Sent</div>
          <div className="value">{sent}</div>
        </div>
        <div className="card stat">
          <div className="label">Received</div>
          <div className="value">{received}</div>
        </div>
        <div className="card stat">
          <div className="label">Bounced</div>
          <div className="value">{bounced}</div>
        </div>
        <div className="card stat">
          <div className="label">Complained</div>
          <div className="value">{complained}</div>
        </div>
        <div className="card stat">
          <div className="label">Rejected</div>
          <div className="value">{rejected}</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Email activity</h3>
        {chart.length === 0 ? (
          <div className="empty">No activity in this period.</div>
        ) : (
          <ActivityChart points={chart} />
        )}
      </div>

      <div className="grid two" style={{ marginBottom: 14 }}>
        <div className="card">
          <h3>Deliverability</h3>
          <HealthRing percent={sent === 0 ? null : Math.max(0, 100 - bounceRate)} label="Successful" />
          <p>
            Bounce rate: <b className={bounceRate >= 5 ? "error" : ""}>{bounceRate.toFixed(2)}%</b>{" "}
            <span className="dim">(risk at 5%)</span>
          </p>
          <p>
            Complaint rate:{" "}
            <b className={complaintRate >= 0.1 ? "error" : ""}>{complaintRate.toFixed(3)}%</b>{" "}
            <span className="dim">(risk at 0.1%)</span>
          </p>
        </div>
        <div className="card">
          <h3>Resources</h3>
          {usage ? (
            <>
              <div className="dim">Inboxes</div>
              <CapacityBar
                used={usage.usage.inboxes?.used ?? 0}
                limit={usage.usage.inboxes?.limit ?? null}
                unit="inboxes"
              />
              <div className="dim">Emails ({usage.month})</div>
              <CapacityBar
                used={usage.usage.emails?.used ?? 0}
                limit={usage.usage.emails?.limit ?? null}
                unit="emails"
              />
              <div className="dim">Storage</div>
              <CapacityBar
                used={Math.round((usage.usage.storage_bytes?.used ?? 0) / (1024 * 1024))}
                limit={
                  usage.usage.storage_bytes?.limit === null ||
                  usage.usage.storage_bytes?.limit === undefined
                    ? null
                    : Math.round(usage.usage.storage_bytes.limit / (1024 * 1024))
                }
                unit="MB"
              />
            </>
          ) : (
            <div className="dim">Loading…</div>
          )}
        </div>
      </div>
    </div>
  );
}
