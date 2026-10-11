import { readFileSync } from "node:fs";
import {
  WzrdMailClient,
  WzrdmailError,
  type Attachment,
  type BatchSendItemResult,
  type Draft,
  type FetchLike,
  type Inbox,
  type Message,
  type MessageEvent,
  type Suppression,
  type Template,
  type Thread,
  type Webhook
} from "wzrdmail";
import { clearApiKey, configPath, readStoredApiKey, storeApiKey } from "./config.js";
import { tailEvents, type WebSocketFactory } from "./events.js";
import {
  UsageError,
  boolFlag,
  listFlag,
  numberFlag,
  parseArgs,
  requireStringFlag,
  stringFlag
} from "./args.js";
import { formatRecord, formatTable } from "./table.js";

export interface RunIo {
  env: Record<string, string | undefined>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  fetch?: FetchLike;
  webSocket?: WebSocketFactory;
  sleep?: (ms: number) => Promise<void>;
}

const HELP = `wzrdmail — email for AI agents (https://docs.mail.wzrd.tech)

Usage: wzrdmail [--format json|table] <command>

Commands:
  inboxes list [--limit N] [--page-token TOKEN]
  inboxes create [--username U] [--domain D] [--display-name NAME] [--client-id ID]
  inboxes get <inbox_id>
  inboxes update <inbox_id> [--display-name N] [--open-tracking true|false] [--click-tracking true|false]
  messages send <inbox_id> --to a@b.com[,c@d.com] [--subject S] [--text T] [--html H] [--cc ..] [--bcc ..] [--reply-to a[,b]] [--template-id ID --template-vars JSON] [--send-at TS] [--client-id ID]
  messages batch-send <inbox_id> --file messages.json [--idempotency-key KEY]
  messages list <inbox_id> [--limit N] [--page-token TOKEN] [--labels l1,l2] [--before TS] [--after TS]
  messages cancel <inbox_id> <message_id>
  messages reschedule <inbox_id> <message_id> --send-at ISO8601
  messages share <inbox_id> <message_id> [--expires-in SECONDS]
  messages events <inbox_id> <message_id>
  messages attachments <inbox_id> <message_id>
  threads list <inbox_id> [--limit N] [--page-token TOKEN]
  threads get <inbox_id> <thread_id>
  threads search <inbox_id> --query Q [--limit N] [--page-token TOKEN]
  agent sign-up --human-email EMAIL --username U
  agent verify --otp-code CODE
  auth login --api-key wm_…    store a key in ~/.config/wzrdmail/config.json
  auth whoami                  identity behind the current key
  auth logout                  delete the stored key
  inboxes delete <inbox_id>
  messages get <inbox_id> <message_id>
  messages reply <inbox_id> <message_id> [--text T] [--html H] [--cc ..] [--bcc ..] [--reply-to a[,b]] [--all]
  messages forward <inbox_id> <message_id> --to a@b.com[,c@d.com] [--text T] [--reply-to a[,b]]
  drafts list <inbox_id>
  drafts create <inbox_id> [--to ..] [--subject S] [--text T] [--html H] [--reply-to a[,b]]
  drafts send <inbox_id> <draft_id>
  webhooks list|create|delete|test  (create: --url URL --event-types t1,t2; test: <webhook_id>)
  webhooks rotate-secret <webhook_id>
  webhooks events <webhook_id> [--limit N] [--page-token TOKEN]
  domains list|add|verify|records  (add: --domain D; verify/records: <domain_id>)
  domains update <domain_id> [--custom-return-path PATH]
  pods list|create             (create: [--name NAME])
  keys list|create|update|revoke (create: [--name NAME] [--pod-id ID] [--inbox-id ADDR] [--permissions read,drafts]; update: <key_id> [--name NAME]; revoke: <key_id>)
  suppressions list [--reason bounce|complaint|manual] [--limit N] [--page-token TOKEN]
  suppressions add|remove <address>
  suppressions batch [--add a@b,c@d] [--remove e@f,g@h]
  templates list|get|create|update|delete|publish|duplicate  (create: --name N [--subject S] [--from F] [--reply-to R] [--html H] [--text T])
  usage [--month YYYY-MM]
  events tail [--inbox-ids a@b,c@d] [--max N]

Environment:
  WZRDMAIL_API_KEY      API key (required except for agent sign-up)
  WZRDMAIL_BASE_URL     API base URL (default https://api.wzrd.tech)
  WZRDMAIL_CONFIG_PATH  key store path (default ~/.config/wzrdmail/config.json)

Flags:
  --api-key wm_…     API key for this invocation (env WZRDMAIL_API_KEY wins over it)
  --format json      machine-clean JSON on stdout (default: human table)
  --help             show this help`;

/** Exit codes (goal.md §10): 0 ok, 1 error, 2 auth, 3 plan limit. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_AUTH = 2;
export const EXIT_LIMIT = 3;

type Format = "table" | "json";

interface Ctx {
  client: WzrdMailClient;
  format: Format;
  io: RunIo;
  apiKey?: string;
}

function emit(ctx: Ctx, data: unknown, human: () => string): void {
  if (ctx.format === "json") {
    ctx.io.stdout(JSON.stringify(data, null, 2));
  } else {
    ctx.io.stdout(human());
  }
}

const inboxRows = (inboxes: Inbox[]): (string | undefined)[][] =>
  inboxes.map((i) => [i.inbox_id, i.display_name ?? "", i.created_at]);

const messageRows = (messages: Message[]): (string | undefined)[][] =>
  messages.map((m) => [
    m.message_id,
    m.direction,
    m.state,
    m.from,
    m.subject,
    m.created_at
  ]);

const threadRows = (threads: Thread[]): (string | number | undefined)[][] =>
  threads.map((t) => [
    t.thread_id,
    t.subject,
    t.message_count,
    t.last_message_at
  ]);

const draftRows = (drafts: Draft[]): (string | undefined)[][] =>
  drafts.map((d) => [d.draft_id, d.to?.join(","), d.subject, d.updated_at]);

const suppressionRows = (suppressions: Suppression[]): (string | undefined)[][] =>
  suppressions.map((s) => [s.address, s.reason, s.source_msg_id ?? "", s.created_at]);

const eventRows = (events: MessageEvent[]): (string | undefined)[][] =>
  events.map((e) => [e.event_id, e.type, e.created_at]);

const attachmentRows = (attachments: Attachment[]): (string | number | undefined)[][] =>
  attachments.map((a) => [a.attachment_id, a.filename, a.content_type, a.size, a.content_id ?? ""]);

const templateRows = (templates: Template[]): (string | undefined)[][] =>
  templates.map((t) => [t.template_id, t.name, t.status, t.updated_at]);

const batchResultRows = (results: BatchSendItemResult[]): (string | number | undefined)[][] =>
  results.map((r) =>
    "error" in r ? [r.index, "", `${r.error.name}: ${r.error.message}`] : [r.index, r.message_id, ""]
  );

const webhookRows = (webhooks: Webhook[]): (string | boolean | undefined)[][] =>
  webhooks.map((w) => [w.webhook_id, w.url, w.event_types.join(","), w.enabled]);

const THREADS_TABLE = ["THREAD_ID", "SUBJECT", "MESSAGES", "LAST_MESSAGE_AT"];

async function dispatch(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals, flags } = parseArgs(argv);
  const [resource, action, ...rest] = positionals;
  const pagination = {
    limit: numberFlag(flags, "limit"),
    page_token: stringFlag(flags, "page-token")
  };

  if (resource === "inboxes" && action === "list") {
    const page = await ctx.client.inboxes.list(pagination);
    emit(ctx, page, () =>
      formatTable(["INBOX_ID", "DISPLAY_NAME", "CREATED_AT"], inboxRows(page.inboxes))
    );
    return;
  }
  if (resource === "inboxes" && action === "create") {
    const inbox = await ctx.client.inboxes.create({
      username: stringFlag(flags, "username"),
      domain: stringFlag(flags, "domain"),
      display_name: stringFlag(flags, "display-name"),
      client_id: stringFlag(flags, "client-id")
    });
    emit(ctx, inbox, () => formatRecord(inbox));
    return;
  }
  if (resource === "inboxes" && action === "get") {
    const inboxId = rest[0];
    if (!inboxId) throw new UsageError("usage: wzrdmail inboxes get <inbox_id>");
    const inbox = await ctx.client.inboxes.get(inboxId);
    emit(ctx, inbox, () => formatRecord(inbox));
    return;
  }
  if (resource === "inboxes" && action === "delete") {
    const inboxId = rest[0];
    if (!inboxId) throw new UsageError("usage: wzrdmail inboxes delete <inbox_id>");
    await ctx.client.inboxes.delete(inboxId);
    emit(ctx, { deleted: true, inbox_id: inboxId }, () => `deleted ${inboxId}`);
    return;
  }
  if (resource === "inboxes" && action === "update") {
    const inboxId = rest[0];
    if (!inboxId) throw new UsageError("usage: wzrdmail inboxes update <inbox_id>");
    const inbox = await ctx.client.inboxes.update(inboxId, {
      display_name: stringFlag(flags, "display-name"),
      x_open_tracking: boolFlag(flags, "open-tracking"),
      x_click_tracking: boolFlag(flags, "click-tracking")
    });
    emit(ctx, inbox, () => formatRecord(inbox));
    return;
  }

  if (resource === "messages" && action === "send") {
    const inboxId = rest[0];
    if (!inboxId) throw new UsageError("usage: wzrdmail messages send <inbox_id> --to …");
    const to = listFlag(flags, "to");
    if (!to || to.length === 0) throw new UsageError("--to is required");
    const replyTo = listFlag(flags, "reply-to");
    const templateId = stringFlag(flags, "template-id");
    const templateVars = stringFlag(flags, "template-vars");
    let variables: Record<string, unknown> | undefined;
    if (templateVars !== undefined) {
      try {
        const parsed = JSON.parse(templateVars) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error();
        }
        variables = parsed as Record<string, unknown>;
      } catch {
        throw new UsageError("--template-vars must be a JSON object");
      }
    }
    const message = await ctx.client.inboxes.messages.send(inboxId, {
      to,
      cc: listFlag(flags, "cc"),
      bcc: listFlag(flags, "bcc"),
      subject: stringFlag(flags, "subject") ?? "",
      text: stringFlag(flags, "text"),
      html: stringFlag(flags, "html"),
      reply_to: replyTo === undefined ? undefined : replyTo.length === 1 ? replyTo[0] : replyTo,
      template: templateId === undefined ? undefined : { id: templateId, variables },
      send_at: stringFlag(flags, "send-at"),
      client_id: stringFlag(flags, "client-id")
    });
    emit(ctx, message, () => formatRecord(message));
    return;
  }

  if (resource === "messages" && action === "batch-send") {
    const inboxId = rest[0];
    if (!inboxId) {
      throw new UsageError("usage: wzrdmail messages batch-send <inbox_id> --file messages.json");
    }
    const file = requireStringFlag(flags, "file");
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new UsageError(`cannot read --file ${file}: ${(error as Error).message}`);
    }
    const items = Array.isArray(parsed)
      ? parsed
      : (parsed as { messages?: unknown[] }).messages;
    if (!Array.isArray(items) || items.length === 0) {
      throw new UsageError("--file must contain a JSON array or {messages:[…]} of send inputs");
    }
    const result = await ctx.client.inboxes.messages.batchSend(
      inboxId,
      items as Parameters<typeof ctx.client.inboxes.messages.batchSend>[1],
      { idempotencyKey: stringFlag(flags, "idempotency-key") }
    );
    emit(ctx, result, () =>
      formatTable(["INDEX", "MESSAGE_ID", "ERROR"], batchResultRows(result.results))
    );
    return;
  }

  if (resource === "messages" && action === "cancel") {
    const [inboxId, messageId] = rest;
    if (!inboxId || !messageId) {
      throw new UsageError("usage: wzrdmail messages cancel <inbox_id> <message_id>");
    }
    const message = await ctx.client.inboxes.messages.cancel(inboxId, messageId);
    emit(ctx, message, () => formatRecord(message));
    return;
  }

  if (resource === "messages" && action === "reschedule") {
    const [inboxId, messageId] = rest;
    if (!inboxId || !messageId) {
      throw new UsageError(
        "usage: wzrdmail messages reschedule <inbox_id> <message_id> --send-at TS"
      );
    }
    const message = await ctx.client.inboxes.messages.reschedule(
      inboxId,
      messageId,
      requireStringFlag(flags, "send-at")
    );
    emit(ctx, message, () => formatRecord(message));
    return;
  }

  if (resource === "messages" && action === "share") {
    const [inboxId, messageId] = rest;
    if (!inboxId || !messageId) {
      throw new UsageError(
        "usage: wzrdmail messages share <inbox_id> <message_id> [--expires-in SECONDS]"
      );
    }
    const link = await ctx.client.inboxes.messages.share(inboxId, messageId, {
      expires_in: numberFlag(flags, "expires-in")
    });
    emit(ctx, link, () => formatRecord(link));
    return;
  }

  if (resource === "messages" && action === "events") {
    const [inboxId, messageId] = rest;
    if (!inboxId || !messageId) {
      throw new UsageError("usage: wzrdmail messages events <inbox_id> <message_id>");
    }
    const events = await ctx.client.inboxes.messages.events(inboxId, messageId);
    emit(ctx, { events }, () =>
      formatTable(["EVENT_ID", "TYPE", "CREATED_AT"], eventRows(events))
    );
    return;
  }

  if (resource === "messages" && action === "attachments") {
    const [inboxId, messageId] = rest;
    if (!inboxId || !messageId) {
      throw new UsageError("usage: wzrdmail messages attachments <inbox_id> <message_id>");
    }
    const attachments = await ctx.client.inboxes.messages.listAttachments(inboxId, messageId);
    emit(ctx, { attachments }, () =>
      formatTable(
        ["ATTACHMENT_ID", "FILENAME", "CONTENT_TYPE", "SIZE", "CONTENT_ID"],
        attachmentRows(attachments)
      )
    );
    return;
  }
  if (resource === "messages" && action === "list") {
    const inboxId = rest[0];
    if (!inboxId) throw new UsageError("usage: wzrdmail messages list <inbox_id>");
    const page = await ctx.client.inboxes.messages.list(inboxId, {
      ...pagination,
      labels: listFlag(flags, "labels"),
      before: stringFlag(flags, "before"),
      after: stringFlag(flags, "after")
    });
    emit(ctx, page, () =>
      formatTable(
        ["MESSAGE_ID", "DIRECTION", "STATE", "FROM", "SUBJECT", "CREATED_AT"],
        messageRows(page.messages)
      )
    );
    return;
  }

  if (resource === "threads" && action === "list") {
    const inboxId = rest[0];
    if (!inboxId) throw new UsageError("usage: wzrdmail threads list <inbox_id>");
    const page = await ctx.client.inboxes.threads.list(inboxId, pagination);
    emit(ctx, page, () =>
      formatTable(
        ["THREAD_ID", "SUBJECT", "MESSAGES", "LAST_MESSAGE_AT"],
        threadRows(page.threads)
      )
    );
    return;
  }
  if (resource === "messages" && action === "get") {
    const [inboxId, messageId] = rest;
    if (!inboxId || !messageId) {
      throw new UsageError("usage: wzrdmail messages get <inbox_id> <message_id>");
    }
    const message = await ctx.client.inboxes.messages.get(inboxId, messageId);
    emit(ctx, message, () => formatRecord(message));
    return;
  }
  if (resource === "messages" && action === "reply") {
    const [inboxId, messageId] = rest;
    if (!inboxId || !messageId) {
      throw new UsageError("usage: wzrdmail messages reply <inbox_id> <message_id> [--text T]");
    }
    const replyTo = listFlag(flags, "reply-to");
    const input = {
      text: stringFlag(flags, "text"),
      html: stringFlag(flags, "html"),
      cc: listFlag(flags, "cc"),
      bcc: listFlag(flags, "bcc"),
      reply_to: replyTo === undefined ? undefined : replyTo.length === 1 ? replyTo[0] : replyTo,
      client_id: stringFlag(flags, "client-id")
    };
    const message =
      flags["all"] === true
        ? await ctx.client.inboxes.messages.replyAll(inboxId, messageId, input)
        : await ctx.client.inboxes.messages.reply(inboxId, messageId, input);
    emit(ctx, message, () => formatRecord(message));
    return;
  }
  if (resource === "messages" && action === "forward") {
    const [inboxId, messageId] = rest;
    if (!inboxId || !messageId) {
      throw new UsageError("usage: wzrdmail messages forward <inbox_id> <message_id> --to …");
    }
    const to = listFlag(flags, "to");
    if (!to || to.length === 0) throw new UsageError("--to is required");
    const replyTo = listFlag(flags, "reply-to");
    const message = await ctx.client.inboxes.messages.forward(inboxId, messageId, {
      to,
      cc: listFlag(flags, "cc"),
      bcc: listFlag(flags, "bcc"),
      text: stringFlag(flags, "text"),
      html: stringFlag(flags, "html"),
      reply_to: replyTo === undefined ? undefined : replyTo.length === 1 ? replyTo[0] : replyTo,
      client_id: stringFlag(flags, "client-id")
    });
    emit(ctx, message, () => formatRecord(message));
    return;
  }

  if (resource === "threads" && action === "get") {
    const [inboxId, threadId] = rest;
    if (!inboxId || !threadId) {
      throw new UsageError("usage: wzrdmail threads get <inbox_id> <thread_id>");
    }
    const thread = await ctx.client.inboxes.threads.get(inboxId, threadId);
    emit(ctx, thread, () => formatRecord(thread));
    return;
  }

  if (resource === "threads" && action === "search") {
    const inboxId = rest[0];
    if (!inboxId) throw new UsageError("usage: wzrdmail threads search <inbox_id> --query Q");
    const page = await ctx.client.inboxes.threads.search(inboxId, {
      ...pagination,
      query: requireStringFlag(flags, "query")
    });
    emit(ctx, page, () => formatTable(THREADS_TABLE, threadRows(page.threads)));
    return;
  }

  if (resource === "drafts" && action === "list") {
    const inboxId = rest[0];
    if (!inboxId) throw new UsageError("usage: wzrdmail drafts list <inbox_id>");
    const page = await ctx.client.inboxes.drafts.list(inboxId, pagination);
    emit(ctx, page, () =>
      formatTable(["DRAFT_ID", "TO", "SUBJECT", "UPDATED_AT"], draftRows(page.drafts))
    );
    return;
  }
  if (resource === "drafts" && action === "create") {
    const inboxId = rest[0];
    if (!inboxId) throw new UsageError("usage: wzrdmail drafts create <inbox_id> [--to …]");
    const replyToDraft = listFlag(flags, "reply-to");
    const draft = await ctx.client.inboxes.drafts.create(inboxId, {
      to: listFlag(flags, "to"),
      cc: listFlag(flags, "cc"),
      bcc: listFlag(flags, "bcc"),
      subject: stringFlag(flags, "subject"),
      text: stringFlag(flags, "text"),
      html: stringFlag(flags, "html"),
      reply_to:
        replyToDraft === undefined
          ? undefined
          : replyToDraft.length === 1
            ? replyToDraft[0]
            : replyToDraft,
      client_id: stringFlag(flags, "client-id")
    });
    emit(ctx, draft, () => formatRecord(draft));
    return;
  }
  if (resource === "drafts" && action === "send") {
    const [inboxId, draftId] = rest;
    if (!inboxId || !draftId) {
      throw new UsageError("usage: wzrdmail drafts send <inbox_id> <draft_id>");
    }
    const message = await ctx.client.inboxes.drafts.send(inboxId, draftId);
    emit(ctx, message, () => formatRecord(message));
    return;
  }

  if (resource === "webhooks" && action === "list") {
    const page = await ctx.client.webhooks.list(pagination);
    emit(ctx, page, () =>
      formatTable(
        ["WEBHOOK_ID", "URL", "EVENT_TYPES", "ENABLED"],
        webhookRows(page.webhooks)
      )
    );
    return;
  }
  if (resource === "webhooks" && action === "create") {
    const eventTypes = listFlag(flags, "event-types");
    if (!eventTypes || eventTypes.length === 0) {
      throw new UsageError("--event-types is required");
    }
    const webhook = await ctx.client.webhooks.create({
      url: requireStringFlag(flags, "url"),
      event_types: eventTypes,
      inbox_id: stringFlag(flags, "inbox-id"),
      client_id: stringFlag(flags, "client-id")
    });
    emit(ctx, webhook, () => formatRecord(webhook));
    return;
  }
  if (resource === "webhooks" && action === "delete") {
    const webhookId = rest[0];
    if (!webhookId) throw new UsageError("usage: wzrdmail webhooks delete <webhook_id>");
    await ctx.client.webhooks.delete(webhookId);
    emit(ctx, { deleted: true, webhook_id: webhookId }, () => `deleted ${webhookId}`);
    return;
  }
  if (resource === "webhooks" && action === "test") {
    const webhookId = rest[0];
    if (!webhookId) throw new UsageError("usage: wzrdmail webhooks test <webhook_id>");
    const result = await ctx.client.webhooks.test(webhookId);
    emit(ctx, result, () => formatRecord(result));
    return;
  }
  if (resource === "webhooks" && action === "rotate-secret") {
    const webhookId = rest[0];
    if (!webhookId) {
      throw new UsageError("usage: wzrdmail webhooks rotate-secret <webhook_id>");
    }
    const result = await ctx.client.webhooks.rotateSecret(webhookId);
    emit(ctx, result, () => formatRecord(result));
    return;
  }
  if (resource === "webhooks" && action === "events") {
    const webhookId = rest[0];
    if (!webhookId) throw new UsageError("usage: wzrdmail webhooks events <webhook_id>");
    const page = await ctx.client.webhooks.events(webhookId, pagination);
    emit(ctx, page, () =>
      formatTable(["EVENT_ID", "TYPE", "CREATED_AT"], eventRows(page.events))
    );
    return;
  }

  if (resource === "domains" && action === "list") {
    const page = await ctx.client.domains.list(pagination);
    emit(ctx, page, () =>
      formatTable(
        ["DOMAIN_ID", "DOMAIN", "STATUS"],
        page.domains.map((d) => [d.domain_id, d.domain, d.status])
      )
    );
    return;
  }
  if (resource === "domains" && action === "add") {
    const domain = await ctx.client.domains.create({
      domain: requireStringFlag(flags, "domain"),
      client_id: stringFlag(flags, "client-id")
    });
    emit(ctx, domain, () => formatRecord(domain));
    return;
  }
  if (resource === "domains" && action === "verify") {
    const domainId = rest[0];
    if (!domainId) throw new UsageError("usage: wzrdmail domains verify <domain_id>");
    const domain = await ctx.client.domains.verify(domainId);
    emit(ctx, domain, () => formatRecord(domain));
    return;
  }
  if (resource === "domains" && action === "records") {
    const domainId = rest[0];
    if (!domainId) throw new UsageError("usage: wzrdmail domains records <domain_id>");
    const domain = await ctx.client.domains.get(domainId);
    const records = domain.dns_records ?? [];
    emit(ctx, { dns_records: records, nameservers: domain.nameservers }, () =>
      formatTable(
        ["TYPE", "NAME", "VALUE"],
        records.map((r) => [r.type, r.name, r.value])
      )
    );
    return;
  }
  if (resource === "domains" && action === "update") {
    const domainId = rest[0];
    if (!domainId) {
      throw new UsageError(
        "usage: wzrdmail domains update <domain_id> [--custom-return-path PATH]"
      );
    }
    const updated = await ctx.client.domains.update(domainId, {
      custom_return_path: stringFlag(flags, "custom-return-path"),
      client_id: stringFlag(flags, "client-id")
    });
    emit(ctx, updated, () => formatRecord(updated));
    return;
  }

  if (resource === "pods" && action === "list") {
    const page = await ctx.client.pods.list(pagination);
    emit(ctx, page, () =>
      formatTable(
        ["POD_ID", "NAME", "CREATED_AT"],
        page.pods.map((p) => [p.pod_id, p.name, p.created_at])
      )
    );
    return;
  }
  if (resource === "pods" && action === "create") {
    const pod = await ctx.client.pods.create({
      name: stringFlag(flags, "name"),
      client_id: stringFlag(flags, "client-id")
    });
    emit(ctx, pod, () => formatRecord(pod));
    return;
  }

  if (resource === "keys" && action === "list") {
    const page = await ctx.client.apiKeys.list(pagination);
    emit(ctx, page, () =>
      formatTable(
        ["API_KEY_ID", "NAME", "POD_ID", "CREATED_AT"],
        page.api_keys.map((k) => [k.api_key_id, k.name, k.pod_id ?? "", k.created_at])
      )
    );
    return;
  }
  if (resource === "keys" && action === "create") {
    const key = await ctx.client.apiKeys.create({
      name: stringFlag(flags, "name"),
      pod_id: stringFlag(flags, "pod-id"),
      inbox_id: stringFlag(flags, "inbox-id"),
      permissions: stringFlag(flags, "permissions")?.split(",").map((p) => p.trim()).filter(Boolean),
      client_id: stringFlag(flags, "client-id")
    });
    emit(ctx, key, () => formatRecord(key));
    return;
  }
  if (resource === "keys" && action === "update") {
    const keyId = rest[0];
    if (!keyId) throw new UsageError("usage: wzrdmail keys update <key_id> [--name NAME]");
    const result = await ctx.client.apiKeys.update(keyId, {
      name: stringFlag(flags, "name")
    });
    emit(ctx, result, () => formatRecord(result));
    return;
  }
  if (resource === "keys" && action === "revoke") {
    const keyId = rest[0];
    if (!keyId) throw new UsageError("usage: wzrdmail keys revoke <key_id>");
    await ctx.client.apiKeys.delete(keyId);
    emit(ctx, { revoked: true, api_key_id: keyId }, () => `revoked ${keyId}`);
    return;
  }

  if (resource === "suppressions" && action === "list") {
    const page = await ctx.client.suppressions.list({
      ...pagination,
      reason: stringFlag(flags, "reason")
    });
    emit(ctx, page, () =>
      formatTable(
        ["ADDRESS", "REASON", "SOURCE_MSG_ID", "CREATED_AT"],
        suppressionRows(page.suppressions)
      )
    );
    return;
  }
  if (resource === "suppressions" && action === "add") {
    const address = rest[0];
    if (!address) throw new UsageError("usage: wzrdmail suppressions add <address>");
    const suppression = await ctx.client.suppressions.add({ address });
    emit(ctx, suppression, () => formatRecord(suppression));
    return;
  }
  if (resource === "suppressions" && action === "remove") {
    const address = rest[0];
    if (!address) throw new UsageError("usage: wzrdmail suppressions remove <address>");
    await ctx.client.suppressions.remove(address);
    emit(ctx, { removed: true, address }, () => `removed ${address}`);
    return;
  }
  if (resource === "suppressions" && action === "batch") {
    const add = listFlag(flags, "add");
    const remove = listFlag(flags, "remove");
    if (!add?.length && !remove?.length) {
      throw new UsageError("suppressions batch needs --add and/or --remove lists");
    }
    const result = await ctx.client.suppressions.batch({ add, remove });
    emit(ctx, result, () => {
      const lines = [`added ${result.added.length}, removed ${result.removed.length}`];
      if (result.added.length > 0) {
        lines.push(
          formatTable(
            ["ADDRESS", "REASON", "SOURCE_MSG_ID", "CREATED_AT"],
            suppressionRows(result.added)
          )
        );
      }
      for (const address of result.removed) lines.push(`removed ${address}`);
      return lines.join("\n");
    });
    return;
  }

  if (resource === "templates" && action === "list") {
    const page = await ctx.client.templates.list(pagination);
    emit(ctx, page, () =>
      formatTable(
        ["TEMPLATE_ID", "NAME", "STATUS", "UPDATED_AT"],
        templateRows(page.templates)
      )
    );
    return;
  }
  if (resource === "templates" && action === "create") {
    const template = await ctx.client.templates.create({
      name: requireStringFlag(flags, "name"),
      subject: stringFlag(flags, "subject"),
      from: stringFlag(flags, "from"),
      reply_to: stringFlag(flags, "reply-to"),
      html: stringFlag(flags, "html"),
      text: stringFlag(flags, "text"),
      client_id: stringFlag(flags, "client-id")
    });
    emit(ctx, template, () => formatRecord(template));
    return;
  }
  if (resource === "templates" && action === "get") {
    const templateId = rest[0];
    if (!templateId) throw new UsageError("usage: wzrdmail templates get <template_id>");
    const template = await ctx.client.templates.get(templateId);
    emit(ctx, template, () => formatRecord(template));
    return;
  }
  if (resource === "templates" && action === "update") {
    const templateId = rest[0];
    if (!templateId) {
      throw new UsageError("usage: wzrdmail templates update <template_id> [--name N] …");
    }
    const template = await ctx.client.templates.update(templateId, {
      name: stringFlag(flags, "name"),
      subject: stringFlag(flags, "subject"),
      from: stringFlag(flags, "from"),
      reply_to: stringFlag(flags, "reply-to"),
      html: stringFlag(flags, "html"),
      text: stringFlag(flags, "text")
    });
    emit(ctx, template, () => formatRecord(template));
    return;
  }
  if (resource === "templates" && action === "delete") {
    const templateId = rest[0];
    if (!templateId) throw new UsageError("usage: wzrdmail templates delete <template_id>");
    await ctx.client.templates.delete(templateId);
    emit(ctx, { deleted: true, template_id: templateId }, () => `deleted ${templateId}`);
    return;
  }
  if (resource === "templates" && action === "publish") {
    const templateId = rest[0];
    if (!templateId) throw new UsageError("usage: wzrdmail templates publish <template_id>");
    const template = await ctx.client.templates.publish(templateId);
    emit(ctx, template, () => formatRecord(template));
    return;
  }
  if (resource === "templates" && action === "duplicate") {
    const templateId = rest[0];
    if (!templateId) throw new UsageError("usage: wzrdmail templates duplicate <template_id>");
    const template = await ctx.client.templates.duplicate(templateId);
    emit(ctx, template, () => formatRecord(template));
    return;
  }

  if (resource === "usage" && action === undefined) {
    const usage = await ctx.client.metrics.usage({
      month: stringFlag(flags, "month")
    });
    emit(ctx, usage, () =>
      formatTable(
        ["METRIC", "USED", "LIMIT"],
        usage.metrics.map((m) => [m.metric, m.used, m.limit ?? "∞"])
      )
    );
    return;
  }

  if (resource === "auth" && action === "login") {
    const key = stringFlag(flags, "api-key") ?? ctx.io.env["WZRDMAIL_API_KEY"];
    if (key === undefined || key === "") {
      throw new UsageError(
        "auth login needs --api-key wm_… (device-code console login lands with the console)"
      );
    }
    const path = configPath(ctx.io.env);
    storeApiKey(path, key);
    emit(ctx, { logged_in: true, config_path: path }, () => `key stored in ${path}`);
    return;
  }
  if (resource === "auth" && action === "whoami") {
    const me = await ctx.client.auth.me();
    emit(ctx, me, () => formatRecord(me));
    return;
  }
  if (resource === "auth" && action === "logout") {
    const path = configPath(ctx.io.env);
    const removed = clearApiKey(path);
    emit(ctx, { logged_out: removed }, () =>
      removed ? `removed ${path}` : "no stored key"
    );
    return;
  }

  if (resource === "events" && action === "tail") {
    if (ctx.apiKey === undefined) {
      throw new WzrdmailError(401, {
        name: "unauthorized",
        message: "events tail requires an API key (set WZRDMAIL_API_KEY or run wzrdmail login)"
      });
    }
    const max = numberFlag(flags, "max");
    if (max !== undefined && (!Number.isInteger(max) || max < 1)) {
      throw new UsageError("--max must be a positive integer");
    }
    await tailEvents({
      apiKey: ctx.apiKey,
      baseUrl: ctx.io.env["WZRDMAIL_BASE_URL"],
      inboxIds: listFlag(flags, "inbox-ids"),
      max,
      onEvent: (line) => {
        ctx.io.stdout(line);
      },
      webSocket: ctx.io.webSocket,
      sleep: ctx.io.sleep
    });
    return;
  }

  if (resource === "agent" && action === "sign-up") {
    const result = await ctx.client.agent.signUp({
      human_email: requireStringFlag(flags, "human-email"),
      username: requireStringFlag(flags, "username")
    });
    emit(ctx, result, () => formatRecord(result));
    return;
  }
  if (resource === "agent" && action === "verify") {
    const result = await ctx.client.agent.verify({
      otp_code: requireStringFlag(flags, "otp-code")
    });
    emit(ctx, result, () => formatRecord(result));
    return;
  }

  throw new UsageError(
    `unknown command: ${positionals.join(" ") || "(none)"}\n\n${HELP}`
  );
}

function errorExitCode(error: WzrdmailError): number {
  if (error.name === "unauthorized" || error.status === 401) return EXIT_AUTH;
  if (error.name === "plan_limit_exceeded") return EXIT_LIMIT;
  return EXIT_ERROR;
}

/** `WZRDMAIL_API_KEY` env always wins > `--api-key` flag > stored config key (§10). */
function resolveApiKey(
  flags: Record<string, string | boolean>,
  env: Record<string, string | undefined>
): string | undefined {
  const envKey = env["WZRDMAIL_API_KEY"];
  if (envKey !== undefined && envKey !== "") return envKey;
  const flagKey = flags["api-key"];
  if (typeof flagKey === "string" && flagKey !== "") return flagKey;
  return readStoredApiKey(configPath(env));
}

export async function run(argv: string[], io: RunIo): Promise<number> {
  const { flags, positionals } = parseArgs(argv);
  const rawFormat = flags["format"];
  const format: Format = rawFormat === "json" ? "json" : "table";

  const apiKey = resolveApiKey(flags, io.env);
  const client = new WzrdMailClient({
    apiKey,
    baseUrl: io.env["WZRDMAIL_BASE_URL"],
    fetch: io.fetch
  });

  try {
    if (rawFormat !== undefined && rawFormat !== "json" && rawFormat !== "table") {
      throw new UsageError('--format must be "table" or "json"');
    }
    if (flags["help"] === true || positionals.length === 0) {
      io.stdout(HELP);
      return EXIT_OK;
    }
    const argv2 = positionals[0] === "login" ? ["auth", ...argv] : argv;
    await dispatch({ client, format, io, apiKey }, argv2);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof WzrdmailError) {
      if (format === "json") {
        io.stderr(JSON.stringify(error.body));
      } else {
        io.stderr(`error (${error.name}): ${error.message}`);
      }
      return errorExitCode(error);
    }
    const message = error instanceof Error ? error.message : String(error);
    if (format === "json") {
      io.stderr(JSON.stringify({ name: "cli_error", message }));
    } else {
      io.stderr(`error: ${message}`);
    }
    if (error instanceof Error && /apiKey is required/.test(message)) {
      return EXIT_AUTH;
    }
    return EXIT_ERROR;
  }
}
