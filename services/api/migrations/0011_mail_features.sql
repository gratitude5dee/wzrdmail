-- 0011_mail_features: drafts, scheduled send, and trash (soft delete).

CREATE TABLE drafts (
  draft_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  pod_id TEXT NOT NULL,
  inbox_id TEXT NOT NULL REFERENCES inboxes(inbox_id),
  thread_id TEXT,
  in_reply_to TEXT, -- rfc822 Message-ID this draft replies to
  to_addrs TEXT NOT NULL DEFAULT '[]',
  cc_addrs TEXT NOT NULL DEFAULT '[]',
  bcc_addrs TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  text TEXT,
  html TEXT,
  reply_to TEXT,
  headers TEXT NOT NULL DEFAULT '{}',
  labels TEXT NOT NULL DEFAULT '[]',
  client_id TEXT,
  sent_msg_id TEXT, -- set once the draft has been sent
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_drafts_inbox ON drafts(inbox_id, created_at);
CREATE INDEX idx_drafts_org ON drafts(org_id, created_at);

ALTER TABLE messages ADD COLUMN send_at TEXT;
ALTER TABLE messages ADD COLUMN deleted_at TEXT;
ALTER TABLE threads ADD COLUMN deleted_at TEXT;

CREATE INDEX idx_messages_scheduled ON messages(send_at) WHERE state = 'scheduled';
CREATE INDEX idx_messages_deleted ON messages(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_threads_deleted ON threads(deleted_at) WHERE deleted_at IS NOT NULL;
