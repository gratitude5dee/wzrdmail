import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, api, type ApiKey } from "../api";
import { UseApiDrawer } from "../components/UseApiDrawer";

const PERMS = ["read", "send", "admin"] as const;

export function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [creating, setCreating] = useState(false);
  const [showApi, setShowApi] = useState(false);
  const [name, setName] = useState("");
  const [perms, setPerms] = useState<string[]>(["admin"]);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api<{ api_keys: ApiKey[] }>("/api-keys");
    setKeys(res.api_keys);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ api_key: string }>("/api-keys", {
        method: "POST",
        body: JSON.stringify({ name, permissions: perms })
      });
      setRevealed(res.api_key);
      setCreating(false);
      setName("");
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "could not create key");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (key: ApiKey) => {
    if (!window.confirm(`Revoke ${key.name ?? key.key_preview}? Agents using it will lose access.`))
      return;
    await api(`/api-keys/${key.key_id}`, { method: "DELETE" });
    await load();
  };

  return (
    <div>
      <div className="page-head">
        <h1>API Keys</h1>
        <div className="actions">
          <button className="btn" onClick={() => setShowApi(true)}>
            Use API
          </button>
          <button className="btn primary" onClick={() => setCreating(true)}>
            + Create API Key
          </button>
        </div>
      </div>

      {keys.length === 0 ? (
        <div className="card empty">
          <h3>No API keys</h3>
          Create a key so your agents can authenticate.
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Permissions</th>
                <th>Last used</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.key_id}>
                  <td>{key.name ?? <span className="dim">unnamed</span>}</td>
                  <td className="mono">{key.key_preview}</td>
                  <td>
                    {key.permissions.map((p) => (
                      <span key={p} className="chip" style={{ marginRight: 4 }}>
                        {p}
                      </span>
                    ))}
                  </td>
                  <td className="dim">
                    {key.last_used_at ? new Date(key.last_used_at).toLocaleString() : "never"}
                  </td>
                  <td className="dim">{new Date(key.created_at).toLocaleDateString()}</td>
                  <td>
                    <button className="btn sm danger" onClick={() => void revoke(key)}>
                      Revoke
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
            <h2>Create API key</h2>
            <div className="field">
              <label>Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-agent" />
            </div>
            <div className="field">
              <label>Permissions</label>
              {PERMS.map((p) => (
                <label key={p} style={{ display: "inline-flex", gap: 4, marginRight: 12 }}>
                  <input
                    type="checkbox"
                    checked={perms.includes(p)}
                    onChange={(e) =>
                      setPerms(e.target.checked ? [...perms, p] : perms.filter((x) => x !== p))
                    }
                  />
                  {p}
                </label>
              ))}
            </div>
            {error && <p className="error">{error}</p>}
            <div className="foot">
              <button className="btn" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={busy || !name || perms.length === 0}
                onClick={() => void create()}
              >
                {busy ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}

      {revealed && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>Copy your API key</h2>
            <p className="dim">Store this key now — it will not be shown again.</p>
            <pre className="code">{revealed}</pre>
            <div className="foot">
              <button
                className="btn"
                onClick={() => void navigator.clipboard.writeText(revealed)}
              >
                Copy
              </button>
              <button className="btn primary" onClick={() => setRevealed(null)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {showApi && (
        <UseApiDrawer
          onClose={() => setShowApi(false)}
          examples={[
            { title: "List API keys", method: "GET", path: "/api-keys" },
            {
              title: "Create an API key",
              method: "POST",
              path: "/api-keys",
              body: { name: "my-agent", permissions: ["read", "send"] }
            }
          ]}
        />
      )}
    </div>
  );
}
