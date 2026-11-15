-- 183: one table for review progress — a card is a note or a block node, its schedule lives in review_states either way.
--
-- block_review_states (migration 120) was review_states' twin with block_id for node_id, so every read and write of a
-- schedule picked a table by the card's kind, and moving a card between a block and a child note copied rows from one
-- table to the other (modules/review/seam.ts). Now review_states holds both: exactly one of node_id / block_id is set,
-- each with its own cascade (a deleted note or block takes its schedules with it, as before), and each unique per
-- person. NULLs never collide in a unique index, so ON CONFLICT (node_id, actor_id) and (block_id, actor_id) still
-- find the one row they mean.
--
-- Moves data: every block_review_states row is copied into review_states unchanged (state, previous_state,
-- updated_at), then block_review_states is dropped. No note text changes. The owner agreed to the move (2026-11-09).
-- Rolling back means restoring the backup taken before deploy: the older backend reads block_review_states.
ALTER TABLE review_states ADD COLUMN IF NOT EXISTS block_id uuid REFERENCES block_nodes(id) ON DELETE CASCADE;
ALTER TABLE review_states DROP CONSTRAINT IF EXISTS review_states_pkey;
ALTER TABLE review_states ALTER COLUMN node_id DROP NOT NULL;
ALTER TABLE review_states DROP CONSTRAINT IF EXISTS review_states_one_card;
ALTER TABLE review_states ADD CONSTRAINT review_states_one_card CHECK (num_nonnulls(node_id, block_id) = 1);
CREATE UNIQUE INDEX IF NOT EXISTS review_states_node_actor ON review_states (node_id, actor_id);
CREATE UNIQUE INDEX IF NOT EXISTS review_states_block_actor ON review_states (block_id, actor_id);

DO $$
BEGIN
  IF to_regclass('block_review_states') IS NOT NULL THEN
    INSERT INTO review_states (workspace_id, block_id, actor_id, state, previous_state, updated_at)
    SELECT workspace_id, block_id, actor_id, state, previous_state, updated_at FROM block_review_states
    ON CONFLICT (block_id, actor_id) DO NOTHING;
    DROP TABLE block_review_states;
  END IF;
END $$;
