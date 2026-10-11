import { z } from "zod";

/**
 * Zod schemas are the single source of field truth shared by the API, MCP,
 * CLI, and SDKs (§7). Field casing mirrors AgentMail v0 (snake_case).
 */

export const IsoTimestamp = z.string().datetime({ offset: true });

export const InboxId = z.string().email();

export const Pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  page_token: z.string().optional()
});
export type Pagination = z.infer<typeof Pagination>;

export const MessageDirection = z.enum(["inbound", "outbound"]);

export const MessageState = z.enum([
  "received",
  "queued",
  "scheduled",
  "cancelled",
  "sent",
  "delivered",
  "bounced",
  "complained",
  "rejected",
  "failed"
]);

export const Attachment = z.object({
  attachment_id: z.string(),
  filename: z.string(),
  content_type: z.string(),
  size: z.number().int().nonnegative(),
  content_id: z.string().nullable().optional()
});
export type Attachment = z.infer<typeof Attachment>;

export const Message = z.object({
  message_id: z.string(),
  inbox_id: InboxId,
  thread_id: z.string(),
  organization_id: z.string(),
  pod_id: z.string(),
  direction: MessageDirection,
  state: MessageState,
  from: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()).default([]),
  bcc: z.array(z.string()).default([]),
  subject: z.string().default(""),
  text: z.string().nullable().optional(),
  html: z.string().nullable().optional(),
  extracted_text: z.string().nullable().optional(),
  extracted_html: z.string().nullable().optional(),
  labels: z.array(z.string()).default([]),
  attachments: z.array(Attachment).default([]),
  in_reply_to: z.string().nullable().optional(),
  rfc822_message_id: z.string().nullable().optional(),
  send_at: IsoTimestamp.nullable().optional(),
  deleted_at: IsoTimestamp.nullable().optional(),
  x_open_count: z.number().int().nonnegative().default(0),
  x_click_count: z.number().int().nonnegative().default(0),
  x_last_opened_at: IsoTimestamp.nullable().optional(),
  x_last_clicked_at: IsoTimestamp.nullable().optional(),
  created_at: IsoTimestamp,
  updated_at: IsoTimestamp
});
export type Message = z.infer<typeof Message>;

export const Thread = z.object({
  thread_id: z.string(),
  inbox_id: InboxId,
  organization_id: z.string(),
  pod_id: z.string(),
  subject: z.string(),
  preview: z.string().default(""),
  participants: z.array(z.string()).default([]),
  labels: z.array(z.string()).default([]),
  message_count: z.number().int().nonnegative(),
  deleted_at: IsoTimestamp.nullable().optional(),
  last_message_at: IsoTimestamp,
  created_at: IsoTimestamp,
  updated_at: IsoTimestamp
});
export type Thread = z.infer<typeof Thread>;

export const Inbox = z.object({
  inbox_id: InboxId,
  organization_id: z.string(),
  pod_id: z.string(),
  username: z.string(),
  domain: z.string(),
  display_name: z.string().nullable().optional(),
  client_id: z.string().nullable().optional(),
  x_open_tracking: z.boolean().default(false),
  x_click_tracking: z.boolean().default(false),
  created_at: IsoTimestamp,
  updated_at: IsoTimestamp
});
export type Inbox = z.infer<typeof Inbox>;

export const SendAttachmentInput = z
  .object({
    filename: z.string().min(1),
    content_type: z.string().min(1),
    content: z.string().min(1).optional(), // base64
    /** Hosted URL the API fetches server-side instead of inline content. */
    path: z.string().url().optional(),
    /** MIME Content-ID for inline images referenced from html as `cid:<id>`. */
    content_id: z.string().min(1).max(256).optional()
  })
  .refine((a) => (a.content === undefined) !== (a.path === undefined), {
    message: "provide exactly one of content or path"
  });
export type SendAttachmentInput = z.infer<typeof SendAttachmentInput>;

/** `Name <a@b>` or bare address; arrays join into one Reply-To header. */
export const ReplyTo = z.union([
  z.string().email(),
  z.array(z.string().email()).min(1).max(50)
]);
export type ReplyTo = z.infer<typeof ReplyTo>;

/** Resend-style template reference on a send: body comes from the template.
 * `id` accepts a template_id or org-unique alias. */
export const SendTemplateInput = z.object({
  id: z.string().min(1),
  variables: z.record(z.unknown()).optional()
});
export type SendTemplateInput = z.infer<typeof SendTemplateInput>;
export const TemplateSendRef = SendTemplateInput;
export type TemplateSendRef = SendTemplateInput;

export const SendMessageInput = z.object({
  to: z.array(z.string().email()).min(1),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().default(""),
  text: z.string().optional(),
  html: z.string().optional(),
  reply_to: ReplyTo.optional(),
  headers: z.record(z.string()).optional(),
  attachments: z.array(SendAttachmentInput).optional(),
  labels: z.array(z.string()).optional(),
  /** Render a published org template server-side (mutually exclusive with text/html — enforced at send). */
  template: SendTemplateInput.optional(),
  client_id: z.string().max(256).optional(),
  send_at: IsoTimestamp.optional()
});
export type SendMessageInput = z.infer<typeof SendMessageInput>;

export const BatchSendInput = z.object({
  messages: z.array(SendMessageInput).min(1).max(100)
});
export type BatchSendInput = z.infer<typeof BatchSendInput>;

export const UpdateApiKeyInput = z.object({
  name: z.string().min(1).max(80).nullable().optional()
});
export type UpdateApiKeyInput = z.infer<typeof UpdateApiKeyInput>;

/** A template variable declaration (Resend parity). */
export const TemplateStatus = z.enum(["draft", "published"]);
export type TemplateStatus = z.infer<typeof TemplateStatus>;

export const TemplateVariable = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "must be a valid identifier"),
  type: z.enum(["string", "number", "boolean", "object", "list"]).default("string"),
  /** Used when the caller omits the variable at send time; absent = required. */
  fallback_value: z.unknown().optional()
});
export type TemplateVariable = z.infer<typeof TemplateVariable>;

/** Fields that are snapshotted at publish time and rendered at send time. */
export const TemplateBody = z.object({
  subject: z.string().default(""),
  text: z.string().nullable(),
  html: z.string().nullable(),
  variables: z.array(TemplateVariable).default([])
});
export type TemplateBody = z.infer<typeof TemplateBody>;

export const Template = z.object({
  template_id: z.string(),
  organization_id: z.string(),
  name: z.string(),
  alias: z.string().nullable(),
  subject: z.string().default(""),
  text: z.string().nullable(),
  html: z.string().nullable(),
  variables: z.array(TemplateVariable).default([]),
  status: TemplateStatus,
  /** Immutable snapshot rendered at send time; null until first publish. */
  published: TemplateBody.nullable(),
  published_at: IsoTimestamp.nullable(),
  client_id: z.string().nullable(),
  created_at: IsoTimestamp,
  updated_at: IsoTimestamp
});
export type Template = z.infer<typeof Template>;

export const TEMPLATE_ALIAS_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;

export const CreateTemplateInput = z.object({
  name: z.string().min(1).max(200),
  alias: z.string().regex(TEMPLATE_ALIAS_RE, "lowercase letters, digits, - and _ only").optional(),
  subject: z.string().max(998).default(""),
  text: z.string().nullable().optional(),
  html: z.string().nullable().optional(),
  variables: z.array(TemplateVariable).max(100).optional(),
  client_id: z.string().max(256).optional()
});
export type CreateTemplateInput = z.infer<typeof CreateTemplateInput>;

export const UpdateTemplateInput = z.object({
  name: z.string().min(1).max(200).optional(),
  alias: z
    .string()
    .regex(TEMPLATE_ALIAS_RE, "lowercase letters, digits, - and _ only")
    .nullable()
    .optional(),
  subject: z.string().max(998).optional(),
  text: z.string().nullable().optional(),
  html: z.string().nullable().optional(),
  variables: z.array(TemplateVariable).max(100).optional()
});
export type UpdateTemplateInput = z.infer<typeof UpdateTemplateInput>;

export const CreatePodInput = z.object({
  name: z.string().min(1).max(128).optional(),
  client_id: z.string().max(256).optional()
});
export type CreatePodInput = z.infer<typeof CreatePodInput>;

export const CreateInboxInput = z.object({
  username: z.string().optional(),
  domain: z.string().optional(),
  display_name: z.string().optional(),
  /** Place the inbox in a specific pod (defaults to the key's pod or the org's first pod). */
  pod_id: z.string().optional(),
  client_id: z.string().max(256).optional()
});
export type CreateInboxInput = z.infer<typeof CreateInboxInput>;

/** RFC 1035 hostname: dot-separated labels, no leading/trailing hyphen, alpha TLD. */
export const DOMAIN_NAME_RE =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const DomainStatus = z.enum(["pending", "verified", "failed"]);
export type DomainStatus = z.infer<typeof DomainStatus>;

/** Canonical form for domain names: trimmed, lowercased, no trailing root dot. */
export function normalizeDomainName(v: string): string {
  return v.trim().toLowerCase().replace(/\.$/, "");
}

export const CreateDomainInput = z.object({
  domain: z
    .string()
    .min(1)
    .max(253)
    .transform(normalizeDomainName)
    .refine((v) => DOMAIN_NAME_RE.test(v), { message: "must be a valid domain name" }),
  client_id: z.string().max(256).optional()
});
export type CreateDomainInput = z.infer<typeof CreateDomainInput>;

export const AgentSignUpInput = z.object({
  human_email: z.string().email(),
  username: z.string()
});

export const AgentVerifyInput = z.object({
  otp_code: z.string().regex(/^\d{6}$/)
});

export const ReplyMessageInput = z.object({
  to: z.array(z.string().email()).optional(),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  text: z.string().optional(),
  html: z.string().optional(),
  reply_to: ReplyTo.optional(),
  headers: z.record(z.string()).optional(),
  attachments: z.array(SendAttachmentInput).optional(),
  labels: z.array(z.string()).optional(),
  client_id: z.string().max(256).optional(),
  send_at: IsoTimestamp.optional()
});
export type ReplyMessageInput = z.infer<typeof ReplyMessageInput>;

export const ForwardMessageInput = ReplyMessageInput.extend({
  to: z.array(z.string().email()).min(1)
});
export type ForwardMessageInput = z.infer<typeof ForwardMessageInput>;

export const UpdateInboxInput = z.object({
  display_name: z.string().max(256).nullable().optional(),
  x_open_tracking: z.boolean().optional(),
  x_click_tracking: z.boolean().optional()
});
export type UpdateInboxInput = z.infer<typeof UpdateInboxInput>;

export const UpdateMessageInput = z.object({
  labels: z.array(z.string()).optional(),
  add_labels: z.array(z.string()).optional(),
  remove_labels: z.array(z.string()).optional(),
  read: z.boolean().optional(),
  /** Reschedule: only valid while state is `scheduled` or `cancelled`. */
  send_at: IsoTimestamp.optional()
});
export type UpdateMessageInput = z.infer<typeof UpdateMessageInput>;

export const UpdateThreadInput = z.object({
  labels: z.array(z.string()).optional(),
  add_labels: z.array(z.string()).optional(),
  remove_labels: z.array(z.string()).optional()
});
export type UpdateThreadInput = z.infer<typeof UpdateThreadInput>;

export const Draft = z.object({
  draft_id: z.string(),
  inbox_id: InboxId,
  organization_id: z.string(),
  pod_id: z.string(),
  to: z.array(z.string()).default([]),
  cc: z.array(z.string()).default([]),
  bcc: z.array(z.string()).default([]),
  subject: z.string().default(""),
  text: z.string().nullable().optional(),
  html: z.string().nullable().optional(),
  reply_to: z.string().nullable().optional(),
  headers: z.record(z.string()).default({}),
  labels: z.array(z.string()).default([]),
  in_reply_to: z.string().nullable().optional(),
  client_id: z.string().nullable().optional(),
  sent_message_id: z.string().nullable().optional(),
  created_at: IsoTimestamp,
  updated_at: IsoTimestamp
});
export type Draft = z.infer<typeof Draft>;

export const CreateDraftInput = z.object({
  to: z.array(z.string().email()).optional(),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().max(998).optional(),
  text: z.string().optional(),
  html: z.string().optional(),
  reply_to: ReplyTo.optional(),
  headers: z.record(z.string()).optional(),
  labels: z.array(z.string()).optional(),
  in_reply_to: z.string().optional(),
  client_id: z.string().max(256).optional()
});
export type CreateDraftInput = z.infer<typeof CreateDraftInput>;

export const UpdateDraftInput = z.object({
  to: z.array(z.string().email()).optional(),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().max(998).optional(),
  text: z.string().nullable().optional(),
  html: z.string().nullable().optional(),
  reply_to: z.string().email().nullable().optional(),
  headers: z.record(z.string()).optional(),
  labels: z.array(z.string()).optional(),
  in_reply_to: z.string().nullable().optional()
});
export type UpdateDraftInput = z.infer<typeof UpdateDraftInput>;

export const SendDraftInput = z.object({
  send_at: IsoTimestamp.optional()
});
export type SendDraftInput = z.infer<typeof SendDraftInput>;

export const BatchGetMessagesInput = z.object({
  message_ids: z.array(z.string()).min(1).max(100)
});
export type BatchGetMessagesInput = z.infer<typeof BatchGetMessagesInput>;

export const BatchUpdateMessagesInput = z.object({
  message_ids: z.array(z.string()).min(1).max(100),
  add_labels: z.array(z.string()).optional(),
  remove_labels: z.array(z.string()).optional(),
  read: z.boolean().optional()
});
export type BatchUpdateMessagesInput = z.infer<typeof BatchUpdateMessagesInput>;

export const Webhook = z.object({
  webhook_id: z.string(),
  organization_id: z.string(),
  inbox_id: InboxId.nullable().optional(),
  pod_ids: z.array(z.string()).optional(),
  url: z.string().url(),
  secret: z.string().optional(),
  enabled: z.boolean(),
  event_types: z.array(z.string()),
  client_id: z.string().nullable().optional(),
  created_at: IsoTimestamp,
  updated_at: IsoTimestamp
});
export type Webhook = z.infer<typeof Webhook>;

export const CreateWebhookInput = z.object({
  url: z.string().url(),
  event_types: z.array(z.string()).optional(),
  inbox_id: z.string().email().optional(),
  /** Restrict delivery to events from these pods (AgentMail parity); omit for all. */
  pod_ids: z.array(z.string().startsWith("pod_")).max(100).optional(),
  enabled: z.boolean().optional(),
  client_id: z.string().max(256).optional()
});
export type CreateWebhookInput = z.infer<typeof CreateWebhookInput>;

export const UpdateWebhookInput = z.object({
  url: z.string().url().optional(),
  event_types: z.array(z.string()).optional(),
  pod_ids: z.array(z.string()).optional(),
  enabled: z.boolean().optional()
});
export type UpdateWebhookInput = z.infer<typeof UpdateWebhookInput>;

export const WebhookHeadersInput = z.record(z.string());

/** Exact address (`ada@example.com`) or whole domain (`@example.com`). */
export const ListPattern = z
  .string()
  .trim()
  .toLowerCase()
  .refine(
    (p) =>
      /^@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(p) ||
      z.string().email().safeParse(p).success,
    { message: "pattern must be an email address or @domain" }
  );

export const ListKind = z.enum(["allow", "block"]);
export type ListKind = z.infer<typeof ListKind>;

export const ListEntry = z.object({
  entry_id: z.string(),
  organization_id: z.string(),
  inbox_id: InboxId.nullable().optional(),
  kind: ListKind,
  pattern: z.string(),
  created_at: IsoTimestamp
});
export type ListEntry = z.infer<typeof ListEntry>;

export const CreateListEntryInput = z.object({
  kind: ListKind,
  pattern: ListPattern,
  inbox_id: z.string().email().optional(),
  client_id: z.string().max(256).optional()
});
export type CreateListEntryInput = z.infer<typeof CreateListEntryInput>;

export const EventType = z.enum([
  "message.received",
  "message.sent",
  "message.delivered",
  "message.bounced",
  "message.complained",
  "message.rejected",
  "message.scheduled",
  "message.cancelled",
  "message.failed",
  "message.opened",
  "message.clicked",
  "domain.verified",
  "domain.created",
  "domain.deleted",
  "domain.failed",
  "suppression.added",
  "suppression.removed"
]);
export type EventType = z.infer<typeof EventType>;

export const EventEnvelope = z.object({
  event_id: z.string(),
  type: EventType,
  created_at: IsoTimestamp,
  organization_id: z.string(),
  pod_id: z.string(),
  inbox_id: InboxId.optional(),
  /** Set on events that concern one message (indexed on events.msg_id). */
  msg_id: z.string().optional(),
  data: z.record(z.unknown())
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

/** Per-message event timeline entry — same shape as the stored envelope. */
export const MessageEvent = EventEnvelope;
export type MessageEvent = z.infer<typeof MessageEvent>;

export const SuppressionReason = z.enum(["bounce", "complaint", "manual"]);
export type SuppressionReason = z.infer<typeof SuppressionReason>;

export const Suppression = z.object({
  address: z.string().email(),
  reason: SuppressionReason,
  source_msg_id: z.string().nullable().optional(),
  created_at: IsoTimestamp
});
export type Suppression = z.infer<typeof Suppression>;

export const CreateSuppressionInput = z.object({
  address: z.string().email().transform((v) => v.toLowerCase()),
  client_id: z.string().max(256).optional()
});
export type CreateSuppressionInput = z.infer<typeof CreateSuppressionInput>;

export const BatchSuppressionInput = z
  .object({
    add: z.array(z.string().email().transform((v) => v.toLowerCase())).max(100).optional(),
    remove: z.array(z.string().email().transform((v) => v.toLowerCase())).max(100).optional()
  })
  .refine((v) => (v.add?.length ?? 0) + (v.remove?.length ?? 0) > 0, {
    message: "at least one of add or remove is required"
  });
export type BatchSuppressionInput = z.infer<typeof BatchSuppressionInput>;

export const UpdateDomainInput = z.object({
  /** Custom bounce (Return-Path) domain for this sending domain; null clears. */
  custom_return_path: z
    .string()
    .min(1)
    .max(253)
    .transform(normalizeDomainName)
    .refine((v) => DOMAIN_NAME_RE.test(v), { message: "must be a valid domain name" })
    .nullable()
    .optional(),
  client_id: z.string().max(256).optional()
});
export type UpdateDomainInput = z.infer<typeof UpdateDomainInput>;

export const SHARE_TTL_MAX_SECONDS = 7 * 24 * 60 * 60;

export const ShareMessageInput = z.object({
  /** Seconds until the public link stops serving (default 86400, max 7 days). */
  expires_in: z.coerce.number().int().min(1).max(SHARE_TTL_MAX_SECONDS).default(86400)
});
export type ShareMessageInput = z.infer<typeof ShareMessageInput>;

export const ShareLink = z.object({
  share_id: z.string(),
  share_url: z.string().url(),
  message_id: z.string(),
  expires_at: IsoTimestamp,
  created_at: IsoTimestamp
});
export type ShareLink = z.infer<typeof ShareLink>;
