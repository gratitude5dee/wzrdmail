import { useCallback, useEffect, useState } from "react";
import {
  ApiRequestError,
  api,
  apiAll,
  type Template,
  type TemplateVariable
} from "../api";
import { UseApiDrawer } from "../components/UseApiDrawer";

const STATUS_FILTERS = ["All", "Draft", "Published"] as const;

/** `key=fallback` per line — blank fallback means "required". */
function parseVariables(text: string): TemplateVariable[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const eq = line.indexOf("=");
      if (eq === -1) return { key: line };
      return { key: line.slice(0, eq).trim(), fallback_value: line.slice(eq + 1).trim() };
    });
}

function variablesToText(variables: TemplateVariable[] | undefined): string {
  return (variables ?? [])
    .map((v) => (v.fallback_value != null && v.fallback_value !== "" ? `${v.key}=${v.fallback_value}` : v.key))
    .join("\n");
}

export function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>("All");
  const [editing, setEditing] = useState<Template | "new" | null>(null);
  const [showApi, setShowApi] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setTemplates(await apiAll<Template>("/templates?limit=100", "templates"));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (templateId: string, action: string) => {
    setBusy(templateId + action);
    setError(null);
    try {
      await api(`/templates/${templateId}/${action}`, { method: "POST", body: "{}" });
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : `could not ${action} template`);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (template: Template) => {
    if (!window.confirm(`Delete template ${template.name}?`)) return;
    setError(null);
    try {
      await api(`/templates/${template.template_id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "could not delete template");
    }
  };

  const visible = templates.filter(
    (t) => statusFilter === "All" || t.status === statusFilter.toLowerCase()
  );

  return (
    <div>
      <div className="page-head">
        <h1>Templates</h1>
        <div className="actions">
          <button className="btn" onClick={() => setShowApi(true)}>
            Use API
          </button>
          <button className="btn primary" onClick={() => setEditing("new")}>
            + New Template
          </button>
        </div>
      </div>

      <p className="dim">
        Reusable transactional bodies your agents reference at send time with{" "}
        <span className="mono">template: {"{id, variables}"}</span>. Variables render as{" "}
        <span className="mono">{"{{key}}"}</span> in subject and body.
      </p>

      <div className="tabs">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            className={s === statusFilter ? "active" : ""}
            onClick={() => setStatusFilter(s)}
          >
            {s}
          </button>
        ))}
      </div>

      {error && <p className="error">{error}</p>}

      {visible.length === 0 ? (
        <div className="card empty">
          <h3>No templates</h3>
          Create a reusable subject/body once, then send it with variables.
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Subject</th>
                <th>Variables</th>
                <th>Status</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((t) => (
                <tr key={t.template_id}>
                  <td className="mono">{t.name}</td>
                  <td className="dim">{t.subject ?? "—"}</td>
                  <td>
                    {(t.variables ?? []).map((v) => (
                      <span key={v.key} className="chip" style={{ marginRight: 4 }}>
                        {v.key}
                      </span>
                    ))}
                  </td>
                  <td>
                    <span className={`chip ${t.status === "published" ? "green" : ""}`}>
                      {t.status}
                    </span>
                  </td>
                  <td className="dim">{new Date(t.updated_at).toLocaleDateString()}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button className="btn sm" onClick={() => setEditing(t)}>
                      Edit
                    </button>{" "}
                    {t.status !== "published" && (
                      <>
                        <button
                          className="btn sm"
                          disabled={busy === t.template_id + "publish"}
                          onClick={() => void run(t.template_id, "publish")}
                        >
                          Publish
                        </button>{" "}
                      </>
                    )}
                    <button
                      className="btn sm"
                      disabled={busy === t.template_id + "duplicate"}
                      onClick={() => void run(t.template_id, "duplicate")}
                    >
                      Duplicate
                    </button>{" "}
                    <button className="btn sm danger" onClick={() => void remove(t)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <TemplateModal
          template={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}

      {showApi && (
        <UseApiDrawer
          onClose={() => setShowApi(false)}
          examples={[
            { title: "List templates", method: "GET", path: "/templates" },
            {
              title: "Send with a template",
              method: "POST",
              path: "/inboxes/you@wzrd.tech/messages/send",
              body: {
                to: ["them@example.com"],
                template: { id: "tpl_...", variables: { name: "Ada" } }
              }
            }
          ]}
        />
      )}
    </div>
  );
}

function TemplateModal({
  template,
  onClose,
  onSaved
}: {
  template: Template | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(template?.name ?? "");
  const [subject, setSubject] = useState(template?.subject ?? "");
  const [text, setText] = useState(template?.text ?? "");
  const [html, setHtml] = useState(template?.html ?? "");
  const [variables, setVariables] = useState(variablesToText(template?.variables));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    const body = {
      name: name.trim(),
      ...(subject.trim() ? { subject: subject.trim() } : {}),
      ...(text.trim() ? { text } : {}),
      ...(html.trim() ? { html } : {}),
      variables: parseVariables(variables)
    };
    try {
      if (template) {
        await api(`/templates/${template.template_id}`, {
          method: "PATCH",
          body: JSON.stringify(body)
        });
      } else {
        await api("/templates", { method: "POST", body: JSON.stringify(body) });
      }
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "could not save template");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={{ width: "min(640px, 94vw)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{template ? "Edit template" : "New template"}</h2>
        <div className="field">
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="welcome" />
        </div>
        <div className="field">
          <label>Subject</label>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Welcome, {{name}}"
          />
        </div>
        <div className="field">
          <label>Text body</label>
          <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <div className="field">
          <label>HTML body (optional)</label>
          <textarea
            rows={5}
            className="mono"
            value={html}
            onChange={(e) => setHtml(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Variables (one per line: key or key=fallback)</label>
          <textarea
            rows={3}
            className="mono"
            value={variables}
            onChange={(e) => setVariables(e.target.value)}
            placeholder={"name=there\nreceipt_url"}
          />
        </div>
        {error && <p className="error">{error}</p>}
        <div className="foot">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy || !name.trim() || (!text.trim() && !html.trim())}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : template ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
