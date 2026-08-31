import {
  WzrdMailClient,
  WzrdmailError,
  type Draft,
  type FetchLike,
  type Inbox,
  type Message,
  type Thread,
  type Webhook
} from "wzrdmail";
import { clearApiKey, configPath, readStoredApiKey, storeApiKey } from "./config.js";
import { tailEvents, type WebSocketFactory } from "./events.js";
import {
  UsageError,
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

const HELP = `wzrdmail — email for AI agents (https://mail.wzrd.tech/docs)

Usage: wzrdmail [--format json|table] <command>

Commands:
  inboxes list [--limit N] [--page-token TOKEN]
  inboxes create [--username U] [--domain D] [--display-name NAME] [--client-id ID]
  inboxes get <inbox_id>
  messages send <inbox_id> --to a@b.com[,c@d.com] [--subject S] [--text T] [--html H] [--cc ..] [--bcc ..] [--client-id ID]
  messages list <inbox_id> [--limit N] [--page-token TOKEN] [--labels l1,l2] [--before TS] [--after TS]
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
  messages reply <inbox_id> <message_id> [--text T] [--html H] [--cc ..] [--bcc ..] [--all]
  messages forward <inbox_id> <message_id> --to a@b.com[,c@d.com] [--text T]
  drafts list <inbox_id>
  drafts create <inbox_id> [--to ..] [--subject S] [--text T] [--html H]
  drafts send <inbox_id> <draft_id>
  webhooks list|create|delete|test  (create: --url URL --event-types t1,t2; test: <webhook_id>)
  domains list|add|verify|records  (add: --domain D; verify/records: <domain_id>)
  pods list|create             (create: [--name NAME])
  keys list|create|revoke      (create: [--name NAME] [--pod-id ID]; revoke: <key_id>)
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

  if (resource === "messages" && action === "send") {
    const inboxId = rest[0];
    if (!inboxId) throw new UsageError("usage: wzrdmail messages send <inbox_id> --to …");
    const to = listFlag(flags, "to");
    if (!to || to.length === 0) throw new UsageError("--to is required");
    const message = await ctx.client.inboxes.messages.send(inboxId, {
      to,
      cc: listFlag(flags, "cc"),
      bcc: listFlag(flags, "bcc"),
      subject: stringFlag(flags, "subject") ?? "",
      text: stringFlag(flags, "text"),
      html: stringFlag(flags, "html"),
      client_id: stringFlag(flags, "client-id")
    });
    emit(ctx, message, () => formatRecord(message));
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
    const input = {
      text: stringFlag(flags, "text"),
      html: stringFlag(flags, "html"),
      cc: listFlag(flags, "cc"),
      bcc: listFlag(flags, "bcc"),
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
    const message = await ctx.client.inboxes.messages.forward(inboxId, messageId, {
      to,
      cc: listFlag(flags, "cc"),
      bcc: listFlag(flags, "bcc"),
      text: stringFlag(flags, "text"),
      html: stringFlag(flags, "html"),
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
    const draft = await ctx.client.inboxes.drafts.create(inboxId, {
      to: listFlag(flags, "to"),
      cc: listFlag(flags, "cc"),
      bcc: listFlag(flags, "bcc"),
      subject: stringFlag(flags, "subject"),
      text: stringFlag(flags, "text"),
      html: stringFlag(flags, "html"),
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
      client_id: stringFlag(flags, "client-id")
    });
    emit(ctx, key, () => formatRecord(key));
    return;
  }
  if (resource === "keys" && action === "revoke") {
    const keyId = rest[0];
    if (!keyId) throw new UsageError("usage: wzrdmail keys revoke <key_id>");
    await ctx.client.apiKeys.delete(keyId);
    emit(ctx, { revoked: true, api_key_id: keyId }, () => `revoked ${keyId}`);
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
