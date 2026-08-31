-- Custom domains (§6.6): verification state machine + ownership token.
ALTER TABLE domains ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'; -- pending | verified | failed
ALTER TABLE domains ADD COLUMN verification_token TEXT;
UPDATE domains SET verification_token = lower(hex(randomblob(16)));
ALTER TABLE domains ADD COLUMN verified_at TEXT;
ALTER TABLE domains ADD COLUMN last_checked_at TEXT;
ALTER TABLE domains ADD COLUMN failure_reason TEXT;

UPDATE domains SET status = 'verified' WHERE verified = 1;

CREATE INDEX idx_domains_org ON domains(org_id);
