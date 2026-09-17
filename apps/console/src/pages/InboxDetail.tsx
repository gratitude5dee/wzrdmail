import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { Link, Route, Routes, useNavigate, useParams } from "react-router-dom";
import {
  API_BASE,
  ApiRequestError,
  api,
  apiAll,
  type Attachment,
  type Draft,
  type Message,
  type Thread
} from "../api";
import { UseApiDrawer } from "../components/UseApiDrawer";

const FOLDERS = ["Inbox", "Sent", "Drafts", "Scheduled", "All Mail", "Trash"] as const;
type Folder = (typeof FOLDERS)[number];
// Drafts/Scheduled/Trash use inbox-scoped endpoints, so the unified view
// only offers the thread folders.
const UNIFIED_FOLDERS: Folder[] = ["Inbox", "Sent", "All Mail"];

export function InboxDetailPage() {
  const { inboxId = "" } = useParams();
  const unified = inboxId === "all";
  return (
    <Routes>
      <Route path="/" element={<ThreadListView inboxId={inboxId} unified={unified} />} />
      <Route
        path="threads/:threadId"
        element={<ThreadView inboxId={inboxId} unified={unified} />}
      />
      <Route path="compose" element={<ComposeView inboxId={inboxId} />} />
    </Routes>
  );
}

function ThreadListView({ inboxId, unified }: { inboxId: string; unified: boolean }) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [folder, setFolder] = useState<Folder>("Inbox");
  const [query, setQuery] = useState("");
  const [showApi, setShowApi] = useState(false);
  const [loading, setLoading] = useState(true);

  const base = unified ? "" : `/inboxes/${encodeURIComponent(inboxId)}`;

  const load = useCallback(async () => {
    setLoading(true);
    const path = query
      ? `${base}/threads/search?query=${encodeURIComponent(query)}&limit=100`
      : folder === "Trash"
        ? `${base}/threads?folder=trash&limit=100`
        : `${base}/threads?limit=100`;
    try {
      setThreads(await apiAll<Thread>(path, "threads"));
    } finally {
      setLoading(false);
    }
  }, [base, query, folder]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = threads.filter((t) => {
    if (folder === "All Mail" || folder === "Trash") return true;
    if (folder === "Sent") return t.labels.includes("sent");
    return t.labels.includes("received") || !t.labels.includes("sent");
  });

  return (
    <div>
      <div className="page-head">
        <h1>{unified ? "Unified Inbox" : inboxId}</h1>
        <div className="actions">
          <input
            placeholder="Search mail…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="btn" onClick={() => setShowApi(true)}>
            Use API
          </button>
          {!unified && (
            <Link className="btn primary" to={`/inboxes/${encodeURIComponent(inboxId)}/compose`}>
              Compose
            </Link>
          )}
        </div>
      </div>
      <div className="mail">
        <div className="folders">
          {(unified ? UNIFIED_FOLDERS : [...FOLDERS]).map((f) => (
            <a
              key={f}
              className={f === folder ? "active" : ""}
              onClick={(e) => {
                e.preventDefault();
                setFolder(f);
              }}
              href="#"
            >
              {f}
            </a>
          ))}
          {!unified && (
            <>
              <hr style={{ width: "100%", borderColor: "var(--border)" }} />
              <Link to="/api-keys">API Keys</Link>
              <Link to="/lists">Allow/Block Lists</Link>
            </>
          )}
        </div>
        {folder === "Drafts" ? (
          <DraftsFolder inboxId={inboxId} />
        ) : folder === "Scheduled" ? (
          <ScheduledFolder inboxId={inboxId} />
        ) : (
          <div className="card" style={{ padding: 0 }}>
            {loading ? (
              <div className="empty">Loading…</div>
            ) : visible.length === 0 ? (
              <div className="empty">
                <h3>Nothing here</h3>
                {folder === "Inbox" ? "No conversations yet." : `No mail in ${folder}.`}
              </div>
            ) : (
              <table>
                <tbody>
                  {visible.map((th) => (
                    <ThreadRow
                      key={th.thread_id}
                      thread={th}
                      inboxId={inboxId}
                      unified={unified}
                      inTrash={folder === "Trash"}
                      onChanged={() => void load()}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
      {showApi && (
        <UseApiDrawer
          onClose={() => setShowApi(false)}
          examples={[
            {
              title: "List threads",
              method: "GET",
              path: unified ? "/threads" : `/inboxes/${inboxId}/threads`
            },
            {
              title: "Send a message",
              method: "POST",
              path: `/inboxes/${unified ? "you@wzrd.tech" : inboxId}/messages/send`,
              body: { to: ["them@example.com"], subject: "Hello", text: "Hi from wzrdmail" }
            }
          ]}
        />
      )}
    </div>
  );
}

function ThreadRow({
  thread,
  inboxId,
  unified,
  inTrash,
  onChanged
}: {
  thread: Thread;
  inboxId: string;
  unified: boolean;
  inTrash?: boolean;
  onChanged?: () => void;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const target = unified
    ? `/inboxes/${encodeURIComponent(thread.inbox_id)}/threads/${thread.thread_id}`
    : `/inboxes/${encodeURIComponent(inboxId)}/threads/${thread.thread_id}`;
  const threadBase = `/inboxes/${encodeURIComponent(unified ? thread.inbox_id : inboxId)}/threads/${thread.thread_id}`;
  const act = async (e: MouseEvent, method: string, path: string) => {
    e.stopPropagation();
    setBusy(true);
    try {
      await api(path, { method });
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };
  return (
    <tr className="clickable" onClick={() => navigate(target)}>
      <td>
        <div className="thread-row">
          {thread.labels.includes("unread") && <span className="chip accent">unread</span>}
          <span className="subject">{thread.subject || "(no subject)"}</span>
          <span className="snippet">{thread.preview}</span>
        </div>
        {unified && <div className="dim mono">{thread.inbox_id}</div>}
      </td>
      <td className="dim" style={{ whiteSpace: "nowrap" }}>
        {thread.message_count > 1 && <span className="chip">{thread.message_count}</span>}{" "}
        {new Date(thread.last_message_at).toLocaleString()}
        {inTrash ? (
          <button
            className="btn sm"
            style={{ marginLeft: 8 }}
            disabled={busy}
            onClick={(e) => void act(e, "POST", `${threadBase}/restore`)}
          >
            Restore
          </button>
        ) : (
          <button
            className="btn sm"
            style={{ marginLeft: 8 }}
            disabled={busy}
            onClick={(e) => void act(e, "DELETE", threadBase)}
          >
            Trash
          </button>
        )}
      </td>
    </tr>
  );
}

function DraftsFolder({ inboxId }: { inboxId: string }) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = `/inboxes/${encodeURIComponent(inboxId)}/drafts`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const all = await apiAll<Draft>(`${base}?limit=100`, "drafts");
      setDrafts(all.filter((d) => !d.sent_message_id));
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (draftId: string, method: string, path: string) => {
    setBusy(draftId);
    setError(null);
    try {
      await api(path, { method });
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "draft action failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card" style={{ padding: 0 }}>
      {error && <p className="error" style={{ padding: "0 12px" }}>{error}</p>}
      {loading ? (
        <div className="empty">Loading…</div>
      ) : drafts.length === 0 ? (
        <div className="empty">
          <h3>No drafts</h3>
          Compose a message and save it as a draft.
        </div>
      ) : (
        <table>
          <tbody>
            {drafts.map((d) => (
              <tr key={d.draft_id}>
                <td>
                  <div className="thread-row">
                    <span className="subject">{d.subject || "(no subject)"}</span>
                    <span className="snippet">
                      to {d.to.join(", ") || "(no recipients)"} — {d.text ?? ""}
                    </span>
                  </div>
                </td>
                <td className="dim" style={{ whiteSpace: "nowrap" }}>
                  {new Date(d.updated_at).toLocaleString()}
                  <button
                    className="btn sm"
                    style={{ marginLeft: 8 }}
                    disabled={busy === d.draft_id || d.to.length === 0}
                    onClick={() => void run(d.draft_id, "POST", `${base}/${d.draft_id}/send`)}
                  >
                    Send
                  </button>
                  <button
                    className="btn sm"
                    style={{ marginLeft: 8 }}
                    disabled={busy === d.draft_id}
                    onClick={() => void run(d.draft_id, "DELETE", `${base}/${d.draft_id}`)}
                  >
                    Delete
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

function ScheduledFolder({ inboxId }: { inboxId: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = `/inboxes/${encodeURIComponent(inboxId)}/messages`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setMessages(await apiAll<Message>(`${base}?folder=scheduled&limit=100`, "messages"));
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const cancel = async (messageId: string) => {
    setBusy(messageId);
    setError(null);
    try {
      await api(`${base}/${messageId}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "could not cancel");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card" style={{ padding: 0 }}>
      {error && <p className="error" style={{ padding: "0 12px" }}>{error}</p>}
      {loading ? (
        <div className="empty">Loading…</div>
      ) : messages.length === 0 ? (
        <div className="empty">
          <h3>Nothing scheduled</h3>
          Compose a message with a send time to schedule it.
        </div>
      ) : (
        <table>
          <tbody>
            {messages.map((m) => (
              <tr key={m.message_id}>
                <td>
                  <div className="thread-row">
                    <span className="subject">{m.subject || "(no subject)"}</span>
                    <span className="snippet">to {m.to.join(", ")}</span>
                  </div>
                </td>
                <td className="dim" style={{ whiteSpace: "nowrap" }}>
                  {m.send_at ? `sends ${new Date(m.send_at).toLocaleString()}` : ""}
                  <button
                    className="btn sm"
                    style={{ marginLeft: 8 }}
                    disabled={busy === m.message_id}
                    onClick={() => void cancel(m.message_id)}
                  >
                    Cancel
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

function ThreadView({ inboxId, unified }: { inboxId: string; unified: boolean }) {
  const { threadId = "" } = useParams();
  const [thread, setThread] = useState<Thread | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const path = unified
    ? `/threads/${threadId}`
    : `/inboxes/${encodeURIComponent(inboxId)}/threads/${threadId}`;

  const load = useCallback(async () => {
    setThread(await api<Thread>(path));
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  const sendReply = async () => {
    const messages = thread?.messages ?? [];
    const last = messages[messages.length - 1];
    if (!last) return;
    setBusy(true);
    setError(null);
    try {
      await api(
        `/inboxes/${encodeURIComponent(last.inbox_id)}/messages/${last.message_id}/reply`,
        { method: "POST", body: JSON.stringify({ text: reply }) }
      );
      setReply("");
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "could not send reply");
    } finally {
      setBusy(false);
    }
  };

  if (!thread) return <div className="dim">Loading…</div>;
  return (
    <div>
      <div className="page-head">
        <h1>{thread.subject || "(no subject)"}</h1>
        <Link className="btn sm" to={unified ? "/inboxes/all" : `/inboxes/${encodeURIComponent(inboxId)}`}>
          ← Back
        </Link>
      </div>
      {(thread.messages ?? []).map((m) => (
        <MessageCard key={m.message_id} message={m} />
      ))}
      <div className="card">
        <h4 style={{ marginTop: 0 }}>Reply</h4>
        <textarea
          rows={4}
          style={{ width: "100%" }}
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          placeholder="Write a reply…"
        />
        {error && <p className="error">{error}</p>}
        <div style={{ marginTop: 8 }}>
          <button className="btn primary" disabled={busy || !reply} onClick={() => void sendReply()}>
            {busy ? "Sending…" : "Send reply"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Strip brackets and normalise case before matching MIME `cid:` references. */
function contentId(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/^<|>$/g, "").toLowerCase();
  return normalized || null;
}

function attachmentUrl(
  message: Message,
  attachment: Attachment,
  inline = false
): string {
  const path = `${API_BASE}/inboxes/${encodeURIComponent(message.inbox_id)}/messages/${encodeURIComponent(message.message_id)}/attachments/${encodeURIComponent(attachment.attachment_id)}`;
  return inline ? `${path}?disposition=inline` : path;
}

/**
 * E-mail HTML is untrusted. It lives in an opaque-origin iframe with scripts,
 * forms, navigation, and parent access disabled. Its CSP permits only inline
 * styles, embedded data images, this message's authenticated CID attachments,
 * and (after an explicit reader action) remote HTTP(S) images.
 */
function emailDocument(message: Message, allowRemoteImages: boolean): string {
  const cidAttachments = new Map<string, Attachment>();
  for (const attachment of message.attachments) {
    const id = contentId(attachment.content_id);
    if (id) cidAttachments.set(id, attachment);
  }
  const html = (message.html ?? message.extracted_html ?? "").replace(
    /\bcid:([^\s"'>]+)/gi,
    (reference, rawId: string) => {
      const attachment = cidAttachments.get(contentId(rawId) ?? "");
      return attachment ? attachmentUrl(message, attachment, true) : reference;
    }
  );
  const apiOrigin = new URL(API_BASE).origin;
  const imageSources = ["data:", apiOrigin, ...(allowRemoteImages ? ["https:", "http:"] : [])];
  const csp = [
    "default-src 'none'",
    `img-src ${imageSources.join(" ")}`,
    "style-src 'unsafe-inline'",
    "font-src data:",
    "media-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join("; ");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>html,body{margin:0;max-width:100%;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%!important}pre{white-space:pre-wrap}</style></head><body>${html}</body></html>`;
}

function MessageBody({ message }: { message: Message }) {
  const hasHtml = Boolean(message.html ?? message.extracted_html);
  const text = message.extracted_text ?? message.text ?? "";
  const [view, setView] = useState<"rendered" | "text">(hasHtml ? "rendered" : "text");
  const [allowRemoteImages, setAllowRemoteImages] = useState(false);

  if (!hasHtml) {
    return <div className="body">{text || <span className="dim">(no readable message body)</span>}</div>;
  }

  return (
    <div className="message-body">
      <div className="message-body-actions">
        <button
          className={`btn sm${view === "rendered" ? " primary" : ""}`}
          type="button"
          onClick={() => setView("rendered")}
        >
          Rendered email
        </button>
        <button
          className={`btn sm${view === "text" ? " primary" : ""}`}
          type="button"
          onClick={() => setView("text")}
        >
          Text version
        </button>
        {view === "rendered" && !allowRemoteImages && (
          <button className="btn sm" type="button" onClick={() => setAllowRemoteImages(true)}>
            Load remote images
          </button>
        )}
      </div>
      {view === "rendered" ? (
        <iframe
          className="email-frame"
          title={`Rendered email: ${message.subject || "no subject"}`}
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={emailDocument(message, allowRemoteImages)}
        />
      ) : (
        <div className="body">{text || <span className="dim">(no text version)</span>}</div>
      )}
      {view === "rendered" && !allowRemoteImages && (
        <p className="dim message-image-note">
          Inline images are shown. Remote images stay blocked until you choose to load them.
        </p>
      )}
    </div>
  );
}

function MessageCard({ message }: { message: Message }) {
  return (
    <div className="msg">
      <div className="head">
        <span>
          <b>{message.from}</b> → {message.to.join(", ")}
        </span>
        <span>
          <span className="chip">{message.direction}</span>{" "}
          {new Date(message.created_at).toLocaleString()}
        </span>
      </div>
      <MessageBody message={message} />
      {message.attachments.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {message.attachments.map((a) => (
            <a
              key={a.attachment_id}
              className="chip"
              style={{ marginRight: 6 }}
              href={attachmentUrl(message, a)}
              target="_blank"
              rel="noreferrer"
            >
              📎 {a.filename} ({Math.ceil(a.size / 1024)} KB)
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function ComposeView({ inboxId }: { inboxId: string }) {
  const navigate = useNavigate();
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [sendAt, setSendAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recipients = () => to.split(",").map((s) => s.trim()).filter(Boolean);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/inboxes/${encodeURIComponent(inboxId)}/messages/send`, {
        method: "POST",
        body: JSON.stringify({
          to: recipients(),
          subject,
          text,
          ...(sendAt ? { send_at: new Date(sendAt).toISOString() } : {})
        })
      });
      navigate(`/inboxes/${encodeURIComponent(inboxId)}`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "could not send");
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/inboxes/${encodeURIComponent(inboxId)}/drafts`, {
        method: "POST",
        body: JSON.stringify({ to: recipients(), subject, text })
      });
      navigate(`/inboxes/${encodeURIComponent(inboxId)}`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "could not save draft");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="page-head">
        <h1>Compose — {inboxId}</h1>
        <Link className="btn sm" to={`/inboxes/${encodeURIComponent(inboxId)}`}>
          ← Back
        </Link>
      </div>
      <div className="card" style={{ maxWidth: 720 }}>
        <div className="field">
          <label>To (comma-separated)</label>
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="them@example.com" />
        </div>
        <div className="field">
          <label>Subject</label>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <div className="field">
          <label>Body</label>
          <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <div className="field">
          <label>Send at (optional — leave empty to send now)</label>
          <input
            type="datetime-local"
            value={sendAt}
            onChange={(e) => setSendAt(e.target.value)}
          />
        </div>
        {error && <p className="error">{error}</p>}
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn primary" disabled={busy || !to || !text} onClick={() => void send()}>
            {busy ? "Working…" : sendAt ? "Schedule" : "Send"}
          </button>
          <button className="btn" disabled={busy || (!to && !subject && !text)} onClick={() => void saveDraft()}>
            Save draft
          </button>
        </div>
      </div>
    </div>
  );
}
