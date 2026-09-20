import type { Permission } from "./tools.js";

/**
 * The OAuth scope vocabulary (muse.md §5.3).
 *
 * Three scopes, each mapping onto one permission the API already enforces.
 * `admin` is deliberately absent: creating inboxes, webhooks and domains from
 * a consumer agent is a blast radius this connector does not take. Anyone who
 * needs it mints a key in the console instead.
 */
export const SCOPES = ["mail:read", "mail:drafts", "mail:send"] as const;

export type Scope = (typeof SCOPES)[number];

const SCOPE_TO_PERMISSION: Record<Scope, Permission> = {
  "mail:read": "read",
  "mail:drafts": "drafts",
  "mail:send": "send"
};

/** Human-readable consent copy, in the order the consent page shows them. */
export const SCOPE_LABELS: Record<Scope, string> = {
  "mail:read": "Read your mail, threads, drafts and usage",
  "mail:drafts": "Write drafts (never sends them)",
  "mail:send": "Send, reply to and forward email from your inbox"
};

export const isScope = (value: string): value is Scope =>
  (SCOPES as readonly string[]).includes(value);

/** Reading is the floor: a connection that cannot read cannot do anything useful. */
export const REQUIRED_SCOPE: Scope = "mail:read";

/**
 * Turns granted scopes into the comma-separated `permissions` an api_keys row
 * carries. Order follows SCOPES so the stored value is stable.
 */
export const permissionsForScopes = (scopes: readonly string[]): Permission[] =>
  SCOPES.filter((scope) => scopes.includes(scope)).map((scope) => SCOPE_TO_PERMISSION[scope]);
