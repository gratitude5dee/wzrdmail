ALTER TABLE idempotency_keys ADD COLUMN owner TEXT NOT NULL DEFAULT '';
ALTER TABLE message_id_lookup ADD COLUMN committed INTEGER NOT NULL DEFAULT 1;
ALTER TABLE message_id_lookup ADD COLUMN claimed_at TEXT;
