-- 0005_unique_human_email: one organization per human_email so concurrent
-- sign-ups cannot create duplicate accounts.

DROP INDEX idx_orgs_human_email;
CREATE UNIQUE INDEX idx_orgs_human_email ON organizations(human_email);
