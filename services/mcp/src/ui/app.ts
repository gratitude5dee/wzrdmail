import { App } from "@modelcontextprotocol/ext-apps/app-with-deps";

/** Minimal structural shape of a CallToolResult (works across SDK versions). */
type ToolCallResult = {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
};

type Inbox = {
  inbox_id: string;
  display_name?: string | null;
  username?: string;
  domain?: string;
};

type Message = {
  message_id: string;
  inbox_id: string;
  subject?: string | null;
  from: string;
  to?: string[];
  created_at?: string;
  text?: string | null;
};

type Draft = {
  draft_id: string;
  to?: string[];
  subject?: string | null;
  text?: string | null;
};

type Settings = {
  default_inbox?: string;
  messages_per_page?: number;
  confirm_send?: boolean;
};

const app = new App(
  { name: "wzrdmail", version: "0.0.1" },
  { availableDisplayModes: ["inline", "fullscreen"] }
);

const surface =
  document.documentElement.getAttribute("data-surface") === "message"
    ? "message"
    : "mailbox";

const $ = <T = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as unknown as T;
};

const errorBox = $("error");
const showError = (text: string | null) => {
  errorBox.textContent = text ?? "";
  errorBox.hidden = !text;
};

const esc = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"]/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c
  );

const unwrap = (result: ToolCallResult): unknown => {
  const text =
    result.content?.find((c) => c.type === "text")?.text ?? "";
  if (result.isError) throw new Error(text || "tool call failed");
  if (result.structuredContent !== undefined) return result.structuredContent;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const call = async <T>(
  name: string,
  args: Record<string, unknown>
): Promise<T> =>
  unwrap(await app.callServerTool({ name, arguments: args })) as T;

let settings: Settings = {};
let inboxes: Inbox[] = [];
let activeInboxId: string | null = null;
let messages: Message[] = [];
let drafts: Draft[] = [];

const inboxLabel = (inbox: Inbox): string =>
  inbox.display_name?.trim() || inbox.inbox_id;

const time = (iso?: string): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
};

const renderInboxes = () => {
  const select = $<HTMLSelectElement>("inbox-select");
  select.innerHTML = inboxes
    .map(
      (i) =>
        `<option value="${esc(i.inbox_id)}">${esc(inboxLabel(i))}</option>`
    )
    .join("");
  if (activeInboxId) select.value = activeInboxId;
};

const renderMessages = () => {
  const list = $("message-list");
  const draftItems =
    drafts.length === 0
      ? ""
      : `<li class="section">Drafts</li>` +
        drafts
          .map(
            (d) => `<li>
        <button class="row" data-draft="${esc(d.draft_id)}">
          <span class="from">Draft</span>
          <span class="subject">${esc(d.subject ?? "(no subject)")}</span>
          <span class="time"></span>
        </button>
      </li>`
          )
          .join("");
  const items =
    messages.length === 0
      ? `<li class="empty">No messages.</li>`
      : messages
          .map(
            (m) => `<li>
        <button class="row" data-mid="${esc(m.message_id)}">
          <span class="from">${esc(m.from)}</span>
          <span class="subject">${esc(m.subject ?? "(no subject)")}</span>
          <span class="time">${esc(time(m.created_at))}</span>
        </button>
      </li>`
          )
          .join("");
  list.innerHTML = draftItems + items;
  list
    .querySelectorAll<HTMLButtonElement>("[data-mid]")
    .forEach((btn) =>
      btn.addEventListener("click", () =>
        void openMessage(btn.getAttribute("data-mid") ?? "")
      )
    );
  list
    .querySelectorAll<HTMLButtonElement>("[data-draft]")
    .forEach((btn) =>
      btn.addEventListener("click", () =>
        void openDraft(btn.getAttribute("data-draft") ?? "")
      )
    );
};

const renderDetail = (m: Message) => {
  const detail = $("detail");
  detail.hidden = false;
  $("detail-subject").textContent = m.subject ?? "(no subject)";
  $("detail-from").textContent = m.from;
  $("detail-to").textContent = (m.to ?? []).join(", ");
  $("detail-time").textContent = time(m.created_at);
  // Text only — never inject remote HTML into a sandboxed app.
  $("detail-body").textContent =
    m.text?.trim() || "(message body not available inline)";
};

const loadInboxes = async (): Promise<void> => {
  const data = await call<{ inboxes: Inbox[] }>("list_inboxes", { limit: 100 });
  inboxes = data.inboxes ?? [];
  renderInboxes();
  if (!activeInboxId) {
    const wanted = settings.default_inbox;
    const found = inboxes.find(
      (i) => i.inbox_id === wanted || `${i.username}@${i.domain}` === wanted
    );
    activeInboxId = (found ?? inboxes[0])?.inbox_id ?? null;
  }
};

const loadMessages = async (): Promise<void> => {
  const limit = settings.messages_per_page ?? 25;
  const [msgs, dr] = await Promise.all([
    activeInboxId
      ? call<{ messages: Message[] }>("list_messages", {
          inbox_id: activeInboxId,
          limit
        })
      : Promise.resolve({ messages: [] as Message[] }),
    call<{ drafts: Draft[] }>("list_drafts", {
      inbox_id: activeInboxId,
      limit
    }).catch(() => ({ drafts: [] as Draft[] }))
  ]);
  messages = msgs.messages ?? [];
  drafts = dr.drafts ?? [];
  renderMessages();
};

const openMessage = async (messageId: string): Promise<void> => {
  if (!messageId) return;
  const data = await call<Message>("get_message", {
    inbox_id: activeInboxId,
    message_id: messageId
  });
  renderDetail(data);
};

const openDraft = async (draftId: string): Promise<void> => {
  const draft = drafts.find((d) => d.draft_id === draftId);
  if (draft) openCompose(draft);
};

const openCompose = (draft?: Draft): void => {
  $("compose").hidden = false;
  if (draft) {
    $<HTMLInputElement>("compose-to").value = (draft.to ?? []).join(", ");
    $<HTMLInputElement>("compose-subject").value = draft.subject ?? "";
    $<HTMLTextAreaElement>("compose-body").value = draft.text ?? "";
  }
};

const closeCompose = (): void => {
  $("compose").hidden = true;
  $<HTMLInputElement>("compose-to").value = "";
  $<HTMLInputElement>("compose-subject").value = "";
  $<HTMLTextAreaElement>("compose-body").value = "";
};

const sendMail = async (saveDraftOnly: boolean): Promise<void> => {
  const to = $<HTMLInputElement>("compose-to").value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const subject = $<HTMLInputElement>("compose-subject").value;
  const text = $<HTMLTextAreaElement>("compose-body").value;
  if (!activeInboxId || to.length === 0) {
    showError("Choose an inbox and at least one recipient.");
    return;
  }
  if (
    !saveDraftOnly &&
    settings.confirm_send &&
    !window.confirm("Send this email?")
  ) {
    return;
  }
  const args = { inbox_id: activeInboxId, to, subject, text };
  await call(saveDraftOnly ? "create_draft" : "send_message", args);
  closeCompose();
  await loadMessages();
};

const applySettings = (values: Settings): void => {
  settings = values ?? {};
};

const wireDom = (): void => {
  $("inbox-select").addEventListener("change", (e) => {
    activeInboxId = (e.target as HTMLSelectElement).value;
    void loadMessages().catch((err) => showError(String(err)));
  });
  $("refresh-btn").addEventListener("click", () =>
    void loadMessages().catch((err) => showError(String(err)))
  );
  $("compose-btn").addEventListener("click", () => openCompose());
  $("reply-btn").addEventListener("click", () => {
    openCompose();
    const subject = $("detail-subject").textContent ?? "";
    $<HTMLInputElement>("compose-to").value =
      $("detail-from").textContent ?? "";
    $<HTMLInputElement>("compose-subject").value = subject.startsWith("Re:")
      ? subject
      : `Re: ${subject}`;
  });
  $("send-btn").addEventListener("click", () =>
    void sendMail(false).catch((err) => showError(String(err)))
  );
  $("draft-btn").addEventListener("click", () =>
    void sendMail(true).catch((err) => showError(String(err)))
  );
  $("cancel-compose-btn").addEventListener("click", closeCompose);
};

const bootstrap = async (): Promise<void> => {
  wireDom();
  try {
    const result = await call<{ values: Settings }>("settings.read", {});
    applySettings(result.values ?? {});
  } catch {
    // Servers without settings support still run the app.
  }
  await loadInboxes();
  await loadMessages();
};

app.ontoolresult = (params) => {
  try {
    const data = unwrap(params);
    const obj = (typeof data === "object" && data !== null ? data : {}) as {
      message?: Message;
      message_id?: string;
      values?: Settings;
      inboxes?: Inbox[];
    };
    // get_message returns a flat message object; a {message:…} wrap is
    // tolerated for other tools.
    if (obj.message) renderDetail(obj.message);
    else if (obj.message_id) renderDetail(obj as unknown as Message);
    if (obj.values) applySettings(obj.values);
    if (obj.inboxes) {
      inboxes = obj.inboxes;
      renderInboxes();
    }
  } catch {
    // Non-fatal: host tool results only prime the view.
  }
};

app.onhostcontextchanged = (ctx) => {
  if (typeof ctx.theme === "string" && ctx.theme) {
    document.documentElement.setAttribute("data-theme", ctx.theme);
  }
};

const start = async () => {
  await app.connect();
  if (surface === "mailbox") {
    await app.requestDisplayMode({ mode: "fullscreen" }).catch(() => undefined);
  }
  const theme = app.getHostContext()?.theme;
  if (theme) document.documentElement.setAttribute("data-theme", theme);
  try {
    await bootstrap();
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
};

void start();
