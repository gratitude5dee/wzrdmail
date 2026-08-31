/** Row → AgentMail-shape JSON objects (field names per packages/core schemas). */

export interface MessageRow {
  msg_id: string;
  org_id: string;
  pod_id: string;
  inbox_id: string;
  thread_id: string;
  direction: string;
  state: string;
  from_addr: string;
  to_addrs: string;
  cc_addrs: string;
  bcc_addrs: string;
  subject: string;
  text: string | null;
  html: string | null;
  extracted_text: string | null;
  extracted_html: string | null;
  labels: string;
  rfc822_message_id: string | null;
  in_reply_to: string | null;
  send_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AttachmentRow {
  att_id: string;
  msg_id: string;
  filename: string;
  content_type: string;
  size: number;
  content_id: string | null;
}

export interface ThreadRow {
  thread_id: string;
  org_id: string;
  pod_id: string;
  inbox_id: string;
  subject: string;
  preview: string;
  participants: string;
  labels: string;
  message_count: number;
  deleted_at: string | null;
  last_message_at: string;
  created_at: string;
  updated_at: string;
}

export interface WebhookRow {
  webhook_id: string;
  org_id: string;
  inbox_id: string | null;
  url: string;
  secret: string;
  enabled: number;
  event_types: string;
  headers: string;
  client_id: string | null;
  created_at: string;
  updated_at: string;
}

function jsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

export function messageJson(
  row: MessageRow,
  attachments: AttachmentRow[]
): Record<string, unknown> {
  return {
    message_id: row.msg_id,
    inbox_id: row.inbox_id,
    thread_id: row.thread_id,
    organization_id: row.org_id,
    pod_id: row.pod_id,
    direction: row.direction,
    state: row.state,
    from: row.from_addr,
    to: jsonArray(row.to_addrs),
    cc: jsonArray(row.cc_addrs),
    bcc: jsonArray(row.bcc_addrs),
    subject: row.subject,
    text: row.text,
    html: row.html,
    extracted_text: row.extracted_text,
    extracted_html: row.extracted_html,
    labels: jsonArray(row.labels),
    attachments: attachments.map((a) => ({
      attachment_id: a.att_id,
      filename: a.filename,
      content_type: a.content_type,
      size: a.size,
      content_id: a.content_id
    })),
    in_reply_to: row.in_reply_to,
    rfc822_message_id: row.rfc822_message_id,
    send_at: row.send_at,
    deleted_at: row.deleted_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function threadJson(row: ThreadRow): Record<string, unknown> {
  return {
    thread_id: row.thread_id,
    inbox_id: row.inbox_id,
    organization_id: row.org_id,
    pod_id: row.pod_id,
    subject: row.subject,
    preview: row.preview,
    participants: jsonArray(row.participants),
    labels: jsonArray(row.labels),
    message_count: row.message_count,
    deleted_at: row.deleted_at,
    last_message_at: row.last_message_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export interface DraftRow {
  draft_id: string;
  org_id: string;
  pod_id: string;
  inbox_id: string;
  thread_id: string | null;
  in_reply_to: string | null;
  to_addrs: string;
  cc_addrs: string;
  bcc_addrs: string;
  subject: string;
  text: string | null;
  html: string | null;
  reply_to: string | null;
  headers: string;
  labels: string;
  client_id: string | null;
  sent_msg_id: string | null;
  created_at: string;
  updated_at: string;
}

function jsonRecord(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

export function draftJson(row: DraftRow): Record<string, unknown> {
  return {
    draft_id: row.draft_id,
    inbox_id: row.inbox_id,
    organization_id: row.org_id,
    pod_id: row.pod_id,
    thread_id: row.thread_id,
    to: jsonArray(row.to_addrs),
    cc: jsonArray(row.cc_addrs),
    bcc: jsonArray(row.bcc_addrs),
    subject: row.subject,
    text: row.text,
    html: row.html,
    reply_to: row.reply_to,
    headers: jsonRecord(row.headers),
    labels: jsonArray(row.labels),
    in_reply_to: row.in_reply_to,
    client_id: row.client_id,
    sent_message_id: row.sent_msg_id,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

/** The signing secret is only included on create (`includeSecret`). */
export function webhookJson(
  row: WebhookRow,
  options?: { includeSecret: boolean }
): Record<string, unknown> {
  return {
    webhook_id: row.webhook_id,
    organization_id: row.org_id,
    inbox_id: row.inbox_id,
    url: row.url,
    ...(options?.includeSecret ? { secret: row.secret } : {}),
    enabled: row.enabled === 1,
    event_types: jsonArray(row.event_types),
    client_id: row.client_id,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

/**
 * Merge label mutations: `labels` replaces; add/remove adjust the current set;
 * `read` maps to the presence of the `unread` label.
 */
export function applyLabelPatch(
  current: string[],
  patch: { labels?: string[]; add_labels?: string[]; remove_labels?: string[]; read?: boolean }
): string[] {
  let next = patch.labels ? [...patch.labels] : [...current];
  for (const l of patch.add_labels ?? []) {
    if (!next.includes(l)) next.push(l);
  }
  if (patch.remove_labels) {
    next = next.filter((l) => !patch.remove_labels?.includes(l));
  }
  if (patch.read === true) {
    next = next.filter((l) => l !== "unread");
  } else if (patch.read === false && !next.includes("unread")) {
    next.push("unread");
  }
  return next;
}
