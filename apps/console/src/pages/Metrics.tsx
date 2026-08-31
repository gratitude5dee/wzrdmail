import { useEffect, useState } from "react";
import { api, type Metrics, type Usage } from "../api";
import { CapacityBar } from "../components/CapacityBar";

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

  const buckets = new Map<string, { sent: number; received: number }>();
  for (const point of metrics?.series ?? []) {
    const entry = buckets.get(point.bucket) ?? { sent: 0, received: 0 };
    if (point.type === "message.sent") entry.sent += point.count;
    if (point.type === "message.received") entry.received += point.count;
    buckets.set(point.bucket, entry);
  }
  const chart = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b));
  const max = Math.max(1, ...chart.map(([, v]) => Math.max(v.sent, v.received)));

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
          <>
            <div className="bars">
              {chart.map(([bucket, v]) => (
                <div key={bucket} style={{ flex: 1, display: "flex", gap: 1, alignItems: "flex-end" }}>
                  <div
                    className="bar"
                    title={`${bucket}: ${v.sent} sent`}
                    style={{ height: `${(v.sent / max) * 100}%` }}
                  />
                  <div
                    className="bar recv"
                    title={`${bucket}: ${v.received} received`}
                    style={{ height: `${(v.received / max) * 100}%` }}
                  />
                </div>
              ))}
            </div>
            <div className="dim" style={{ marginTop: 6 }}>
              <span className="chip accent">sent</span>{" "}
              <span className="chip green">received</span>
            </div>
          </>
        )}
      </div>

      <div className="grid two" style={{ marginBottom: 14 }}>
        <div className="card">
          <h3>Deliverability</h3>
          <p>
            Successful: <b>{sent === 0 ? "—" : `${(100 - bounceRate).toFixed(1)}%`}</b>
          </p>
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
