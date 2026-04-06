-- Add FTS columns (generated stored columns)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
CREATE INDEX IF NOT EXISTS idx_messages_content_tsv ON messages USING gin(content_tsv);

ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
CREATE INDEX IF NOT EXISTS idx_memory_facts_content_tsv ON memory_facts USING gin(content_tsv);

CREATE INDEX IF NOT EXISTS idx_memory_facts_content_trgm ON memory_facts
  USING gin(content gin_trgm_ops);

-- Add parent_session_id for cross-session threading
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS parent_session_id TEXT;

-- HNSW vector indexes for semantic search
CREATE INDEX IF NOT EXISTS idx_message_embeddings_vector ON message_embeddings
  USING hnsw (vector vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS idx_fact_embeddings_vector ON fact_embeddings
  USING hnsw (vector vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS idx_summary_embeddings_vector ON summary_embeddings
  USING hnsw (vector vector_cosine_ops) WITH (m = 16, ef_construction = 64);
