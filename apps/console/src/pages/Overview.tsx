import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type Metrics, type Thread, type Usage } from "../api";
import { ActivityChart, type ActivityPoint } from "../components/ActivityChart";
import { CapacityBar } from "../components/CapacityBar";
import { HealthRing } from "../components/HealthRing";
import { Icon, ICON_PATHS } from "../components/Icon";
import GlassIcons from "../components/reactbits/GlassIcons";
import { useSession } from "../session";

function QuickIcon({ d }: { d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}

const PERIODS = ["24h", "7d", "30d"] as const;

const STATS: { key: string; label: string; tone: string }[] = [
  { key: "message.sent", label: "Messages sent", tone: "sent" },
  { key: "message.received", label: "Messages received", tone: "recv" },
  { key: "message.bounced", label: "Bounced", tone: "bad" },
  { key: "message.rejected", label: "Rejected", tone: "warn" },
  { key: "message.complained", label: "Complained", tone: "alt" }
];

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "Night watch";
  if (h < 12) return "Morning pulse";
  if (h < 18) return "Afternoon pulse";
  return "Evening pulse";
}

export function OverviewPage() {
  const { session } = useSession();
  const navigate = useNavigate();
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>("24h");
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);

  useEffect(() => {
    void api<Metrics>(`/metrics?period=${period}`).then(setMetrics).catch(() => setMetrics(null));
  }, [period]);
  useEffect(() => {
    void api<Usage>("/usage").then(setUsage).catch(() => setUsage(null));
    void api<{ threads: Thread[] }>("/threads?limit=5")
      .then((r) => setThreads(r.threads))
      .catch(() => setThreads([]));
  }, []);

  const t = metrics?.totals ?? {};
  const sent = t["message.sent"] ?? 0;
  const bounced = t["message.bounced"] ?? 0;
  const complained = t["message.complained"] ?? 0;

  const buckets = new Map<string, ActivityPoint>();
  for (const point of metrics?.series ?? []) {
    const entry = buckets.get(point.bucket) ?? { bucket: point.bucket, sent: 0, received: 0 };
    if (point.type === "message.sent") entry.sent += point.count;
    if (point.type === "message.received") entry.received += point.count;
    buckets.set(point.bucket, entry);
  }
  const chart = [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));

  const successPct = sent === 0 ? null : Math.max(0, 100 - (bounced / sent) * 100);
  const firstName = (session.name || session.email).split(/[@\s]/)[0] ?? "";

  return (
    <div>
      <div className="page-head">
        <h1>
          {greeting()}, {firstName}.
        </h1>
        <div className="actions">
          {PERIODS.map((p) => (
            <button key={p} className={`btn sm${p === period ? " primary" : ""}`} onClick={() => setPeriod(p)}>
              {p}
            </button>
          ))}
          <Link className="btn sm" to="/metrics">
            View metrics →
          </Link>
        </div>
      </div>

      {!session.verified && (
        <div className="card notice" style={{ marginBottom: 14 }}>
          <b>Verify your organization</b>{" "}
          <span className="dim">
            — unverified orgs can only email {session.email}. Check your inbox for the
            verification code, or resend it via the API.
          </span>
        </div>
      )}

      <div className="overview-grid">
        <div className="overview-main">
          <div className="stat-strip">
            {STATS.map((s) => (
              <div key={s.key} className="stat-cell">
                <span className="label">
                  <i className={`dot ${s.tone}`} />
                  {s.label}
                </span>
                <span className="value">{t[s.key] ?? 0}</span>
              </div>
            ))}
          </div>

          <div className="card" style={{ marginBottom: 14 }}>
            {chart.length === 0 ? (
              <div className="empty">No mail activity in this period.</div>
            ) : (
              <ActivityChart points={chart} />
            )}
          </div>

          <div className="card" style={{ marginBottom: 14, paddingBottom: 4 }}>
            <h3 style={{ marginTop: 0 }}>Quick actions</h3>
            <GlassIcons
              items={[
                { icon: <QuickIcon d={ICON_PATHS.inbox} />, color: "indigo", label: "Inboxes", onClick: () => navigate("/inboxes") },
                { icon: <QuickIcon d={ICON_PATHS.globe} />, color: "blue", label: "Domains", onClick: () => navigate("/domains") },
                { icon: <QuickIcon d={ICON_PATHS.zap} />, color: "orange", label: "Webhooks", onClick: () => navigate("/webhooks") },
                { icon: <QuickIcon d={ICON_PATHS.key} />, color: "purple", label: "API keys", onClick: () => navigate("/api-keys") },
                { icon: <QuickIcon d={ICON_PATHS.shield} />, color: "green", label: "Lists", onClick: () => navigate("/lists") },
                { icon: <QuickIcon d={ICON_PATHS.chart} />, color: "red", label: "Metrics", onClick: () => navigate("/metrics") }
              ]}
            />
          </div>

          <div className="card">
            <div className="page-head" style={{ marginBottom: 8 }}>
              <h3 style={{ margin: 0 }}>Latest conversations</h3>
              <Link to="/inboxes">View all →</Link>
            </div>
            {threads.length === 0 ? (
              <div className="empty">
                <h3>No conversations yet</h3>
                Send your inbox its first email and it will appear here.
              </div>
            ) : (
              <table>
                <tbody>
                  {threads.map((th) => (
                    <tr
                      key={th.thread_id}
                      className="clickable"
                      onClick={() => {
                        window.location.href = `/inboxes/${encodeURIComponent(th.inbox_id)}/threads/${th.thread_id}`;
                      }}
                    >
                      <td>
                        <div className="thread-row">
                          {th.labels.includes("unread") && <span className="chip accent">unread</span>}
                          <span className="subject">{th.subject || "(no subject)"}</span>
                          <span className="snippet">{th.preview}</span>
                        </div>
                      </td>
                      <td className="dim" style={{ whiteSpace: "nowrap" }}>
                        {new Date(th.last_message_at).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <aside className="overview-side">
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Delivery health</h3>
            <HealthRing percent={successPct} label="Successful" />
            <div className="health-cells">
              <div className="stat-cell">
                <span className="label">Delivered</span>
                <span className="value">{sent}</span>
              </div>
              <div className="stat-cell">
                <span className="label">Failed</span>
                <span className="value">{bounced}</span>
              </div>
              <div className="stat-cell">
                <span className="label">Complaints</span>
                <span className="value">{complained}</span>
              </div>
            </div>
            <Link className="side-link" to="/metrics">
              View details →
            </Link>
          </div>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>
              Resources <span className="dim" style={{ fontWeight: 400 }}>· organization capacity</span>
            </h3>
            {usage ? (
              <>
                <div className="dim">Active inboxes</div>
                <CapacityBar
                  used={usage.usage.inboxes?.used ?? 0}
                  limit={usage.usage.inboxes?.limit ?? null}
                  unit="inboxes"
                />
                <div className="dim">Emails this month</div>
                <CapacityBar
                  used={usage.usage.emails?.used ?? 0}
                  limit={usage.usage.emails?.limit ?? null}
                  unit="emails"
                />
              </>
            ) : (
              <div className="dim">Loading…</div>
            )}
            <Link className="side-link" to="/upgrade">
              Review usage →
            </Link>
          </div>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Add a custom domain</h3>
            <p className="dim" style={{ marginTop: 4 }}>
              Send from your own domain.
            </p>
            <Link className="btn sm" to="/domains">
              <Icon name="globe" /> Set up →
            </Link>
          </div>
        </aside>
      </div>
    </div>
  );
}
