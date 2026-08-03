-- Allow multiple embedding rows per parent so long content can be chunked.
--
-- embed.ts truncated input at 8,000 characters, so anything past that never influenced its vector.
-- Measured on this store: 19 of 433 messages exceeded it, 142k characters unembedded, the longest
-- message embedded on its first 16%. Since assistant turns tend to back-load conclusions, the part
-- most worth recalling was the part being dropped.
--
-- Raising the cap alone was rejected: one vector for a long multi-topic document is a blurred
-- average, which is the same failure that let verbose rows win unrelated queries before FTS length
-- normalisation was added. Chunking keeps each vector locally coherent.
--
-- The unique constraint on the parent id is what enforced one-embedding-per-row; it becomes
-- unique(parent_id, chunk_index). ON CONFLICT clauses in embed.ts are updated to match.

ALTER TABLE message_embeddings
  ADD COLUMN IF NOT EXISTS chunk_index INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS chunk_total INT NOT NULL DEFAULT 1;

ALTER TABLE fact_embeddings
  ADD COLUMN IF NOT EXISTS chunk_index INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS chunk_total INT NOT NULL DEFAULT 1;

ALTER TABLE summary_embeddings
  ADD COLUMN IF NOT EXISTS chunk_index INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS chunk_total INT NOT NULL DEFAULT 1;

-- Prisma created these as unique INDEXes, not table constraints, so DROP CONSTRAINT silently
-- skips them and the one-embedding-per-parent rule would survive. Drop both forms.
ALTER TABLE message_embeddings DROP CONSTRAINT IF EXISTS message_embeddings_message_id_key;
ALTER TABLE fact_embeddings    DROP CONSTRAINT IF EXISTS fact_embeddings_fact_id_key;
ALTER TABLE summary_embeddings DROP CONSTRAINT IF EXISTS summary_embeddings_summary_id_key;
DROP INDEX IF EXISTS message_embeddings_message_id_key;
DROP INDEX IF EXISTS fact_embeddings_fact_id_key;
DROP INDEX IF EXISTS summary_embeddings_summary_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS message_embeddings_message_id_chunk_key
  ON message_embeddings (message_id, chunk_index);
CREATE UNIQUE INDEX IF NOT EXISTS fact_embeddings_fact_id_chunk_key
  ON fact_embeddings (fact_id, chunk_index);
CREATE UNIQUE INDEX IF NOT EXISTS summary_embeddings_summary_id_chunk_key
  ON summary_embeddings (summary_id, chunk_index);

-- Parent-id lookups were served by the unique constraints that just got dropped.
CREATE INDEX IF NOT EXISTS idx_message_embeddings_message_id ON message_embeddings (message_id);
CREATE INDEX IF NOT EXISTS idx_fact_embeddings_fact_id       ON fact_embeddings (fact_id);
CREATE INDEX IF NOT EXISTS idx_summary_embeddings_summary_id ON summary_embeddings (summary_id);
