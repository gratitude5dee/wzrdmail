-- 0013_pods_client_id: pods get an optional caller-chosen client_id (AgentMail
-- parity: client_id = tenant id is both the idempotency key and the mapping)
-- and soft deletion.

ALTER TABLE pods ADD COLUMN client_id TEXT;
ALTER TABLE pods ADD COLUMN deleted_at TEXT;
CREATE UNIQUE INDEX idx_pods_org_client ON pods(org_id, client_id) WHERE client_id IS NOT NULL;
