-- 0016_templates: org-scoped transactional templates (R-MAIL-06).
-- Draft columns (subject/text/html/variables) stay editable; publishing
-- snapshots them into published_* so send-time output is immutable until the
-- next publish (Resend parity).

CREATE TABLE templates (
  template_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(org_id),
  name TEXT NOT NULL,
  alias TEXT, -- stable caller-facing name; unique per org, NULL allowed
  subject TEXT NOT NULL DEFAULT '',
  text TEXT,
  html TEXT,
  variables TEXT NOT NULL DEFAULT '[]', -- JSON: [{key, type, fallback_value?}]
  published_subject TEXT,
  published_text TEXT,
  published_html TEXT,
  published_variables TEXT,
  published_at TEXT,
  client_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_templates_org_alias
  ON templates(org_id, alias) WHERE alias IS NOT NULL;
CREATE INDEX idx_templates_org_created ON templates(org_id, created_at, template_id);
