-- 0012_inbox_scoped_keys: API keys may be pinned to a single inbox (AgentMail
-- draft-only key parity), and webhooks may subscribe to a set of pods
-- (JSON array, empty = all pods).

ALTER TABLE api_keys ADD COLUMN inbox_id TEXT REFERENCES inboxes(inbox_id);
CREATE INDEX idx_api_keys_inbox ON api_keys(inbox_id) WHERE inbox_id IS NOT NULL;

ALTER TABLE webhooks ADD COLUMN pod_ids TEXT NOT NULL DEFAULT '[]';
