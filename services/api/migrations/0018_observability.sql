-- 0016_observability: per-message event timeline, share links, domain
-- custom return path (R-MAIL-03).

ALTER TABLE events ADD COLUMN msg_id TEXT;
CREATE INDEX idx_events_msg ON events(msg_id);

-- Public share links: an immutable, sanitized snapshot of a message body
-- minted by POST .../messages/:msg_id/share and served unauthenticated at
-- GET /v0/share/:share_id until expires_at.
CREATE TABLE share_links (
  share_id TEXT PRIMARY KEY,
  msg_id TEXT NOT NULL REFERENCES messages(msg_id),
  org_id TEXT NOT NULL REFERENCES organizations(org_id),
  html_snapshot TEXT,
  text_snapshot TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_share_links_msg ON share_links(msg_id);

ALTER TABLE domains ADD COLUMN custom_return_path TEXT;
