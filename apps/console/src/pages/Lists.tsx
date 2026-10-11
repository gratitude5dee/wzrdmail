import { useCallback, useEffect, useState } from "react";
import {
  ApiRequestError,
  api,
  apiAll,
  type Inbox,
  type ListEntry,
  type Suppression
} from "../api";

const TABS = ["Receive policy", "Suppressions"] as const;

export function ListsPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Receive policy");
  return (
    <div>
      <div className="page-head">
        <h1>Lists</h1>
      </div>
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t} className={t === tab ? "active" : ""} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {tab === "Receive policy" ? <PolicyLists /> : <SuppressionsList />}
    </div>
  );
}

const KIND_FILTERS = ["All", "Allow", "Block"] as const;
const SCOPE_FILTERS = ["All", "Org-wide", "Per inbox"] as const;

function PolicyLists() {
  const [entries, setEntries] = useState<ListEntry[]>([]);
  const [inboxes, setInboxes] = useState<Inbox[]>([]);
  const [kindFilter, setKindFilter] = useState<(typeof KIND_FILTERS)[number]>("All");
  const [scopeFilter, setScopeFilter] = useState<(typeof SCOPE_FILTERS)[number]>("All");
  const [adding, setAdding] = useState(false);
  const [pattern, setPattern] = useState("");
  const [kind, setKind] = useState<"allow" | "block">("block");
  const [inboxId, setInboxId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [entryRows, inboxRows] = await Promise.all([
      apiAll<ListEntry>("/lists?limit=100", "list_entries"),
      apiAll<Inbox>("/inboxes?limit=100", "inboxes")
    ]);
    setEntries(entryRows);
    setInboxes(inboxRows);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/lists", {
        method: "POST",
        body: JSON.stringify({
          kind,
          pattern: pattern.trim(),
          ...(inboxId ? { inbox_id: inboxId } : {})
        })
      });
      setAdding(false);
      setPattern("");
      setInboxId("");
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "could not add entry");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (entry: ListEntry) => {
    if (!window.confirm(`Delete ${entry.kind} entry ${entry.pattern}?`)) return;
    await api(`/lists/${entry.entry_id}`, { method: "DELETE" });
    await load();
  };

  const visible = entries.filter((e) => {
    if (kindFilter !== "All" && e.kind !== kindFilter.toLowerCase()) return false;
    if (scopeFilter === "Org-wide" && e.inbox_id !== null) return false;
    if (scopeFilter === "Per inbox" && e.inbox_id === null) return false;
    return true;
  });

  return (
    <div>
      <div className="actions" style={{ marginBottom: 12 }}>
        <button className="btn primary" onClick={() => setAdding(true)}>
          + Add Entry
        </button>
      </div>

      <p className="dim">
        Block entries reject inbound mail from matching senders at SMTP time. Adding any allow
        entry switches the scope to allowlist mode: only allowed senders are delivered. Patterns
        are exact addresses (<span className="mono">ada@example.com</span>) or whole domains (
        <span className="mono">@spam.com</span>).
      </p>

      <div className="tabs">
        {KIND_FILTERS.map((k) => (
          <button key={k} className={k === kindFilter ? "active" : ""} onClick={() => setKindFilter(k)}>
            {k}
          </button>
        ))}
      </div>
      <div className="tabs">
        {SCOPE_FILTERS.map((s) => (
          <button key={s} className={s === scopeFilter ? "active" : ""} onClick={() => setScopeFilter(s)}>
            {s}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="card empty">
          <h3>No entries</h3>
          Add an address or domain to allow or block inbound mail.
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Pattern</th>
                <th>Kind</th>
                <th>Scope</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((entry) => (
                <tr key={entry.entry_id}>
                  <td className="mono">{entry.pattern}</td>
                  <td>
                    <span className={`chip ${entry.kind === "allow" ? "green" : "red"}`}>
                      {entry.kind}
                    </span>
                  </td>
                  <td className="dim">{entry.inbox_id ?? "org-wide"}</td>
                  <td className="dim">{new Date(entry.created_at).toLocaleDateString()}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button className="btn sm danger" onClick={() => void remove(entry)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <div className="modal-backdrop" onClick={() => setAdding(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Add entry</h2>
            <div className="field">
              <label>Pattern (address or @domain)</label>
              <input
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder="spammer@example.com or @spam.com"
              />
            </div>
            <div className="field">
              <label>Kind</label>
              <select value={kind} onChange={(e) => setKind(e.target.value as "allow" | "block")}>
                <option value="block">block</option>
                <option value="allow">allow</option>
              </select>
            </div>
            <div className="field">
              <label>Scope</label>
              <select value={inboxId} onChange={(e) => setInboxId(e.target.value)}>
                <option value="">org-wide (all inboxes)</option>
                {inboxes.map((inbox) => (
                  <option key={inbox.inbox_id} value={inbox.inbox_id}>
                    {inbox.inbox_id}
                  </option>
                ))}
              </select>
            </div>
            {error && <p className="error">{error}</p>}
            <div className="foot">
              <button className="btn" onClick={() => setAdding(false)}>
                Cancel
              </button>
              <button className="btn primary" disabled={busy || !pattern.trim()} onClick={() => void add()}>
                {busy ? "Adding…" : "Add"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const REASON_FILTERS = ["All", "Bounce", "Complaint", "Manual"] as const;

/** Suppressions block outbound sends to recipients that bounced or complained. */
function SuppressionsList() {
  const [suppressions, setSuppressions] = useState<Suppression[]>([]);
  const [reasonFilter, setReasonFilter] = useState<(typeof REASON_FILTERS)[number]>("All");
  const [adding, setAdding] = useState(false);
  const [batching, setBatching] = useState(false);
  const [address, setAddress] = useState("");
  const [batchText, setBatchText] = useState("");
  const [batchAction, setBatchAction] = useState<"add" | "remove">("add");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = reasonFilter === "All" ? "" : `&reason=${reasonFilter.toLowerCase()}`;
      setSuppressions(
        await apiAll<Suppression>(`/suppressions?limit=100${query}`, "suppressions")
      );
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "could not load suppressions");
    } finally {
      setLoading(false);
    }
  }, [reasonFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/suppressions", {
        method: "POST",
        body: JSON.stringify({ address: address.trim() })
      });
      setAdding(false);
      setAddress("");
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "could not add suppression");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (entry: Suppression) => {
    if (!window.confirm(`Remove ${entry.address} from suppressions?`)) return;
    setError(null);
    try {
      await api(`/suppressions/${encodeURIComponent(entry.address)}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "could not remove suppression");
    }
  };

  const runBatch = async () => {
    const addresses = batchText
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (addresses.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await api("/suppressions/batch", {
        method: "POST",
        body: JSON.stringify({ [batchAction]: addresses })
      });
      setBatching(false);
      setBatchText("");
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "batch update failed");
    } finally {
      setBusy(false);
    }
  };

  const reasonChip = (reason: string) => {
    const cls = reason === "manual" ? "chip" : "chip red";
    return <span className={cls}>{reason}</span>;
  };

  return (
    <div>
      <div className="actions" style={{ marginBottom: 12 }}>
        <button className="btn" onClick={() => setBatching(true)}>
          Batch add/remove
        </button>{" "}
        <button className="btn primary" onClick={() => setAdding(true)}>
          + Add Suppression
        </button>
      </div>

      <p className="dim">
        Suppressed recipients are rejected at send time. Addresses land here automatically on
        hard bounces and spam complaints; add manual entries to preempt a recipient.
      </p>

      <div className="tabs">
        {REASON_FILTERS.map((r) => (
          <button
            key={r}
            className={r === reasonFilter ? "active" : ""}
            onClick={() => setReasonFilter(r)}
          >
            {r}
          </button>
        ))}
      </div>

      {error && <p className="error">{error}</p>}

      {loading ? (
        <div className="card empty">Loading…</div>
      ) : suppressions.length === 0 ? (
        <div className="card empty">
          <h3>No suppressions</h3>
          Recipients appear here after a bounce or complaint, or when added manually.
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Address</th>
                <th>Origin</th>
                <th>Source message</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {suppressions.map((entry) => (
                <tr key={entry.address}>
                  <td className="mono">{entry.address}</td>
                  <td>{reasonChip(entry.reason)}</td>
                  <td className="dim mono">{entry.source_msg_id ?? "—"}</td>
                  <td className="dim">{new Date(entry.created_at).toLocaleDateString()}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button className="btn sm danger" onClick={() => void remove(entry)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <div className="modal-backdrop" onClick={() => setAdding(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Add suppression</h2>
            <div className="field">
              <label>Address</label>
              <input
                className="mono"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="person@example.com"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && address.trim()) void add();
                }}
              />
              <div className="dim">Added with origin &quot;manual&quot;.</div>
            </div>
            {error && <p className="error">{error}</p>}
            <div className="foot">
              <button className="btn" onClick={() => setAdding(false)}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={busy || !address.trim()}
                onClick={() => void add()}
              >
                {busy ? "Adding…" : "Add"}
              </button>
            </div>
          </div>
        </div>
      )}

      {batching && (
        <div className="modal-backdrop" onClick={() => setBatching(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Batch update</h2>
            <div className="field">
              <label>Action</label>
              <select
                value={batchAction}
                onChange={(e) => setBatchAction(e.target.value as "add" | "remove")}
              >
                <option value="add">add</option>
                <option value="remove">remove</option>
              </select>
            </div>
            <div className="field">
              <label>Addresses (one per line)</label>
              <textarea
                rows={6}
                className="mono"
                value={batchText}
                onChange={(e) => setBatchText(e.target.value)}
                placeholder={"one@example.com\ntwo@example.com"}
              />
            </div>
            {error && <p className="error">{error}</p>}
            <div className="foot">
              <button className="btn" onClick={() => setBatching(false)}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={busy || !batchText.trim()}
                onClick={() => void runBatch()}
              >
                {busy ? "Working…" : `Batch ${batchAction}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
