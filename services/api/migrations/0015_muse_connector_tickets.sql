-- Single-use, short-lived server-to-server handoff from the WZRDMail
-- Thirdweb console to Air × Muse. Raw browser codes are never persisted.
CREATE TABLE muse_connector_tickets (
  code_hash TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  redeemed_at TEXT
);

CREATE INDEX idx_muse_connector_tickets_expiry
  ON muse_connector_tickets (expires_at);
