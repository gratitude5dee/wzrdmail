import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, api, type ApiKey } from "../api";
import { useSession } from "../session";

/**
 * `GET /api-keys` rows carry `source` and `client_id` once a key was minted by
 * the OAuth authorization server on the MCP host (muse.md §5.4). Keys created
 * in the console or by agent sign-up have neither, so both are optional.
 */
type ConnectedKey = ApiKey & {
  source?: string | null;
  client_id?: string | null;
};

function appLabel(key: ConnectedKey): string {
  return key.name ?? key.client_id ?? "Unknown app";
}

/**
 * OAuth grants shown as what they are to the user — connected applications,
 * not API keys. Disconnect revokes the key behind the grant, which is what
 * makes the connected app's next tool call fail.
 */
function ConnectedApps() {
  const [apps, setApps] = useState<ConnectedKey[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ api_keys: ConnectedKey[] }>("/api-keys");
      setApps(res.api_keys.filter((key) => key.source === "oauth"));
      setError(null);
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.message : "could not load connected apps"
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const disconnect = async (key: ConnectedKey) => {
    if (
      !window.confirm(
        `Disconnect ${appLabel(key)}? Its next request will fail and it will have to connect again.`
      )
    )
      return;
    try {
      await api(`/api-keys/${key.key_id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "could not disconnect");
    }
  };

  return (
    <div className="card" style={{ maxWidth: 640, marginBottom: 14 }}>
      <h3>Connected apps</h3>
      <p className="dim">
        Applications you signed in to with wzrdmail, such as the Meta Muse connector. Each one
        is pinned to a single inbox and never holds admin permissions. Disconnecting revokes
        its access immediately.
      </p>
      {error && <p className="error">{error}</p>}
      {apps.length === 0 ? (
        <p className="dim">No connected apps.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>App</th>
              <th>Access</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {apps.map((key) => (
              <tr key={key.key_id}>
                <td>{appLabel(key)}</td>
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
                <td>
                  <button className="btn sm danger" onClick={() => void disconnect(key)}>
                    Disconnect
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function SettingsPage() {
  const { session } = useSession();
  return (
    <div>
      <div className="page-head">
        <h1>Settings</h1>
      </div>
      <div className="card" style={{ maxWidth: 640, marginBottom: 14 }}>
        <h3>Organization</h3>
        <div className="field">
          <label>Name</label>
          <div>{session.name || <span className="dim">unnamed</span>}</div>
        </div>
        <div className="field">
          <label>Organization ID</label>
          <div className="mono">{session.organization_id}</div>
        </div>
        <div className="field">
          <label>Owner email</label>
          <div>{session.email}</div>
        </div>
        <div className="field">
          <label>Verification</label>
          <div>
            <span className={`chip ${session.verified ? "green" : "red"}`}>
              {session.verified ? "verified" : "unverified"}
            </span>
            {!session.verified && (
              <span className="dim">
                {" "}
                — unverified organizations can only email their owner address.
              </span>
            )}
          </div>
        </div>
      </div>
      <ConnectedApps />
      <div className="card" style={{ maxWidth: 640 }}>
        <h3>Members &amp; seats</h3>
        <p className="dim">
          Seat invitations ship in the next console milestone. Your plan&apos;s seat limit is
          enforced server-side.
        </p>
      </div>
    </div>
  );
}
