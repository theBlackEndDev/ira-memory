-- Restore FTS columns dropped by 20260406165108. recall.ts / search.ts
-- still reference content_tsv via $queryRaw, so the runtime needs them back.

ALTER TABLE memory_facts
  ADD COLUMN IF NOT EXISTS content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX IF NOT EXISTS idx_memory_facts_content_tsv
  ON memory_facts USING gin(content_tsv);

CREATE INDEX IF NOT EXISTS idx_memory_facts_content_trgm
  ON memory_facts USING gin(content gin_trgm_ops);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX IF NOT EXISTS idx_messages_content_tsv
  ON messages USING gin(content_tsv);
