import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { CreateInboxInput, SendMessageInput } from "@wzrdmail/core";
import { WzrdmailError } from "wzrdmail";
import { z } from "zod";

import { ApiClient, encodePath } from "./api.js";

const pagination = {
  limit: z.number().int().min(1).max(100).optional().describe("Page size (default 20, max 100)."),
  page_token: z
    .string()
    .optional()
    .describe("Opaque cursor from a previous response's next_page_token.")
};

const inboxId = z
  .string()
  .describe("Inbox address, e.g. scout@wzrd.tech (returned as inbox_id by inbox tools).");
const messageId = z.string().describe("Message id (msg_…), from message list/get results.");

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
});

const wrap =
  <A>(handler: (args: A) => Promise<unknown>) =>
  async (args: A): Promise<ToolResult> => {
    try {
      return ok(await handler(args));
    } catch (error) {
      if (error instanceof WzrdmailError) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: error.body, status: error.status }, null, 2)
            }
          ]
        };
      }
      throw error;
    }
  };

const replyShape = {
  inbox_id: inboxId,
  message_id: messageId,
  text: z.string().optional().describe("Plain-text body."),
  html: z.string().optional().describe("HTML body."),
  labels: z.array(z.string()).optional(),
  client_id: z.string().optional()
};


/**
 * Tool metadata for the Muse connector (muse.md §6).
 *
 * `permission` mirrors the API's own vocabulary (services/api/src/auth.ts
 * requirePermission: admin implies everything, send implies drafts), so an
 * OAuth connection registers exactly the tools its grant can actually use and
 * Muse never sees a tool that would answer 403.
 *
 * `annotations` are what a consumer agent keys its confirmation prompts off:
 * anything that puts mail on the wire is destructive and open-world.
 */
export type Permission = "read" | "drafts" | "send" | "admin";

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false
};
const MUTATES: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};
const CREATES: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
};
/** Mail leaves the system: irreversible, and the effect is outside wzrdmail. */
const SENDS_MAIL: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true
};

const TOOL_META: Record<string, { permission: Permission; annotations: ToolAnnotations }> = {
  list_inboxes: { permission: "read", annotations: READ_ONLY },
  create_inbox: { permission: "admin", annotations: CREATES },
  get_inbox: { permission: "read", annotations: READ_ONLY },
  list_messages: { permission: "read", annotations: READ_ONLY },
  get_message: { permission: "read", annotations: READ_ONLY },
  send_message: { permission: "send", annotations: SENDS_MAIL },
  reply_to_message: { permission: "send", annotations: SENDS_MAIL },
  reply_all_to_message: { permission: "send", annotations: SENDS_MAIL },
  forward_message: { permission: "send", annotations: SENDS_MAIL },
  update_message: { permission: "read", annotations: MUTATES },
  list_threads: { permission: "read", annotations: READ_ONLY },
  get_thread: { permission: "read", annotations: READ_ONLY },
  search_threads: { permission: "read", annotations: READ_ONLY },
  list_drafts: { permission: "read", annotations: READ_ONLY },
  create_draft: { permission: "drafts", annotations: CREATES },
  update_draft: { permission: "drafts", annotations: MUTATES },
  send_draft: { permission: "send", annotations: SENDS_MAIL },
  get_attachment: { permission: "read", annotations: READ_ONLY },
  list_webhooks: { permission: "read", annotations: READ_ONLY },
  create_webhook: { permission: "admin", annotations: CREATES },
  list_domains: { permission: "read", annotations: READ_ONLY },
  get_usage: { permission: "read", annotations: READ_ONLY },
  whoami: { permission: "read", annotations: READ_ONLY },
  check_new_mail: { permission: "read", annotations: READ_ONLY }
};

/** The API's implication rules, applied client-side so tools/list matches reality. */
export const permits = (held: readonly string[], required: Permission): boolean => {
  if (held.includes("admin")) return true;
  if (held.includes(required)) return true;
  return required === "drafts" && held.includes("send");
};

export interface RegisterToolsOptions {
  /** Granted permissions; when omitted every tool is registered. */
  permissions?: readonly string[];
  /** Inbox this connection is pinned to; makes inbox_id optional on every tool. */
  inboxId?: string;
}

/**
 * Registration gate: looks each tool up in TOOL_META, drops the ones the
 * connection cannot use, and forwards the rest to the SDK's
 * `tool(name, description, shape, annotations, cb)` overload.
 */
const gate = (server: McpServer, options: RegisterToolsOptions) => ({
  tool<Args extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: Args,
    cb: ToolCallback<Args>
  ): void {
    const meta = TOOL_META[name];
    if (meta === undefined) throw new Error(`tool ${name} has no TOOL_META entry`);
    if (options.permissions !== undefined && !permits(options.permissions, meta.permission)) {
      return;
    }
    const pinned = options.inboxId;
    if (pinned !== undefined && "inbox_id" in shape) {
      // The connection owns exactly one inbox, so asking Muse to repeat its own
      // address on every call is noise: make it optional and fill it in.
      const relaxed = {
        ...shape,
        inbox_id: z
          .string()
          .optional()
          .describe(`Inbox address; defaults to this connection's inbox (${pinned}).`)
      } as unknown as Args;
      type Extra = Parameters<ToolCallback<Args>>[1];
      const withDefault = ((args: Record<string, unknown>, extra: Extra) => {
        const filled = { ...args, inbox_id: args.inbox_id ?? pinned };
        return (cb as (a: unknown, e: Extra) => unknown)(filled, extra);
      }) as unknown as ToolCallback<Args>;
      server.tool(name, description, relaxed, meta.annotations, withDefault);
      return;
    }
    server.tool(name, description, shape, meta.annotations, cb);
  }
});

/**
 * Registers the §9 toolset. Every tool proxies one §7 REST endpoint on
 * api.wzrd.tech using the caller's API key; results are raw API JSON so ids
 * needed for the next call are always present.
 */
export function registerTools(
  server: McpServer,
  api: ApiClient,
  options: RegisterToolsOptions = {}
): void {
  const s = gate(server, options);
  s.tool(
    "list_inboxes",
    "List the inboxes your API key can see. Returns inbox_id values used by every other tool.",
    { ...pagination },
    wrap((args) => api.request({ method: "GET", path: "/v0/inboxes", query: args }))
  );

  s.tool(
    "create_inbox",
    "Create a new email inbox (username@domain). Omit fields to get defaults.",
    CreateInboxInput.shape,
    wrap((body) => api.request({ method: "POST", path: "/v0/inboxes", body }))
  );

  s.tool(
    "get_inbox",
    "Get one inbox by its inbox_id (the email address).",
    { inbox_id: inboxId },
    wrap(({ inbox_id }) =>
      api.request({ method: "GET", path: `/v0/inboxes/${encodePath(inbox_id)}` })
    )
  );

  s.tool(
    "list_messages",
    "List messages in an inbox, newest first. Filter by labels (comma-separated) or time bounds.",
    {
      inbox_id: inboxId,
      ...pagination,
      labels: z.array(z.string()).optional().describe("Only messages with all of these labels."),
      before: z.string().optional().describe("ISO-8601 upper bound on created_at."),
      after: z.string().optional().describe("ISO-8601 lower bound on created_at.")
    },
    wrap(({ inbox_id, labels, ...query }) =>
      api.request({
        method: "GET",
        path: `/v0/inboxes/${encodePath(inbox_id)}/messages`,
        query: { ...query, labels: labels === undefined ? undefined : labels.join(",") }
      })
    )
  );

  s.tool(
    "get_message",
    "Get one message including text, html, extracted_text, and attachment metadata.",
    { inbox_id: inboxId, message_id: messageId },
    wrap(({ inbox_id, message_id }) =>
      api.request({
        method: "GET",
        path: `/v0/inboxes/${encodePath(inbox_id)}/messages/${encodePath(message_id)}`
      })
    )
  );

  s.tool(
    "send_message",
    "Send a new email from an inbox. Returns the created message with message_id and thread_id.",
    { inbox_id: inboxId, ...SendMessageInput.shape },
    wrap(({ inbox_id, ...body }) =>
      api.request({
        method: "POST",
        path: `/v0/inboxes/${encodePath(inbox_id)}/messages/send`,
        body
      })
    )
  );

  s.tool(
    "reply_to_message",
    "Reply to a message (sender only). Threading headers are set automatically.",
    replyShape,
    wrap(({ inbox_id, message_id, ...body }) =>
      api.request({
        method: "POST",
        path: `/v0/inboxes/${encodePath(inbox_id)}/messages/${encodePath(message_id)}/reply`,
        body
      })
    )
  );

  s.tool(
    "reply_all_to_message",
    "Reply to a message including all original recipients.",
    replyShape,
    wrap(({ inbox_id, message_id, ...body }) =>
      api.request({
        method: "POST",
        path: `/v0/inboxes/${encodePath(inbox_id)}/messages/${encodePath(message_id)}/reply-all`,
        body
      })
    )
  );

  s.tool(
    "forward_message",
    "Forward a message to new recipients.",
    {
      inbox_id: inboxId,
      message_id: messageId,
      to: z.array(z.string()).min(1).describe("Recipient email addresses."),
      text: z.string().optional().describe("Note to prepend."),
      client_id: z.string().optional()
    },
    wrap(({ inbox_id, message_id, ...body }) =>
      api.request({
        method: "POST",
        path: `/v0/inboxes/${encodePath(inbox_id)}/messages/${encodePath(message_id)}/forward`,
        body
      })
    )
  );

  s.tool(
    "update_message",
    "Update a message's labels or read state.",
    {
      inbox_id: inboxId,
      message_id: messageId,
      add_labels: z.array(z.string()).optional(),
      remove_labels: z.array(z.string()).optional()
    },
    wrap(({ inbox_id, message_id, ...body }) =>
      api.request({
        method: "PATCH",
        path: `/v0/inboxes/${encodePath(inbox_id)}/messages/${encodePath(message_id)}`,
        body
      })
    )
  );

  s.tool(
    "list_threads",
    "List conversation threads in an inbox, most recently active first.",
    { inbox_id: inboxId, ...pagination },
    wrap(({ inbox_id, ...query }) =>
      api.request({
        method: "GET",
        path: `/v0/inboxes/${encodePath(inbox_id)}/threads`,
        query
      })
    )
  );

  s.tool(
    "get_thread",
    "Get one thread with all its messages.",
    {
      inbox_id: inboxId,
      thread_id: z.string().describe("Thread id (thread_…), from thread list results.")
    },
    wrap(({ inbox_id, thread_id }) =>
      api.request({
        method: "GET",
        path: `/v0/inboxes/${encodePath(inbox_id)}/threads/${encodePath(thread_id)}`
      })
    )
  );

  s.tool(
    "search_threads",
    "Full-text search threads in an inbox.",
    { inbox_id: inboxId, query: z.string().describe("Search query."), ...pagination },
    wrap(({ inbox_id, query, ...rest }) =>
      api.request({
        method: "GET",
        path: `/v0/inboxes/${encodePath(inbox_id)}/threads/search`,
        query: { ...rest, query }
      })
    )
  );

  s.tool(
    "list_drafts",
    "List draft messages in an inbox.",
    { inbox_id: inboxId, ...pagination },
    wrap(({ inbox_id, ...query }) =>
      api.request({
        method: "GET",
        path: `/v0/inboxes/${encodePath(inbox_id)}/drafts`,
        query
      })
    )
  );

  s.tool(
    "create_draft",
    "Create a draft (not sent until send_draft). Use this when send permission is held elsewhere.",
    { inbox_id: inboxId, ...SendMessageInput.shape },
    wrap(({ inbox_id, ...body }) =>
      api.request({
        method: "POST",
        path: `/v0/inboxes/${encodePath(inbox_id)}/drafts`,
        body
      })
    )
  );

  s.tool(
    "update_draft",
    "Update an existing draft's fields.",
    {
      inbox_id: inboxId,
      draft_id: z.string().describe("Draft id, from draft list/create results."),
      ...SendMessageInput.partial().shape
    },
    wrap(({ inbox_id, draft_id, ...body }) =>
      api.request({
        method: "PATCH",
        path: `/v0/inboxes/${encodePath(inbox_id)}/drafts/${encodePath(draft_id)}`,
        body
      })
    )
  );

  s.tool(
    "send_draft",
    "Send a previously created draft.",
    { inbox_id: inboxId, draft_id: z.string() },
    wrap(({ inbox_id, draft_id }) =>
      api.request({
        method: "POST",
        path: `/v0/inboxes/${encodePath(inbox_id)}/drafts/${encodePath(draft_id)}/send`
      })
    )
  );

  s.tool(
    "get_attachment",
    "Get an attachment: signed download URL plus extracted text when small.",
    {
      inbox_id: inboxId,
      message_id: messageId,
      attachment_id: z.string().describe("Attachment id from message attachment metadata.")
    },
    wrap(({ inbox_id, message_id, attachment_id }) =>
      api.request({
        method: "GET",
        path: `/v0/inboxes/${encodePath(inbox_id)}/messages/${encodePath(message_id)}/attachments/${encodePath(attachment_id)}`
      })
    )
  );

  s.tool(
    "list_webhooks",
    "List the organization's webhooks.",
    { ...pagination },
    wrap((query) => api.request({ method: "GET", path: "/v0/webhooks", query }))
  );

  s.tool(
    "create_webhook",
    "Create a webhook. Returns the signing secret once — store it.",
    {
      url: z.string().describe("HTTPS endpoint to receive events."),
      event_types: z.array(z.string()).describe("Event types, e.g. message.received."),
      inbox_id: z.string().optional().describe("Scope to one inbox (omit for org-wide).")
    },
    wrap((body) => api.request({ method: "POST", path: "/v0/webhooks", body }))
  );

  s.tool(
    "list_domains",
    "List the organization's sending domains and their verification status.",
    { ...pagination },
    wrap((query) => api.request({ method: "GET", path: "/v0/domains", query }))
  );

  s.tool(
    "get_usage",
    "Get this month's usage per metric versus plan limits.",
    { month: z.string().optional().describe("Month as YYYY-MM (default: current).") },
    wrap((query) => api.request({ method: "GET", path: "/v0/metrics/usage", query }))
  );
  s.tool(
    "whoami",
    "Call this first. Reports which @wzrd.tech address this connection owns, what it is allowed to do, and whether the account is verified for sending to outside recipients.",
    {},
    wrap(async () => {
      const me = await api.request({ method: "GET", path: "/v0/auth/me" });
      const base = typeof me === "object" && me !== null ? (me as Record<string, unknown>) : {};
      return {
        ...base,
        // An OAuth connection is pinned to one inbox; the API knows it only for
        // inbox-scoped keys, so fall back to what the grant told us.
        inbox_id: base.inbox_id ?? options.inboxId ?? null,
        granted_permissions: options.permissions ?? base.permissions ?? null
      };
    })
  );

  s.tool(
    "check_new_mail",
    "Poll for mail that arrived since you last looked. Pass the next_since value from your previous call (omit it the first time) and persist the next_since you get back between runs; there is no push notification.",
    {
      inbox_id: inboxId,
      since: z
        .string()
        .optional()
        .describe("ISO-8601 timestamp from a previous next_since. Omit to read the latest mail."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum messages to return (default 20, max 100).")
    },
    wrap(async ({ inbox_id, since, limit }) => {
      const result = await api.request({
        method: "GET",
        path: `/v0/inboxes/${encodePath(inbox_id)}/messages`,
        query: { after: since, limit }
      });
      const messages =
        typeof result === "object" && result !== null && Array.isArray((result as { messages?: unknown }).messages)
          ? ((result as { messages: unknown[] }).messages as Record<string, unknown>[])
          : [];
      let nextSince = since ?? null;
      for (const message of messages) {
        const createdAt = message.created_at;
        if (typeof createdAt === "string" && (nextSince === null || createdAt > nextSince)) {
          nextSince = createdAt;
        }
      }
      return { messages, count: messages.length, next_since: nextSince };
    })
  );
}
