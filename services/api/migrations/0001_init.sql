-- 0001_init: tenancy roots + inbox/message/thread core (§4).
-- Forward-only; never edit an applied migration.

CREATE TABLE organizations (
  org_id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL DEFAULT 'free',
  human_email TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  stripe_customer_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE pods (
  pod_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(org_id),
  name TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_pods_org ON pods(org_id);

CREATE TABLE api_keys (
  key_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(org_id),
  pod_id TEXT REFERENCES pods(pod_id),
  key_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT 'admin',
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX idx_api_keys_prefix ON api_keys(key_prefix);

CREATE TABLE domains (
  domain_id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES organizations(org_id), -- NULL = shared platform domain
  name TEXT NOT NULL UNIQUE,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE inboxes (
  inbox_id TEXT PRIMARY KEY, -- the address, e.g. scout@wzrd.tech
  org_id TEXT NOT NULL REFERENCES organizations(org_id),
  pod_id TEXT NOT NULL REFERENCES pods(pod_id),
  username TEXT NOT NULL,
  domain TEXT NOT NULL,
  display_name TEXT,
  client_id TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_inboxes_addr ON inboxes(username, domain);
CREATE INDEX idx_inboxes_org ON inboxes(org_id);

CREATE TABLE threads (
  thread_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  pod_id TEXT NOT NULL,
  inbox_id TEXT NOT NULL REFERENCES inboxes(inbox_id),
  subject TEXT NOT NULL DEFAULT '',
  normalized_subject TEXT NOT NULL DEFAULT '',
  preview TEXT NOT NULL DEFAULT '',
  participants TEXT NOT NULL DEFAULT '[]', -- JSON array
  labels TEXT NOT NULL DEFAULT '[]',
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_threads_inbox ON threads(inbox_id, last_message_at);

CREATE TABLE messages (
  msg_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  pod_id TEXT NOT NULL,
  inbox_id TEXT NOT NULL REFERENCES inboxes(inbox_id),
  thread_id TEXT NOT NULL REFERENCES threads(thread_id),
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  state TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  to_addrs TEXT NOT NULL DEFAULT '[]',
  cc_addrs TEXT NOT NULL DEFAULT '[]',
  bcc_addrs TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  text TEXT,
  html TEXT,
  extracted_text TEXT,
  extracted_html TEXT,
  body_truncated INTEGER NOT NULL DEFAULT 0,
  labels TEXT NOT NULL DEFAULT '[]',
  rfc822_message_id TEXT,
  in_reply_to TEXT,
  client_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_messages_inbox ON messages(inbox_id, created_at);
CREATE INDEX idx_messages_thread ON messages(thread_id, created_at);

CREATE TABLE message_id_lookup (
  inbox_id TEXT NOT NULL,
  rfc822_message_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  PRIMARY KEY (inbox_id, rfc822_message_id)
);

CREATE TABLE attachments (
  att_id TEXT PRIMARY KEY,
  msg_id TEXT NOT NULL REFERENCES messages(msg_id),
  inbox_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_attachments_msg ON attachments(msg_id);

CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  org_id TEXT NOT NULL,
  pod_id TEXT NOT NULL,
  inbox_id TEXT,
  payload TEXT NOT NULL, -- full event envelope JSON
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_org ON events(org_id, created_at);

CREATE TABLE usage_counters (
  org_id TEXT NOT NULL,
  month TEXT NOT NULL, -- YYYY-MM
  metric TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, month, metric)
);

CREATE TABLE idempotency_keys (
  org_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  client_id TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, resource_type, client_id)
);

CREATE TABLE suppressions (
  org_id TEXT, -- NULL = platform-level
  address TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('bounce','complaint','manual')),
  source_msg_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, address)
);
