-- 241: the look-ups of the `[[link]]` graph are answered by indexes (issue #2021; review of PR #2023, round 1, points 1 and 2). Only indexes: two are added and
-- two get a storage setting. No table, column, function, trigger or row is added, changed or deleted.
--
-- WHY. Each look-up is by key, but no index answered it, so each read every row of the workspace it looked in, and the cost of one note grew with the
-- workspace (a folder of interlinked files grew with the square of its files):
--   1. the wikilink edges INTO some notes (services/wikilinkEdges.ts edgesInto, relinkAfterMove in services/spaces.ts): node_edges_unique_origin_idx starts with
--      the source, so finding the edges by their target read every wikilink edge of the workspace.                    -> node_edges_wikilink_target_idx
--   2. the notes a `[[title]]` names (wikilinkEdges.ts linkCandidatesSql, for syncWikilinkEdges and wikilinkTargets: every save of a note that holds a link,
--      every file imported with links, every note moved or restored): a title is compared lower-cased in NFC, an expression no index held, so every live note of
--      the workspace was read for each.                                                                                 -> content_nodes_title_key_idx
--   3. the link index rows that name a note (wikilinkEdges.ts indexRowsNaming: every note made, renamed, moved or restored): the GIN indexes of note_link_index
--      keep new entries in a pending list until a VACUUM merges them, and a look-up reads the whole list. The desktop and the browser (PGlite) never vacuum, nor
--      does a server between two autovacuum runs, so the list held nearly every row and the planner rightly read the table instead (measured on PGlite, 2,000
--      notes: a sequential read of all 2,031 rows; with the list merged, a bitmap scan of the 10 rows named). With fastupdate off an entry goes into the index
--      as its row is written (a few keys a note); the list they hold now is merged here.                                -> fastupdate = off, gin_clean_pending_list
-- The title is indexed cut to its first 500 characters (`left`, after lower and normalize: wikilinkEdges.ts titleKeySql spells it the same): a character is at
-- most 4 bytes, so a key is at most 2,000 bytes, under btree's limit of a row (about 2,700 bytes). A whole title the database holds has no limit of its own
-- (NODE_TITLE_MAX is the writers' cap, not checked on receive: migration 221), and one too long for an index would refuse its write, or this migration. The cut
-- key only finds the candidates: the exact rule (linkMatchesNodeSql) compares the whole title after.
--
-- Cost: one btree entry per wikilink edge and per live note, built in this migration's transaction (no CONCURRENTLY, docs/agents/migrations.md rule 6): a few
-- seconds for a workspace of a hundred thousand notes. Merging the pending lists reads them once.
--
-- Rolling back: restore the pre-upgrade backup (migrations only go forward). In place: DROP INDEX node_edges_wikilink_target_idx, content_nodes_title_key_idx;
-- ALTER INDEX note_link_index_lc_idx, note_link_index_slug_idx RESET (fastupdate). No behaviour depends on them, only the cost.
-- drill: no allowance needed. This migration writes no row of any table.
--
-- Read-only preview for the production database (SELECT only): neither new index exists before, both after; the two GIN indexes have no options before,
-- {fastupdate=off} after.
--   SELECT c.relname, c.reloptions FROM pg_class c
--    WHERE c.relname IN ('node_edges_wikilink_target_idx', 'content_nodes_title_key_idx', 'note_link_index_lc_idx', 'note_link_index_slug_idx');
CREATE INDEX IF NOT EXISTS node_edges_wikilink_target_idx ON node_edges (workspace_id, target_node_id) WHERE origin = 'wikilink';
CREATE INDEX IF NOT EXISTS content_nodes_title_key_idx ON content_nodes (workspace_id, left(lower(normalize(title, NFC)), 500)) WHERE deleted_at IS NULL;
ALTER INDEX note_link_index_lc_idx SET (fastupdate = off);
ALTER INDEX note_link_index_slug_idx SET (fastupdate = off);
SELECT gin_clean_pending_list('note_link_index_lc_idx'::regclass), gin_clean_pending_list('note_link_index_slug_idx'::regclass);
