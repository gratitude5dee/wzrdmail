-- Webhook delivery log (§8.2 observability): one row per delivery attempt.
-- status: pending (scheduled / in flight) | success | failed.
-- next_retry_at doubles as the due time for pending rows and the claim lease.
CREATE TABLE webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhooks(webhook_id),
  org_id TEXT NOT NULL REFERENCES organizations(org_id),
  event_id TEXT NOT NULL REFERENCES events(event_id),
  event_type TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  manual INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
  response_status INTEGER,
  error TEXT, -- short summary only; never response bodies
  duration_ms INTEGER,
  next_retry_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id, created_at, delivery_id);
CREATE INDEX idx_webhook_deliveries_due ON webhook_deliveries(status, next_retry_at);
