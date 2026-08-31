import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, api, apiAll, type Webhook } from "../api";
import { UseApiDrawer } from "../components/UseApiDrawer";

const EVENT_CATALOG: { type: string; description: string }[] = [
  { type: "message.received", description: "An inbound message was accepted and stored." },
  { type: "message.sent", description: "An outbound message was handed to the provider." },
  { type: "message.delivered", description: "The recipient server accepted the message." },
  { type: "message.bounced", description: "A DSN reported a permanent delivery failure." },
  { type: "message.complained", description: "An ARF report marked the message as spam." },
  { type: "message.rejected", description: "The message was rejected before sending." },
  { type: "domain.verified", description: "A custom domain finished DNS verification." }
];

const TABS = ["Endpoints", "Event Catalog"] as const;

export function WebhooksPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Endpoints");
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [creating, setCreating] = useState(false);
  const [showApi, setShowApi] = useState(false);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setHooks(await apiAll<Webhook>("/webhooks?limit=100", "webhooks"));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ secret: string }>("/webhooks", {
        method: "POST",
        body: JSON.stringify({ url, ...(events.length ? { event_types: events } : {}) })
      });
      setSecret(res.secret);
      setCreating(false);
      setUrl("");
      setEvents([]);
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "could not create webhook");
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (hook: Webhook) => {
    await api(`/webhooks/${hook.webhook_id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !hook.enabled })
    });
    await load();
  };

  const remove = async (hook: Webhook) => {
    if (!window.confirm(`Delete webhook to ${hook.url}?`)) return;
    await api(`/webhooks/${hook.webhook_id}`, { method: "DELETE" });
    await load();
  };

  return (
    <div>
      <div className="page-head">
        <h1>Webhooks</h1>
        <div className="actions">
          <button className="btn" onClick={() => setShowApi(true)}>
            Use API
          </button>
          <button className="btn primary" onClick={() => setCreating(true)}>
            + Add Endpoint
          </button>
        </div>
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t} className={t === tab ? "active" : ""} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      {tab === "Endpoints" &&
        (hooks.length === 0 ? (
          <div className="card empty">
            <h3>No endpoints</h3>
            Add an endpoint to receive mail events as signed HTTP POSTs.
          </div>
        ) : (
          <div className="card" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>URL</th>
                  <th>Events</th>
                  <th>Scope</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {hooks.map((hook) => (
                  <tr key={hook.webhook_id}>
                    <td className="mono">{hook.url}</td>
                    <td>
                      {hook.event_types.length === 0 ? (
                        <span className="chip">all events</span>
                      ) : (
                        hook.event_types.map((t) => (
                          <span key={t} className="chip" style={{ marginRight: 4 }}>
                            {t}
                          </span>
                        ))
                      )}
                    </td>
                    <td className="dim">{hook.inbox_id ?? "org-wide"}</td>
                    <td>
                      <span className={`chip ${hook.enabled ? "green" : "red"}`}>
                        {hook.enabled ? "enabled" : "disabled"}
                      </span>
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button className="btn sm" onClick={() => void toggle(hook)}>
                        {hook.enabled ? "Disable" : "Enable"}
                      </button>{" "}
                      <button className="btn sm danger" onClick={() => void remove(hook)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {tab === "Event Catalog" && (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Event type</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {EVENT_CATALOG.map((ev) => (
                <tr key={ev.type}>
                  <td className="mono">{ev.type}</td>
                  <td className="dim">{ev.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <div className="modal-backdrop" onClick={() => setCreating(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Add endpoint</h2>
            <div className="field">
              <label>URL</label>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/webhooks/wzrdmail"
              />
            </div>
            <div className="field">
              <label>Events (none selected = all)</label>
              {EVENT_CATALOG.map((ev) => (
                <label key={ev.type} style={{ display: "block" }}>
                  <input
                    type="checkbox"
                    checked={events.includes(ev.type)}
                    onChange={(e) =>
                      setEvents(
                        e.target.checked
                          ? [...events, ev.type]
                          : events.filter((x) => x !== ev.type)
                      )
                    }
                  />{" "}
                  <span className="mono">{ev.type}</span>
                </label>
              ))}
            </div>
            {error && <p className="error">{error}</p>}
            <div className="foot">
              <button className="btn" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button className="btn primary" disabled={busy || !url} onClick={() => void create()}>
                {busy ? "Adding…" : "Add"}
              </button>
            </div>
          </div>
        </div>
      )}

      {secret && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>Copy the signing secret</h2>
            <p className="dim">
              Verify each delivery&apos;s <span className="mono">X-Wzrdmail-Signature</span> with
              this secret. It will not be shown again.
            </p>
            <pre className="code">{secret}</pre>
            <div className="foot">
              <button className="btn" onClick={() => void navigator.clipboard.writeText(secret)}>
                Copy
              </button>
              <button className="btn primary" onClick={() => setSecret(null)}>
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
            { title: "List webhooks", method: "GET", path: "/webhooks" },
            {
              title: "Create a webhook",
              method: "POST",
              path: "/webhooks",
              body: { url: "https://example.com/hook", event_types: ["message.received"] }
            }
          ]}
        />
      )}
    </div>
  );
}
