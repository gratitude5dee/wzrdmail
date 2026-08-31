-- 0002_message_raw_key: persist the R2 key of each message's raw MIME so
-- stored mail is retrievable (§4 schema rules).

ALTER TABLE messages ADD COLUMN raw_key TEXT;
