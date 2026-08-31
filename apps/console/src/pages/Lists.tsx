import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, api, apiAll, type Inbox, type ListEntry } from "../api";

const KIND_FILTERS = ["All", "Allow", "Block"] as const;
const SCOPE_FILTERS = ["All", "Org-wide", "Per inbox"] as const;

export function ListsPage() {
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
      <div className="page-head">
        <h1>Allow &amp; Block Lists</h1>
        <div className="actions">
          <button className="btn primary" onClick={() => setAdding(true)}>
            + Add Entry
          </button>
        </div>
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
