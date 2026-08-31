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
  created_at: IsoTimestamp,
  updated_at: IsoTimestamp
});
export type Inbox = z.infer<typeof Inbox>;

export const SendAttachmentInput = z.object({
  filename: z.string().min(1),
  content_type: z.string().min(1),
  content: z.string().min(1) // base64
});

export const SendMessageInput = z.object({
  to: z.array(z.string().email()).min(1),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().default(""),
  text: z.string().optional(),
  html: z.string().optional(),
  reply_to: z.string().email().optional(),
  headers: z.record(z.string()).optional(),
  attachments: z.array(SendAttachmentInput).optional(),
  labels: z.array(z.string()).optional(),
  client_id: z.string().max(256).optional()
});
export type SendMessageInput = z.infer<typeof SendMessageInput>;

export const CreateInboxInput = z.object({
  username: z.string().optional(),
  domain: z.string().optional(),
  display_name: z.string().optional(),
  client_id: z.string().max(256).optional()
});
export type CreateInboxInput = z.infer<typeof CreateInboxInput>;

export const AgentSignUpInput = z.object({
  human_email: z.string().email(),
  username: z.string()
});

export const AgentVerifyInput = z.object({
  otp_code: z.string().regex(/^\d{6}$/)
});

export const EventType = z.enum([
  "message.received",
  "message.sent",
  "message.delivered",
  "message.bounced",
  "message.complained",
  "message.rejected",
  "domain.verified"
]);
export type EventType = z.infer<typeof EventType>;

export const EventEnvelope = z.object({
  event_id: z.string(),
  type: EventType,
  created_at: IsoTimestamp,
  organization_id: z.string(),
  pod_id: z.string(),
  inbox_id: InboxId.optional(),
  data: z.record(z.unknown())
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;
