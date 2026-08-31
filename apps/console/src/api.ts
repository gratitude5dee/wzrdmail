declare const __API_BASE__: string;

export const API_BASE = __API_BASE__;

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public errorName: string,
    message: string
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: { "content-type": "application/json", ...init.headers },
    ...init
  });
  const body = (await res.json().catch(() => null)) as
    | (T & { name?: string; message?: string })
    | null;
  if (!res.ok) {
    throw new ApiRequestError(
      res.status,
      body?.name ?? "internal_error",
      body?.message ?? `request failed (${res.status})`
    );
  }
  return body as T;
}

/** Follows `next_page_token` until the collection is exhausted. */
export async function apiAll<T>(path: string, key: string): Promise<T[]> {
  const sep = path.includes("?") ? "&" : "?";
  const items: T[] = [];
  const seen = new Set<string>();
  let token: string | undefined;
  for (;;) {
    const url = token ? `${path}${sep}page_token=${encodeURIComponent(token)}` : path;
    const res = await api<Record<string, T[]> & { next_page_token?: string }>(url);
    items.push(...(res[key] ?? []));
    token = res.next_page_token;
    if (!token || seen.has(token)) break;
    seen.add(token);
  }
  return items;
}

export interface Session {
  organization_id: string;
  name: string;
  plan: string;
  verified: boolean;
  email: string;
  created_at: string;
}

export interface Inbox {
  inbox_id: string;
  organization_id: string;
  pod_id: string;
  username: string;
  domain: string;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface Thread {
  thread_id: string;
  inbox_id: string;
  subject: string;
  preview: string;
  participants: string[];
  labels: string[];
  message_count: number;
  last_message_at: string;
  created_at: string;
  messages?: Message[];
}

export interface Attachment {
  attachment_id: string;
  filename: string;
  content_type: string;
  size: number;
}

export interface Message {
  message_id: string;
  inbox_id: string;
  thread_id: string;
  direction: string;
  state: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string | null;
  extracted_text: string | null;
  extracted_html: string | null;
  labels: string[];
  attachments: Attachment[];
  send_at: string | null;
  deleted_at: string | null;
  created_at: string;
}

export interface Draft {
  draft_id: string;
  inbox_id: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string | null;
  html: string | null;
  labels: string[];
  sent_message_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Webhook {
  webhook_id: string;
  url: string;
  inbox_id: string | null;
  enabled: boolean;
  event_types: string[];
  secret?: string;
  created_at: string;
}

export interface ApiKey {
  key_id: string;
  name: string | null;
  pod_id: string | null;
  key_preview: string;
  permissions: string[];
  last_used_at: string | null;
  created_at: string;
}

export interface UsageEntry {
  used: number;
  limit: number | null;
}

export interface Usage {
  plan: string;
  month: string;
  usage: Record<string, UsageEntry>;
}

export interface Metrics {
  period: string;
  since: string;
  totals: Record<string, number>;
  series: { bucket: string; type: string; count: number }[];
}
