-- 0015_connect_login: third OTP purpose for the MCP OAuth consent flow (muse.md §5);
-- api_keys provenance so the console can list "Connected apps".
CREATE TABLE otp_codes_new (
  org_id     TEXT NOT NULL REFERENCES organizations(org_id),
  purpose    TEXT NOT NULL CHECK (purpose IN ('agent_verify','console_login','connect_login')),
  code_hash  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, purpose)
);
INSERT INTO otp_codes_new (org_id, purpose, code_hash, attempts, expires_at, created_at)
  SELECT org_id, purpose, code_hash, attempts, expires_at, created_at FROM otp_codes;
DROP TABLE otp_codes;
ALTER TABLE otp_codes_new RENAME TO otp_codes;

-- source: console | agent | oauth
ALTER TABLE api_keys ADD COLUMN source TEXT NOT NULL DEFAULT 'console';
-- client_id: the OAuth client_id when source='oauth'
ALTER TABLE api_keys ADD COLUMN client_id TEXT;
