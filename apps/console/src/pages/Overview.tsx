import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Metrics, type Thread, type Usage } from "../api";
import { CapacityBar } from "../components/CapacityBar";
import { useSession } from "../session";

const PERIODS = ["24h", "7d", "30d"] as const;

export function OverviewPage() {
  const { session } = useSession();
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
  const received = t["message.received"] ?? 0;
  const bounced = t["message.bounced"] ?? 0;
  const rejected = t["message.rejected"] ?? 0;
  const complained = t["message.complained"] ?? 0;

  return (
    <div>
      <div className="page-head">
        <h1>The day in view, {session.name || session.email}.</h1>
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
        <div className="card" style={{ marginBottom: 14 }}>
          <b>Verify your organization</b>{" "}
          <span className="dim">
            — unverified orgs can only email {session.email}. Check your inbox for the
            verification code, or resend it via the API.
          </span>
        </div>
      )}

      <div className="grid stats" style={{ marginBottom: 14 }}>
        <div className="card stat">
          <div className="label">Messages sent</div>
          <div className="value">{sent}</div>
        </div>
        <div className="card stat">
          <div className="label">Messages received</div>
          <div className="value">{received}</div>
        </div>
        <div className="card stat">
          <div className="label">Bounced</div>
          <div className="value">{bounced}</div>
        </div>
        <div className="card stat">
          <div className="label">Rejected</div>
          <div className="value">{rejected}</div>
        </div>
        <div className="card stat">
          <div className="label">Complained</div>
          <div className="value">{complained}</div>
        </div>
      </div>

      <div className="grid two">
        <div className="card">
          <h3>Delivery health</h3>
          {sent + received + bounced === 0 ? (
            <div className="empty">No mail activity in this period.</div>
          ) : (
            <ul>
              <li>Delivered / sent: {sent}</li>
              <li>Bounced: {bounced}</li>
              <li>Complaints: {complained}</li>
            </ul>
          )}
        </div>
        <div className="card">
          <h3>Resources</h3>
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
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
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
  );
}
