-- 0014_pods_client_id_live_only: the (org_id, client_id) uniqueness for pods
-- only applies to live pods, so a client_id can be reused after its pod is
-- soft-deleted.

DROP INDEX idx_pods_org_client;
CREATE UNIQUE INDEX idx_pods_org_client ON pods(org_id, client_id)
  WHERE client_id IS NOT NULL AND deleted_at IS NULL;
