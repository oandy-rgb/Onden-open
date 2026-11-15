-- Review cards on block nodes (docs/architecture/block-nodes.md, B3).
--
-- `{複習}` on a block makes that block a card; each person's FSRS schedule
-- for it lives here, the block twin of review_states (migration 092): the
-- module's own table keyed by its target, so block nodes get no parallel
-- copy of node_attributes. A block whose `{…}` is removed keeps its row
-- (block_nodes.hidden_at): the schedule comes back with the tag. Removing a
-- member deletes their rows (services/memberRemovals.ts).
CREATE TABLE IF NOT EXISTS block_review_states (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  block_id uuid NOT NULL REFERENCES block_nodes(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  state text NOT NULL,
  previous_state text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (block_id, actor_id)
);
CREATE INDEX IF NOT EXISTS block_review_states_actor_idx ON block_review_states (workspace_id, actor_id);
