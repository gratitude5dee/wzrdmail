-- 0004_m2_api: OTP codes for agent verify + webhook subscriptions (§4, §7, §8).

CREATE TABLE otp_codes (
  org_id TEXT NOT NULL REFERENCES organizations(org_id),
  purpose TEXT NOT NULL CHECK (purpose IN ('agent_verify','console_login')),
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, purpose)
);

CREATE TABLE webhooks (
  webhook_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(org_id),
  inbox_id TEXT REFERENCES inboxes(inbox_id), -- NULL = org-wide
  url TEXT NOT NULL,
  secret TEXT NOT NULL, -- whsec_…
  enabled INTEGER NOT NULL DEFAULT 1,
  event_types TEXT NOT NULL DEFAULT '[]', -- JSON array; [] = all
  headers TEXT NOT NULL DEFAULT '{}', -- JSON object of custom headers
  client_id TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_webhooks_org ON webhooks(org_id, created_at);

CREATE INDEX idx_threads_org ON threads(org_id, last_message_at);
CREATE INDEX idx_orgs_human_email ON organizations(human_email);
