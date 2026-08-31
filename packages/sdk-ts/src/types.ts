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
