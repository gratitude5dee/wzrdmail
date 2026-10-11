import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateInboxInput,
  CreateSuppressionInput,
  CreateTemplateInput,
  ReplyTo,
  SendMessageInput,
  ShareMessageInput,
  UpdateDomainInput,
  UpdateInboxInput,
  UpdateTemplateInput
} from "@wzrdmail/core";
import { WzrdmailError } from "wzrdmail";
import { z } from "zod";

import { ApiClient, encodePath } from "./api.js";
import {
  MAILBOX_RESOURCE_URI,
  MESSAGE_RESOURCE_URI,
  uiToolMeta
} from "./extensions.js";

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
  reply_to: ReplyTo.optional().describe("Reply-To address or list of addresses."),
  client_id: z.string().optional()
};

/**
 * Registers the §9 toolset. Every tool proxies one §7 REST endpoint on
 * api.wzrd.tech using the caller's API key; results are raw API JSON so ids
 * needed for the next call are always present.
 */
export function registerTools(server: McpServer, api: ApiClient): void {
  server.registerTool(
    "list_inboxes",
    {
      description:
        "List the inboxes your API key can see. Returns inbox_id values used by every other tool.",
      inputSchema: { ...pagination },
      _meta: uiToolMeta(MAILBOX_RESOURCE_URI)
    },
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

  server.registerTool(
    "list_messages",
    {
      description:
        "List messages in an inbox, newest first. Filter by labels (comma-separated) or time bounds.",
      inputSchema: {
        inbox_id: inboxId,
        ...pagination,
        labels: z.array(z.string()).optional().describe("Only messages with all of these labels."),
        before: z.string().optional().describe("ISO-8601 upper bound on created_at."),
        after: z.string().optional().describe("ISO-8601 lower bound on created_at.")
      },
      _meta: uiToolMeta(MAILBOX_RESOURCE_URI)
    },
    wrap(({ inbox_id, labels, ...query }) =>
      api.request({
        method: "GET",
        path: `/v0/inboxes/${encodePath(inbox_id)}/messages`,
        query: { ...query, labels: labels === undefined ? undefined : labels.join(",") }
      })
    )
  );

  server.registerTool(
    "get_message",
    {
      description:
        "Get one message including text, html, extracted_text, and attachment metadata.",
      inputSchema: { inbox_id: inboxId, message_id: messageId },
      _meta: uiToolMeta(MESSAGE_RESOURCE_URI)
    },
    wrap(({ inbox_id, message_id }) =>
      api.request({
        method: "GET",
        path: `/v0/inboxes/${encodePath(inbox_id)}/messages/${encodePath(message_id)}`
      })
    )
  );

  server.registerTool(
    "send_message",
    {
      description:
        "Send a new email from an inbox. Returns the created message with message_id and thread_id.",
      inputSchema: { inbox_id: inboxId, ...SendMessageInput.shape },
      _meta: uiToolMeta(MESSAGE_RESOURCE_URI)
    },
    wrap(({ inbox_id, ...body }) =>
      api.request({
        method: "POST",
        path: `/v0/inboxes/${encodePath(inbox_id)}/messages/send`,
        body
      })
    )
  );

  server.registerTool(
    "reply_to_message",
    {
      description:
        "Reply to a message (sender only). Threading headers are set automatically.",
      inputSchema: replyShape,
      _meta: uiToolMeta(MESSAGE_RESOURCE_URI)
    },
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
      reply_to: ReplyTo.optional().describe("Reply-To address or list of addresses."),
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
    "Update a message's labels, read state, or scheduled send_at.",
    {
      inbox_id: inboxId,
      message_id: messageId,
      add_labels: z.array(z.string()).optional(),
      remove_labels: z.array(z.string()).optional(),
      read: z.boolean().optional(),
      send_at: z.string().optional().describe("ISO-8601 time to send (scheduled messages).")
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

  server.registerTool(
    "list_drafts",
    {
      description: "List draft messages in an inbox.",
      inputSchema: { inbox_id: inboxId, ...pagination },
      _meta: uiToolMeta(MAILBOX_RESOURCE_URI)
    },
    wrap(({ inbox_id, ...query }) =>
      api.request({
        method: "GET",
        path: `/v0/inboxes/${encodePath(inbox_id)}/drafts`,
        query
      })
    )
  );

  server.registerTool(
    "create_draft",
    {
      description:
        "Create a draft (not sent until send_draft). Use this when send permission is held elsewhere.",
      inputSchema: { inbox_id: inboxId, ...SendMessageInput.shape },
      _meta: uiToolMeta(MESSAGE_RESOURCE_URI)
    },
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

  server.registerTool(
    "send_draft",
    {
      description: "Send a previously created draft.",
      inputSchema: { inbox_id: inboxId, draft_id: z.string() },
      _meta: uiToolMeta(MESSAGE_RESOURCE_URI)
    },
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

  server.tool(
    "send_batch",
    "Send up to 100 messages in one call. Each item is a send_message body; results come back per index.",
    {
      inbox_id: inboxId,
      messages: z
        .array(SendMessageInput)
        .min(1)
        .max(100)
        .describe("Send inputs, same shape as send_message minus inbox_id."),
      idempotency_key: z
        .string()
        .optional()
        .describe("Idempotency-Key header value; retries with the same key return the stored result.")
    },
    wrap(({ inbox_id, messages, idempotency_key }) =>
      api.request({
        method: "POST",
        path: `/v0/inboxes/${encodePath(inbox_id)}/messages/batch-send`,
        body: { messages },
        headers: idempotency_key === undefined ? undefined : { "Idempotency-Key": idempotency_key }
      })
    )
  );

  server.tool(
    "cancel_message",
    "Cancel a scheduled message (state must be 'scheduled').",
    { inbox_id: inboxId, message_id: messageId },
    wrap(({ inbox_id, message_id }) =>
      api.request({
        method: "POST",
        path: `/v0/inboxes/${encodePath(inbox_id)}/messages/${encodePath(message_id)}/cancel`
      })
    )
  );

  server.tool(
    "reschedule_message",
    "Change when a scheduled message sends.",
    {
      inbox_id: inboxId,
      message_id: messageId,
      send_at: z.string().describe("ISO-8601 timestamp for the new send time.")
    },
    wrap(({ inbox_id, message_id, send_at }) =>
      api.request({
        method: "PATCH",
        path: `/v0/inboxes/${encodePath(inbox_id)}/messages/${encodePath(message_id)}`,
        body: { send_at }
      })
    )
  );

  server.tool(
    "share_message",
    "Create a share link for a message.",
    { inbox_id: inboxId, message_id: messageId, ...ShareMessageInput.shape },
    wrap(({ inbox_id, message_id, ...body }) =>
      api.request({
        method: "POST",
        path: `/v0/inboxes/${encodePath(inbox_id)}/messages/${encodePath(message_id)}/share`,
        body
      })
    )
  );

  server.tool(
    "list_attachments",
    "List a message's attachments (metadata only; use get_attachment for a download URL).",
    { inbox_id: inboxId, message_id: messageId },
    wrap(({ inbox_id, message_id }) =>
      api.request({
        method: "GET",
        path: `/v0/inboxes/${encodePath(inbox_id)}/messages/${encodePath(message_id)}/attachments`
      })
    )
  );

  server.tool(
    "message_events",
    "Get the event timeline for one message (sent/delivered/opened/clicked/…).",
    { inbox_id: inboxId, message_id: messageId },
    wrap(({ inbox_id, message_id }) =>
      api.request({
        method: "GET",
        path: `/v0/inboxes/${encodePath(inbox_id)}/messages/${encodePath(message_id)}/events`
      })
    )
  );

  server.tool(
    "list_suppressions",
    "List suppressed recipient addresses (bounces, complaints, manual).",
    {
      ...pagination,
      reason: z
        .enum(["bounce", "complaint", "manual"])
        .optional()
        .describe("Filter by suppression reason.")
    },
    wrap((query) => api.request({ method: "GET", path: "/v0/suppressions", query }))
  );

  server.tool(
    "add_suppression",
    "Suppress an address manually; future sends to it are rejected.",
    CreateSuppressionInput.shape,
    wrap((body) => api.request({ method: "POST", path: "/v0/suppressions", body }))
  );

  server.tool(
    "remove_suppression",
    "Remove an address from the suppression list.",
    { address: z.string().email().describe("Suppressed address to remove.") },
    wrap(({ address }) =>
      api.request({ method: "DELETE", path: `/v0/suppressions/${encodePath(address)}` })
    )
  );

  server.tool(
    "batch_suppressions",
    "Add and/or remove many suppressions in one call.",
    {
      add: z.array(z.string().email()).max(100).optional(),
      remove: z.array(z.string().email()).max(100).optional()
    },
    wrap((body) => api.request({ method: "POST", path: "/v0/suppressions/batch", body }))
  );

  server.tool(
    "update_inbox",
    "Update an inbox's display name or open/click tracking toggles.",
    { inbox_id: inboxId, ...UpdateInboxInput.shape },
    wrap(({ inbox_id, ...body }) =>
      api.request({
        method: "PATCH",
        path: `/v0/inboxes/${encodePath(inbox_id)}`,
        body
      })
    )
  );

  server.tool(
    "update_domain",
    "Update a sending domain (e.g. custom_return_path).",
    {
      domain_id: z.string().describe("Domain id (dom_…) or domain name."),
      ...UpdateDomainInput.shape
    },
    wrap(({ domain_id, ...body }) =>
      api.request({
        method: "PATCH",
        path: `/v0/domains/${encodePath(domain_id)}`,
        body
      })
    )
  );

  server.tool(
    "rename_api_key",
    "Rename an API key.",
    {
      key_id: z.string().describe("API key id (key_…), from keys list/create."),
      name: z.string().nullable().optional().describe("New display name (null clears it).")
    },
    wrap(({ key_id, ...body }) =>
      api.request({
        method: "PATCH",
        path: `/v0/api-keys/${encodePath(key_id)}`,
        body
      })
    )
  );

  server.tool(
    "rotate_webhook_secret",
    "Rotate a webhook's signing secret. Returns the new secret once.",
    { webhook_id: z.string().describe("Webhook id (whk_…).") },
    wrap(({ webhook_id }) =>
      api.request({
        method: "POST",
        path: `/v0/webhooks/${encodePath(webhook_id)}/rotate-secret`
      })
    )
  );

  server.tool(
    "list_webhook_events",
    "List recent delivery events for one webhook.",
    { webhook_id: z.string().describe("Webhook id (whk_…)."), ...pagination },
    wrap(({ webhook_id, ...query }) =>
      api.request({
        method: "GET",
        path: `/v0/webhooks/${encodePath(webhook_id)}/events`,
        query
      })
    )
  );

  server.tool(
    "list_templates",
    "List email templates (draft and published).",
    { ...pagination },
    wrap((query) => api.request({ method: "GET", path: "/v0/templates", query }))
  );

  server.tool(
    "create_template",
    "Create a template. Reference it from send_message/create_draft via the template field.",
    CreateTemplateInput.shape,
    wrap((body) => api.request({ method: "POST", path: "/v0/templates", body }))
  );

  server.tool(
    "get_template",
    "Get one template by template_id.",
    { template_id: z.string().describe("Template id (tpl_…).") },
    wrap(({ template_id }) =>
      api.request({ method: "GET", path: `/v0/templates/${encodePath(template_id)}` })
    )
  );

  server.tool(
    "update_template",
    "Update a draft template's fields.",
    {
      template_id: z.string().describe("Template id (tpl_…)."),
      ...UpdateTemplateInput.shape
    },
    wrap(({ template_id, ...body }) =>
      api.request({
        method: "PATCH",
        path: `/v0/templates/${encodePath(template_id)}`,
        body
      })
    )
  );

  server.tool(
    "delete_template",
    "Delete a template.",
    { template_id: z.string().describe("Template id (tpl_…).") },
    wrap(({ template_id }) =>
      api.request({ method: "DELETE", path: `/v0/templates/${encodePath(template_id)}` })
    )
  );

  server.tool(
    "publish_template",
    "Publish a draft template so it can be used for sends.",
    { template_id: z.string().describe("Template id (tpl_…).") },
    wrap(({ template_id }) =>
      api.request({
        method: "POST",
        path: `/v0/templates/${encodePath(template_id)}/publish`
      })
    )
  );

  server.tool(
    "duplicate_template",
    "Copy a template into a new draft.",
    { template_id: z.string().describe("Template id (tpl_…).") },
    wrap(({ template_id }) =>
      api.request({
        method: "POST",
        path: `/v0/templates/${encodePath(template_id)}/duplicate`
      })
    )
  );
}
