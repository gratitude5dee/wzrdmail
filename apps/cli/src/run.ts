import {
  WzrdMailClient,
  WzrdmailError,
  type FetchLike,
  type Inbox,
  type Message,
  type Thread
} from "wzrdmail";
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
}

const HELP = `wzrdmail — email for AI agents (https://docs.wzrd.tech)

Usage: wzrdmail [--format json|table] <command>

Commands:
  inboxes list [--limit N] [--page-token TOKEN]
  inboxes create [--username U] [--domain D] [--display-name NAME] [--client-id ID]
  inboxes get <inbox_id>
  messages send <inbox_id> --to a@b.com[,c@d.com] [--subject S] [--text T] [--html H] [--cc ..] [--bcc ..] [--client-id ID]
  messages list <inbox_id> [--limit N] [--page-token TOKEN] [--labels l1,l2] [--before TS] [--after TS]
  threads list <inbox_id> [--limit N] [--page-token TOKEN]
  threads get <inbox_id> <thread_id>
  agent sign-up --human-email EMAIL --username U
  agent verify --otp-code CODE

Environment:
  WZRDMAIL_API_KEY   API key (required except for agent sign-up)
  WZRDMAIL_BASE_URL  API base URL (default https://api.wzrd.tech)

Flags:
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
  if (resource === "threads" && action === "get") {
    const [inboxId, threadId] = rest;
    if (!inboxId || !threadId) {
      throw new UsageError("usage: wzrdmail threads get <inbox_id> <thread_id>");
    }
    const thread = await ctx.client.inboxes.threads.get(inboxId, threadId);
    emit(ctx, thread, () => formatRecord(thread));
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

export async function run(argv: string[], io: RunIo): Promise<number> {
  const { flags, positionals } = parseArgs(argv);
  const format: Format = stringFlag(flags, "format") === "json" ? "json" : "table";

  if (flags["help"] === true || positionals.length === 0) {
    io.stdout(HELP);
    return EXIT_OK;
  }

  const client = new WzrdMailClient({
    apiKey: io.env["WZRDMAIL_API_KEY"],
    baseUrl: io.env["WZRDMAIL_BASE_URL"],
    fetch: io.fetch
  });

  try {
    await dispatch({ client, format, io }, argv);
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
