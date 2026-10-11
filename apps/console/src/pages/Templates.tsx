import { useCallback, useEffect, useState } from "react";
import {
  ApiRequestError,
  templatesApi,
  type Template,
  type TemplateVariable
} from "../api";
import { UseApiDrawer } from "../components/UseApiDrawer";

const STATUS_FILTERS = ["All", "Draft", "Published"] as const;
const VAR_TYPES: TemplateVariable["type"][] = ["string", "number", "boolean", "object", "list"];

interface VarRow {
  key: string;
  type: TemplateVariable["type"];
  /** Raw text: stored verbatim for strings, JSON-parsed for other types. */
  fallback: string;
}

interface EditorState {
  templateId: string | null; // null = creating
  name: string;
  alias: string;
  subject: string;
  text: string;
  html: string;
  vars: VarRow[];
}

const EMPTY_EDITOR: EditorState = {
  templateId: null,
  name: "",
  alias: "",
  subject: "",
  text: "",
  html: "",
  vars: []
};

function varToRow(v: TemplateVariable): VarRow {
  return {
    key: v.key,
    type: v.type,
    fallback:
      v.fallback_value === undefined
        ? ""
        : v.type === "string"
          ? String(v.fallback_value)
          : JSON.stringify(v.fallback_value)
  };
}

function rowsToVariables(rows: VarRow[]): TemplateVariable[] {
  return rows
    .filter((r) => r.key.trim())
    .map((r) => {
      const out: TemplateVariable = { key: r.key.trim(), type: r.type };
      if (r.fallback !== "") {
        if (r.type === "string") out.fallback_value = r.fallback;
        else out.fallback_value = JSON.parse(r.fallback);
      }
      return out;
    });
}

export function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>("All");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [showApi, setShowApi] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setTemplates(await templatesApi.list());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setError(null);
    setEditor({ ...EMPTY_EDITOR });
  };

  const openEdit = (t: Template) => {
    setError(null);
    setEditor({
      templateId: t.template_id,
      name: t.name,
      alias: t.alias ?? "",
      subject: t.subject,
      text: t.text ?? "",
      html: t.html ?? "",
      vars: t.variables.map(varToRow)
    });
  };

  const save = async () => {
    if (!editor) return;
    setBusy(true);
    setError(null);
    try {
      let variables: TemplateVariable[];
      try {
        variables = rowsToVariables(editor.vars);
      } catch {
        throw new Error("a non-string variable fallback must be valid JSON");
      }
      const input = {
        name: editor.name.trim(),
        ...(editor.alias.trim() ? { alias: editor.alias.trim() } : {}),
        subject: editor.subject,
        text: editor.text !== "" ? editor.text : null,
        html: editor.html !== "" ? editor.html : null,
        variables
      };
      if (editor.templateId) {
        await templatesApi.update(editor.templateId, input);
      } else {
        await templatesApi.create(input);
      }
      setEditor(null);
      await load();
    } catch (err) {
      setError(
        err instanceof ApiRequestError || err instanceof Error
          ? err.message
          : "could not save template"
      );
    } finally {
      setBusy(false);
    }
  };

  const publish = async (t: Template) => {
    setBusy(true);
    try {
      await templatesApi.publish(t.template_id);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const duplicate = async (t: Template) => {
    await templatesApi.duplicate(t.template_id);
    await load();
  };

  const remove = async (t: Template) => {
    if (!window.confirm(`Delete template "${t.name}"?`)) return;
    await templatesApi.remove(t.template_id);
    await load();
  };

  const setVar = (i: number, patch: Partial<VarRow>) =>
    setEditor((e) =>
      e ? { ...e, vars: e.vars.map((v, j) => (j === i ? { ...v, ...patch } : v)) } : e
    );

  const hasUnpublishedChanges = (t: Template) =>
    t.published_at !== null && new Date(t.updated_at) > new Date(t.published_at);

  const visible = templates.filter((t) => {
    if (statusFilter === "All") return true;
    return t.status === statusFilter.toLowerCase();
  });

  return (
    <div>
      <div className="page-head">
        <h1>Templates</h1>
        <div className="actions">
          <button className="btn" onClick={() => setShowApi(true)}>
            Use API
          </button>
          <button className="btn primary" onClick={openCreate}>
            + New Template
          </button>
        </div>
      </div>

      <p className="dim">
        Org-wide reusable bodies for transactional sends. Agents reference a template by id or
        alias via <span className="mono">template: {"{ id, variables }"}</span> on send — the
        published version renders server-side. Draft edits never affect sends until you publish.
        Placeholders: <span className="mono">{"{{key}}"}</span> (HTML-escaped) and{" "}
        <span className="mono">{"{{{key}}}"}</span> (raw).
      </p>

      <div className="tabs">
        {STATUS_FILTERS.map((s) => (
          <button key={s} className={s === statusFilter ? "active" : ""} onClick={() => setStatusFilter(s)}>
            {s}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="card empty">
          <h3>No templates</h3>
          Create a template to send reusable transactional bodies.
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Alias</th>
                <th>Status</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((t) => (
                <tr key={t.template_id}>
                  <td>{t.name}</td>
                  <td className="mono dim">{t.alias ?? "—"}</td>
                  <td>
                    <span className={`chip ${t.status === "published" ? "green" : "accent"}`}>
                      {t.status}
                    </span>
                    {hasUnpublishedChanges(t) && (
                      <span className="chip red" title="Draft edits are not in the published version">
                        unpublished changes
                      </span>
                    )}
                  </td>
                  <td className="dim">{new Date(t.updated_at).toLocaleDateString()}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button className="btn sm" onClick={() => setPreview(t.template_id)}>
                      View
                    </button>{" "}
                    <button className="btn sm" onClick={() => openEdit(t)}>
                      Edit
                    </button>{" "}
                    <button className="btn sm" disabled={busy} onClick={() => void publish(t)}>
                      {t.published_at ? "Republish" : "Publish"}
                    </button>{" "}
                    <button className="btn sm" onClick={() => void duplicate(t)}>
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

      {preview && (
        <TemplatePreview
          template={templates.find((t) => t.template_id === preview) ?? null}
          onClose={() => setPreview(null)}
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

      {editor && (
        <div className="modal-backdrop" onClick={() => setEditor(null)}>
          <div className="modal" style={{ width: "min(640px, 94vw)" }} onClick={(e) => e.stopPropagation()}>
            <h2>{editor.templateId ? "Edit template" : "New template"}</h2>
            <div className="field">
              <label>Name</label>
              <input
                value={editor.name}
                onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                placeholder="Receipt"
              />
            </div>
            <div className="field">
              <label>Alias (optional; callers can use it instead of the id)</label>
              <input
                value={editor.alias}
                onChange={(e) => setEditor({ ...editor, alias: e.target.value })}
                placeholder="receipt-v1"
              />
            </div>
            <div className="field">
              <label>Subject</label>
              <input
                value={editor.subject}
                onChange={(e) => setEditor({ ...editor, subject: e.target.value })}
                placeholder="Your receipt, {{order_id}}"
              />
            </div>
            <div className="field">
              <label>Text body</label>
              <textarea
                rows={4}
                value={editor.text}
                onChange={(e) => setEditor({ ...editor, text: e.target.value })}
                placeholder={"Hi {{name}}, thanks for your order {{{order_id}}}."}
              />
            </div>
            <div className="field">
              <label>HTML body</label>
              <textarea
                rows={6}
                value={editor.html}
                onChange={(e) => setEditor({ ...editor, html: e.target.value })}
                placeholder={"<p>Hi {{name}},</p><p>Total: {{total}}</p>"}
              />
            </div>
            <div className="field">
              <label>Variables</label>
              {editor.vars.map((v, i) => (
                <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                  <input
                    style={{ flex: 2 }}
                    value={v.key}
                    placeholder="key"
                    onChange={(e) => setVar(i, { key: e.target.value })}
                  />
                  <select
                    style={{ flex: 1 }}
                    value={v.type}
                    onChange={(e) => setVar(i, { type: e.target.value as TemplateVariable["type"] })}
                  >
                    {VAR_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <input
                    style={{ flex: 3 }}
                    value={v.fallback}
                    placeholder="fallback (optional)"
                    onChange={(e) => setVar(i, { fallback: e.target.value })}
                  />
                  <button
                    className="btn sm danger"
                    onClick={() =>
                      setEditor({ ...editor, vars: editor.vars.filter((_, j) => j !== i) })
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                className="btn sm"
                onClick={() =>
                  setEditor({ ...editor, vars: [...editor.vars, { key: "", type: "string", fallback: "" }] })
                }
              >
                + Add variable
              </button>
              <p className="dim" style={{ margin: "6px 0 0" }}>
                Variables with no fallback are required at send time (missing → 400).
              </p>
            </div>
            {error && <p className="error">{error}</p>}
            <div className="foot">
              <button className="btn" onClick={() => setEditor(null)}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={busy || !editor.name.trim() || (!editor.text && !editor.html)}
                onClick={() => void save()}
              >
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TemplatePreview({ template, onClose }: { template: Template | null; onClose: () => void }) {
  if (!template) return null;
  const body = template.published ?? template;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: "min(640px, 94vw)" }} onClick={(e) => e.stopPropagation()}>
        <h2>{template.name}</h2>
        <p className="dim">
          {template.published
            ? `Published ${new Date(template.published_at as string).toLocaleString()} — this is the version sends render.`
            : "Draft — not yet published; sends will fail until it is."}
        </p>
        <div className="field">
          <label>Subject</label>
          <div className="mono">{body.subject || "—"}</div>
        </div>
        <div className="field">
          <label>Text</label>
          <pre className="mono" style={{ whiteSpace: "pre-wrap", margin: 0 }}>
            {body.text ?? "—"}
          </pre>
        </div>
        <div className="field">
          <label>HTML</label>
          <pre className="mono" style={{ whiteSpace: "pre-wrap", margin: 0 }}>
            {body.html ?? "—"}
          </pre>
        </div>
        <div className="field">
          <label>Variables</label>
          {body.variables.length === 0 ? (
            <div className="dim">none</div>
          ) : (
            body.variables.map((v) => (
              <div key={v.key} className="mono dim">
                {v.key}: {v.type}
                {v.fallback_value !== undefined ? ` = ${JSON.stringify(v.fallback_value)}` : " (required)"}
              </div>
            ))
          )}
        </div>
        <div className="foot">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
