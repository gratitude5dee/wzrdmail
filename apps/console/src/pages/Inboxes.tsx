import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiRequestError, api, apiAll, type Inbox, type Usage } from "../api";
import { CapacityBar } from "../components/CapacityBar";
import { UseApiDrawer } from "../components/UseApiDrawer";

export function InboxesPage() {
  const [inboxes, setInboxes] = useState<Inbox[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [creating, setCreating] = useState(false);
  const [showApi, setShowApi] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [inboxList, usageRes] = await Promise.all([
      apiAll<Inbox>("/inboxes?limit=100", "inboxes"),
      api<Usage>("/usage").catch(() => null)
    ]);
    setInboxes(inboxList);
    setUsage(usageRes);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/inboxes", {
        method: "POST",
        body: JSON.stringify({
          username,
          ...(displayName ? { display_name: displayName } : {})
        })
      });
      setCreating(false);
      setUsername("");
      setDisplayName("");
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "could not create inbox");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (inbox: Inbox) => {
    if (!window.confirm(`Delete ${inbox.inbox_id}? Mail already stored is kept.`)) return;
    await api(`/inboxes/${encodeURIComponent(inbox.inbox_id)}`, { method: "DELETE" });
    await load();
  };

  return (
    <div>
      <div className="page-head">
        <h1>Inboxes</h1>
        <div className="actions">
          <button className="btn" onClick={() => setShowApi(true)}>
            Use API
          </button>
          <button className="btn primary" onClick={() => setCreating(true)}>
            + Create Inbox
          </button>
        </div>
      </div>

      {usage && (
        <CapacityBar
          used={usage.usage.inboxes?.used ?? 0}
          limit={usage.usage.inboxes?.limit ?? null}
          unit="inboxes"
        />
      )}

      <Link to="/inboxes/all" className="card" style={{ display: "block", marginBottom: 14 }}>
        <b>Unified Inbox</b>
        <div className="dim">Every conversation across all of your inboxes in one view.</div>
      </Link>

      {inboxes.length === 0 ? (
        <div className="card empty">
          <h3>No inboxes yet</h3>
          Create your first inbox to start sending and receiving.
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Address</th>
                <th>Display name</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {inboxes.map((inbox) => (
                <tr key={inbox.inbox_id}>
                  <td>
                    <Link to={`/inboxes/${encodeURIComponent(inbox.inbox_id)}`}>{inbox.inbox_id}</Link>
                  </td>
                  <td className="dim">{inbox.display_name ?? "—"}</td>
                  <td className="dim">{new Date(inbox.created_at).toLocaleDateString()}</td>
                  <td>
                    <button className="btn sm danger" onClick={() => void remove(inbox)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <div className="modal-backdrop" onClick={() => setCreating(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Create inbox</h2>
            <div className="field">
              <label>Username</label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="scout"
              />
              <div className="dim">Address will be {username || "username"}@wzrd.tech</div>
            </div>
            <div className="field">
              <label>Display name (optional)</label>
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </div>
            {error && <p className="error">{error}</p>}
            <div className="foot">
              <button className="btn" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button className="btn primary" disabled={busy || !username} onClick={() => void create()}>
                {busy ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showApi && (
        <UseApiDrawer
          onClose={() => setShowApi(false)}
          examples={[
            { title: "List inboxes", method: "GET", path: "/inboxes" },
            {
              title: "Create an inbox",
              method: "POST",
              path: "/inboxes",
              body: { username: "scout", display_name: "Scout" }
            }
          ]}
        />
      )}
    </div>
  );
}
