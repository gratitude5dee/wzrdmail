-- 0006_console: console login sessions + named API keys (goal-console.md §1, §3.7).

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL REFERENCES organizations(org_id),
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_org ON sessions(org_id);

ALTER TABLE api_keys ADD COLUMN name TEXT;
