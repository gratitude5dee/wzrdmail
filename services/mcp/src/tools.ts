import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
 * Registers the §9 toolset. Every tool proxies one §7 REST endpoint on
 * api.wzrd.tech using the caller's API key; results are raw API JSON so ids
 * needed for the next call are always present.
 */
export function registerTools(server: McpServer, api: ApiClient): void {
  server.tool(
    "list_inboxes",
    "List the inboxes your API key can see. Returns inbox_id values used by every other tool.",
    { ...pagination },
    wrap((args) => api.request({ method: "GET", path: "/v0/inboxes", query: args }))
  );

  server.tool(
    "create_inbox",
    "Create a new email inbox (username@domain). Omit fields to get defaults.",
    CreateInboxInput.shape,
    wrap((body) => api.request({ method: "POST", path: "/v0/inboxes", body }))
  );

  server.tool(
    "get_inbox",
    "Get one inbox by its inbox_id (the email address).",
    { inbox_id: inboxId },
    wrap(({ inbox_id }) =>
      api.request({ method: "GET", path: `/v0/inboxes/${encodePath(inbox_id)}` })
    )
  );

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
    "list_webhooks",
    "List the organization's webhooks.",
    { ...pagination },
    wrap((query) => api.request({ method: "GET", path: "/v0/webhooks", query }))
  );

  server.tool(
    "create_webhook",
    "Create a webhook. Returns the signing secret once — store it.",
    {
      url: z.string().describe("HTTPS endpoint to receive events."),
      event_types: z.array(z.string()).describe("Event types, e.g. message.received."),
      inbox_id: z.string().optional().describe("Scope to one inbox (omit for org-wide).")
    },
    wrap((body) => api.request({ method: "POST", path: "/v0/webhooks", body }))
  );

  server.tool(
    "list_domains",
    "List the organization's sending domains and their verification status.",
    { ...pagination },
    wrap((query) => api.request({ method: "GET", path: "/v0/domains", query }))
  );

  server.tool(
    "get_usage",
    "Get this month's usage per metric versus plan limits.",
    { month: z.string().optional().describe("Month as YYYY-MM (default: current).") },
    wrap((query) => api.request({ method: "GET", path: "/v0/metrics/usage", query }))
  );
}
