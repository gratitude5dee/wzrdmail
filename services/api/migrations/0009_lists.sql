-- Allow/block list entries (§4 list_entry): org-wide when inbox_id is NULL,
-- inbox-scoped otherwise. Pattern is an exact address or `@domain`.
CREATE TABLE list_entries (
  entry_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  inbox_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('allow', 'block')),
  pattern TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_list_entries_unique
  ON list_entries (org_id, COALESCE(inbox_id, ''), kind, pattern);

CREATE INDEX idx_list_entries_scope ON list_entries (org_id, inbox_id);
