-- 049: per-node embeddings for semantic search (pgvector).
--
-- The `vector` extension already exists (001_baseline) and the base image is
-- pgvector/pgvector. This adds the storage + ANN index that docs 07/08/10
-- flagged as the missing piece — the read-path that turns Onden's agent from an
-- "actuator with audit" into one that can surface non-obvious connections.
--
-- One embedding per node BODY (title + markdown). Sub-document chunking (Reor
-- style) is a later refinement. `content_hash` lets the embed job skip
-- re-embedding an unchanged body; `model` records which embedder produced the
-- vector so a model/dimension change is detectable. Dim 384 = the small local
-- sentence-transformer class (all-MiniLM-L6-v2 / bge-small / gte-small).
--
-- Embeddings are a DERIVED projection of content_nodes (computed off the
-- transactional outbox), so ON DELETE CASCADE is correct — drop the node, drop
-- its embedding.

CREATE TABLE IF NOT EXISTS node_embeddings (
  node_id      uuid PRIMARY KEY REFERENCES content_nodes(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  model        text NOT NULL,
  content_hash text NOT NULL,
  embedding    vector(384) NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- HNSW for cosine ANN — incremental (no training step, unlike ivfflat), which
-- fits the outbox-driven trickle of embeddings.
CREATE INDEX IF NOT EXISTS node_embeddings_hnsw
  ON node_embeddings USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS node_embeddings_ws ON node_embeddings (workspace_id);
