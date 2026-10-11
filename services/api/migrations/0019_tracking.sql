-- Open/click tracking (resend-parity spec §3 P3, §4; goal.md V1.1 per-inbox flag).
-- Inbox flags gate egress injection; message counters feed badges and the
-- message.opened / message.clicked events.
ALTER TABLE inboxes ADD COLUMN x_open_tracking INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inboxes ADD COLUMN x_click_tracking INTEGER NOT NULL DEFAULT 0;

ALTER TABLE messages ADD COLUMN x_open_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN x_click_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN x_last_opened_at TEXT;
ALTER TABLE messages ADD COLUMN x_last_clicked_at TEXT;
