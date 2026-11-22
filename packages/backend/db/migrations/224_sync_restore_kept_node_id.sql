-- 224: a database that was restored WITHOUT taking a new node id says so (scripts/restore.sh --keep-node-id; the desktop app's "open my current data"
-- after a refused renewal; review of PR #1937, round 2, point 7). Adds only: one table. No existing row is read, changed or deleted.
--
-- WHY. A restore gives the database a new node id (migration 213; scripts/lib/renewNodeId.sql), because the restored copy would otherwise number
-- writes the node had already numbered for other changes. Some backups cannot be renewed (made by migrations 190 to 205: no sync_origins to keep the
-- old id in; or one with no node id replacing a database that had one), and the person may still have to put one back. Then the database keeps its
-- id, and exchanging with nodes that hold its old numbers is unsafe until they join it again. The exchange (a later batch) must be able to see that.
--
-- WHAT THIS ADDS
--   sync_restore_kept_node_id   for each workspace of the database, one row per restore that kept the id: when, the id it kept (NULL: the backup
--                               had none), the id of the database it replaced (NULL: none), why the renewal could not be done ('no-origins-table' |
--                               'no-node-table'). Per workspace, as the old ids in sync_origins are (migration 213), so the exchange of a workspace
--                               finds it with the rest of that workspace's sync state; it goes when its workspace goes.
--                               THE RULE: the table has a row  <=>  the node's current id is one a restore kept and the node has not been joined again.
--                               So a later restore that does renew the id deletes every row (renewNodeId.sql); the rejoin (a later batch) will too.
--                               The table goes with the database's own backups (a restored database keeps knowing); it is node-local, never copied
--                               to another node (spine/syncClasses.json).
--   scripts/lib/renewNodeId.sql creates the same table, from this file's definition (scripts/lib/renewNodeIdSql.mjs), in a backup older than this
--   migration that it has to keep the id of; this migration's CREATE TABLE IF NOT EXISTS then finds it.
--
-- WHAT THIS DOES NOT DO, on purpose
--   * nothing reads the table yet: there is no exchange between nodes (spine/stampedMerge/README.md「接上傳輸前必須完成」says the exchange must refuse).
--
-- Rolling back: restore the pre-upgrade backup (migrations only go forward). In place: DROP TABLE sync_restore_kept_node_id (nothing reads it).
-- drill: no allowance needed. This migration writes no row of any table the drill compares.
--
-- Read-only preview for the production database (SELECT only; works with default_transaction_read_only = on; counts only):
--
--   SELECT 'sync_restore_kept_node_id rows this migration adds' AS part, 0::bigint AS rows
--   UNION ALL SELECT 'the table exists already (made by a restore)', count(*) FROM pg_class WHERE relname = 'sync_restore_kept_node_id'
--   ;

CREATE TABLE IF NOT EXISTS sync_restore_kept_node_id (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kept_at timestamptz NOT NULL DEFAULT now(),
  node_id text,
  overwritten text,
  reason text NOT NULL
);
