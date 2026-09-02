import { z } from "zod";
import { IsoTimestamp } from "@wzrdmail/core";

/** Pagination params accepted by every list endpoint (§7). */
export interface ListParams {
  limit?: number;
  page_token?: string;
}

export interface ListMessagesParams extends ListParams {
  labels?: string[];
  before?: string;
  after?: string;
}

/** Webhook subscription (§4, §7 — no core schema yet, defined here). */
export const Webhook = z.object({
  webhook_id: z.string(),
  url: z.string(),
  event_types: z.array(z.string()),
  enabled: z.boolean(),
  inbox_id: z.string().nullable().optional(),
  pod_id: z.string().nullable().optional(),
  secret: z.string().optional(),
  created_at: IsoTimestamp,
  updated_at: IsoTimestamp
});
export type Webhook = z.infer<typeof Webhook>;

export interface CreateWebhookInput {
  url: string;
  event_types: string[];
  inbox_id?: string;
  pod_id?: string;
  client_id?: string;
}

/** Sending/receiving domain (§4, §6.6 — no core schema yet, defined here). */
export const Domain = z.object({
  domain_id: z.string(),
  domain: z.string(),
  organization_id: z.string().nullable().optional(),
  status: z.string(),
  nameservers: z.array(z.string()).optional(),
  dns_records: z
    .array(
      z.object({
        type: z.string(),
        name: z.string(),
        value: z.string()
      })
    )
    .optional(),
  created_at: IsoTimestamp,
  updated_at: IsoTimestamp
});
export type Domain = z.infer<typeof Domain>;

export interface CreateDomainInput {
  domain: string;
  client_id?: string;
}

/** Unsent draft message (§7 Drafts — no core schema yet, defined here). */
export const Draft = z.object({
  draft_id: z.string(),
  inbox_id: z.string(),
  to: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.string().optional(),
  text: z.string().optional(),
  html: z.string().optional(),
  labels: z.array(z.string()).optional(),
  created_at: IsoTimestamp,
  updated_at: IsoTimestamp
});
export type Draft = z.infer<typeof Draft>;

export interface CreateDraftInput {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  labels?: string[];
  client_id?: string;
}

export interface ReplyMessageInput {
  text?: string;
  html?: string;
  cc?: string[];
  bcc?: string[];
  client_id?: string;
}

export interface ForwardMessageInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  text?: string;
  html?: string;
  client_id?: string;
}

export interface UpdateMessageInput {
  labels?: string[];
  read?: boolean;
}

/** Pod — namespace within an org for multi-tenant isolation (§4, §7). */
export const Pod = z.object({
  pod_id: z.string(),
  name: z.string().optional(),
  organization_id: z.string().optional(),
  created_at: IsoTimestamp
});
export type Pod = z.infer<typeof Pod>;

export interface CreatePodInput {
  name?: string;
  client_id?: string;
}

/** API key record (§7 — secret only present on create). */
export const ApiKey = z.object({
  api_key_id: z.string(),
  name: z.string().optional(),
  key: z.string().optional(),
  pod_id: z.string().nullable().optional(),
  inbox_id: z.string().nullable().optional(),
  permissions: z.array(z.string()).optional(),
  created_at: IsoTimestamp
});
export type ApiKey = z.infer<typeof ApiKey>;

export interface CreateApiKeyInput {
  name?: string;
  pod_id?: string;
  /** Pin the key to one inbox (implies that inbox's pod). */
  inbox_id?: string;
  /** Subset of the caller's permissions, e.g. ["read", "drafts"] for draft-only. */
  permissions?: string[];
  client_id?: string;
}

/** `GET /v0/auth/me` — the identity behind the presented key. */
export interface AuthMe {
  organization_id: string;
  pod_id?: string | null;
  api_key_id?: string;
  human_email?: string;
  verified?: boolean;
}

/** `POST /v0/webhooks/{webhook_id}/test` — fires a synthetic delivery (§10). */
export interface WebhookTestResult {
  webhook_id: string;
  delivered: boolean;
  status_code?: number;
  error?: string;
}

/** `GET /v0/metrics/usage` — month, per metric vs plan limit (§7). */
export interface UsageMetric {
  metric: string;
  used: number;
  limit?: number | null;
}

export interface Usage {
  month: string;
  metrics: UsageMetric[];
}

export interface AgentSignUpResponse {
  api_key: string;
  inbox_id: string;
  organization_id: string;
}

export interface AgentVerifyResponse {
  verified: boolean;
}

/** `{items…, "next_page_token"}` — items keyed by collection name (§7). */
export type ListResponse<K extends string, T> = {
  [key in K]: T[];
} & { next_page_token?: string };
