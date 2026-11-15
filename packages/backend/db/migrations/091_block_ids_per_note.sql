-- ^block-id is unique per NOTE, not per workspace (docs/architecture/spaces.md,
-- phase 0). Obsidian scopes block ids to their file too.
--
-- With a workspace-wide unique index, syncBlockIds upserted on conflict and
-- re-pointed the id at whichever note saved it last: anyone could paste
-- `^abc123` into their own note and hijack every [[note#^abc123]] reference
-- (and the conflict itself told them the id existed). Now each note owns its
-- ids; a bare lookup by id resolves to the oldest note the caller can read.
DROP INDEX IF EXISTS node_block_ids_workspace_block_idx;
CREATE UNIQUE INDEX IF NOT EXISTS node_block_ids_node_block_idx ON node_block_ids (node_id, block_id);
CREATE INDEX IF NOT EXISTS node_block_ids_workspace_block_lookup_idx ON node_block_ids (workspace_id, block_id);
