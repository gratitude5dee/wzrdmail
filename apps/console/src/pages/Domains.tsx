import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiRequestError, api, apiAll, type DnsCheck, type Domain } from "../api";
import { useSession } from "../session";

function statusChip(status: Domain["status"]) {
  const cls = status === "verified" ? "chip green" : status === "failed" ? "chip red" : "chip";
  return <span className={cls}>{status}</span>;
}

function DnsRecordsTable({ domain, checks }: { domain: Domain; checks?: DnsCheck[] }) {
  const checkFor = (name: string, type: string) =>
    checks?.find((c) => c.name === name && c.type === type);
  return (
    <table>
      <thead>
        <tr>
          <th>Type</th>
          <th>Name</th>
          <th>Value</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {domain.dns_records.map((rec) => {
          const check = checkFor(rec.name, rec.type);
          const value = rec.priority !== undefined ? `${rec.priority} ${rec.value}` : rec.value;
          return (
            <tr key={`${rec.type}-${rec.name}`}>
              <td className="mono">{rec.type}</td>
              <td className="mono">{rec.name}</td>
              <td className="mono">
                {value}{" "}
                <button
                  className="btn"
                  style={{ padding: "0 6px" }}
                  onClick={() => void navigator.clipboard.writeText(rec.value)}
                >
                  copy
                </button>
              </td>
              <td>
                {check &&
                  (check.ok ? (
                    <span className="chip green">found</span>
                  ) : (
                    <span className="chip red">missing</span>
                  ))}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function DomainsPage() {
  const { session } = useSession();
  const gated = session.plan === "free";
  const [domains, setDomains] = useState<Domain[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, DnsCheck[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setDomains(await apiAll<Domain>("/domains?limit=100", "domains"));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await api<Domain>("/domains", {
        method: "POST",
        body: JSON.stringify({ domain: name.trim() })
      });
      setAdding(false);
      setName("");
      setExpanded(created.domain_id);
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "could not add domain");
    } finally {
      setBusy(false);
    }
  };

  const verify = async (domain: Domain) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<Domain & { checks: DnsCheck[] }>(
        `/domains/${domain.domain_id}/verify`,
        { method: "POST", body: JSON.stringify({}) }
      );
      setChecks((prev) => ({ ...prev, [domain.domain_id]: res.checks }));
      setExpanded(domain.domain_id);
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "verification check failed");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (domain: Domain) => {
    if (!window.confirm(`Remove ${domain.name}? Inboxes on it can no longer be created.`)) return;
    setError(null);
    try {
      await api(`/domains/${domain.domain_id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "could not remove domain");
    }
  };

  return (
    <div>
      <div className="page-head">
        <h1>Domains</h1>
        <div className="actions">
          <button className="btn primary" disabled={gated} onClick={() => setAdding(true)}>
            + Add Domain
          </button>
        </div>
      </div>

      {gated && (
        <div className="card" style={{ marginBottom: 14 }}>
          <b>Custom domains require a paid plan.</b>{" "}
          <span className="dim">
            Upgrade to Developer or Startup to send from your own domain.
          </span>{" "}
          <Link to="/upgrade">Compare plans ↗</Link>
        </div>
      )}

      {error && (
        <div className="card" style={{ marginBottom: 14 }}>
          <span className="chip red">error</span> {error}
        </div>
      )}

      {adding && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>Add a domain</h3>
          <p className="dim">
            Enter a domain you control (e.g. <span className="mono">mail.acme.com</span>). You
            will get DNS records to create; once they resolve, hit Verify.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="mono"
              placeholder="acme.com"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) void add();
              }}
            />
            <button className="btn primary" disabled={busy || !name.trim()} onClick={() => void add()}>
              Add
            </button>
            <button className="btn" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {domains.length === 0 ? (
        <div className="card empty">
          <h3>No custom domains yet</h3>
          Every organization can use <span className="mono">@wzrd.tech</span> out of the box. Add
          your own domain to create inboxes like <span className="mono">bot@acme.com</span>.
        </div>
      ) : (
        domains.map((domain) => (
          <div key={domain.domain_id} className="card" style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <b className="mono">{domain.name}</b>
              {statusChip(domain.status)}
              <span style={{ flex: 1 }} />
              <button
                className="btn"
                onClick={() =>
                  setExpanded(expanded === domain.domain_id ? null : domain.domain_id)
                }
              >
                {expanded === domain.domain_id ? "Hide records" : "DNS records"}
              </button>
              {domain.status !== "verified" && (
                <button className="btn primary" disabled={busy} onClick={() => void verify(domain)}>
                  Verify
                </button>
              )}
              <button className="btn" onClick={() => void remove(domain)}>
                Delete
              </button>
            </div>
            {domain.status === "failed" && domain.failure_reason && (
              <p className="dim" style={{ marginTop: 8 }}>
                {domain.failure_reason}
                {domain.last_checked_at && ` (last checked ${domain.last_checked_at})`}
              </p>
            )}
            {expanded === domain.domain_id && (
              <div style={{ marginTop: 12 }}>
                <p className="dim">
                  Create these records at your DNS provider, then Verify. Records are checked over
                  DNS-over-HTTPS; propagation can take a few minutes.
                </p>
                <DnsRecordsTable domain={domain} checks={checks[domain.domain_id]} />
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
