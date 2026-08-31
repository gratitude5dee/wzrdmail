-- Backfill direction labels on threads created before labels were maintained:
-- derive 'sent'/'received' from each thread's message directions.
UPDATE threads
SET labels = json_insert(labels, '$[#]', 'sent')
WHERE NOT EXISTS (SELECT 1 FROM json_each(threads.labels) WHERE value = 'sent')
  AND EXISTS (
    SELECT 1 FROM messages m
    WHERE m.thread_id = threads.thread_id AND m.direction = 'outbound'
  );

UPDATE threads
SET labels = json_insert(labels, '$[#]', 'received')
WHERE NOT EXISTS (SELECT 1 FROM json_each(threads.labels) WHERE value = 'received')
  AND EXISTS (
    SELECT 1 FROM messages m
    WHERE m.thread_id = threads.thread_id AND m.direction = 'inbound'
  );
