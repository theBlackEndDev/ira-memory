-- Restore the ANN indexes dropped by 20260406165108.
--
-- That migration dropped idx_fact_embeddings_vector, idx_message_embeddings_vector and
-- idx_summary_embeddings_vector alongside the FTS indexes. 20260508000000_restore_fts_columns
-- brought back only the FTS half, so every semantic recall has been running a sequential scan
-- over the full embedding table since 2026-04-06 — confirmed by EXPLAIN showing Seq Scan + Sort.
--
-- It went unnoticed because the corpus was tiny (18 facts). That changed: conversation logging
-- now writes two rows per turn and IraRecall queries on every prompt, so message_embeddings grows
-- without bound against an O(n) scan.
--
-- HNSW over IVFFlat: IVFFlat needs representative data present at build time to cluster well and
-- degrades when the table grows past what it was trained on. HNSW builds incrementally and needs
-- no training pass, which suits a store that grows a couple of rows at a time.
--
-- vector_cosine_ops matches the `<=>` operator used in search.ts.

CREATE INDEX IF NOT EXISTS idx_fact_embeddings_vector
  ON fact_embeddings USING hnsw (vector vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_message_embeddings_vector
  ON message_embeddings USING hnsw (vector vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_summary_embeddings_vector
  ON summary_embeddings USING hnsw (vector vector_cosine_ops);
