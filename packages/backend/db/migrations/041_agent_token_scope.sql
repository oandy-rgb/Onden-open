-- B Day 1: agent_tokens scope columns.
--
-- Thesis: AI is a primary co-user (project_onden_thesis claim #3). The token
-- substrate must let admins mint narrowly-scoped tokens — per-tool allowlist,
-- per-tag write surface, expiry, explicit revocation. Differentiation vs
-- Blinko's all-or-nothing MCP (see project_blinko_and_learndata).
--
-- Semantics:
--   allowed_tools     NULL = unrestricted; '{}' = nothing allowed; array = whitelist
--   allowed_tag_ids   NULL = unrestricted; '{}' = nothing tag-scoped writeable; array = whitelist
--                     (entries reference content_nodes(id) WHERE node_type='class_tag'
--                      after A1 tag-as-node convergence — no FK because PG can't
--                      enforce filtered-FK; app-layer validation on mint)
--   expires_at        NULL = never expires
--   revoked_at        NULL = active; set on revocation
--
-- Backward compat: all NULL defaults → existing tokens behave as before.
-- Resolver update (filtering on revoked_at + expires_at) lands in Day 2.

ALTER TABLE agent_tokens
  ADD COLUMN IF NOT EXISTS allowed_tools   text[],
  ADD COLUMN IF NOT EXISTS allowed_tag_ids uuid[],
  ADD COLUMN IF NOT EXISTS expires_at      timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_at      timestamptz;

-- Partial index for the resolver's hot path: active tokens only.
-- token_hash already has a UNIQUE index; this narrows it for resolve queries.
CREATE INDEX IF NOT EXISTS agent_tokens_active_idx
  ON agent_tokens (token_hash)
  WHERE revoked_at IS NULL;
