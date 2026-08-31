import { useCallback, useEffect, useState } from "react";
import { Link, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { ApiRequestError, api, type Message, type Thread } from "../api";
import { UseApiDrawer } from "../components/UseApiDrawer";

const FOLDERS = ["Inbox", "Sent", "All Mail"] as const;
type Folder = (typeof FOLDERS)[number];

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
      ? `${base}/threads/search?q=${encodeURIComponent(query)}&limit=50`
      : `${base}/threads?limit=50`;
    try {
      const res = await api<{ threads: Thread[] }>(path);
      setThreads(res.threads);
    } finally {
      setLoading(false);
    }
  }, [base, query]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = threads.filter((t) => {
    if (folder === "All Mail") return true;
    if (folder === "Sent") return t.labels.includes("sent");
    return !t.labels.includes("sent") || t.labels.includes("unread");
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
          {FOLDERS.map((f) => (
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
                  <ThreadRow key={th.thread_id} thread={th} inboxId={inboxId} unified={unified} />
                ))}
              </tbody>
            </table>
          )}
        </div>
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
  unified
}: {
  thread: Thread;
  inboxId: string;
  unified: boolean;
}) {
  const navigate = useNavigate();
  const target = unified
    ? `/inboxes/${encodeURIComponent(thread.inbox_id)}/threads/${thread.thread_id}`
    : `/inboxes/${encodeURIComponent(inboxId)}/threads/${thread.thread_id}`;
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
      </td>
    </tr>
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

function MessageCard({ message }: { message: Message }) {
  const body = message.extracted_text ?? message.text ?? "";
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
      <div className="body">{body || <span className="dim">(no text body)</span>}</div>
      {message.attachments.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {message.attachments.map((a) => (
            <span key={a.attachment_id} className="chip" style={{ marginRight: 6 }}>
              📎 {a.filename} ({Math.ceil(a.size / 1024)} KB)
            </span>
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/inboxes/${encodeURIComponent(inboxId)}/messages/send`, {
        method: "POST",
        body: JSON.stringify({
          to: to.split(",").map((s) => s.trim()).filter(Boolean),
          subject,
          text
        })
      });
      navigate(`/inboxes/${encodeURIComponent(inboxId)}`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "could not send");
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
        {error && <p className="error">{error}</p>}
        <button className="btn primary" disabled={busy || !to || !text} onClick={() => void send()}>
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}
