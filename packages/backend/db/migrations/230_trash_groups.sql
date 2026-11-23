-- 230: "deleted together" is judged from facts every node holds (history batch 5, docs/architecture/proposals/history-replication-2026-11-22.md §7).
-- Adds one table and one function, and fills the table from this node's event chain for what is in the trash today. No other row is changed.
--
-- WHY. services/nodeTrash.ts restorePlan used to find "the notes deleted together with X" by following this node's own event log
-- (content_nodes.deleted_by_event_id → domain_events.triggered_by_event_id). Events are not replicated: a node that took the rows by snapshot or
-- bundle has none, and there "restore together" brought back only X. From this migration on the rule reads, in this order:
--   1. trash_groups: an explicit group for X whose stamps still hold (below) — the group is exactly its listed notes;
--   2. otherwise the stamps: X's descendants whose `deleted` unit carries the same write stamp (origin, seq) as X's, still deleted. trashLive deletes
--      a subtree in one transaction, and a transaction has one stamp (spine/stamps.ts), so one delete = one stamp on every node; a descendant
--      deleted on its own, before or after, has another. A note whose parent is deleted with the same stamp was taken along, not deleted itself:
--      nothing comes back with it (as the event chain said: only the delete that started it is chained to).
--
-- trash_groups   one row per (group root, note): `note_id` was deleted together with `root_id`. Two kinds of group:
--                  * deleted before this migration, written below from the event chain; most of those rows carry no stamp (deleted before
--                    migration 190, or the genesis stamp of 202, which every such row shares and so says nothing);
--                  * a transaction that deleted two subtrees one inside the other (a child, then its parent: History's rewind can), where the
--                    stamps alone would put both under the parent; nodeTrash.ts trashLive writes the group then.
--                A marker row (root_id = note_id) says "X's group is explicit", so an explicit group may be empty.
--                `root_stamp` / `note_stamp`: trash_deleted_stamp of each when the row was written ('' = none). A row counts only while both still
--                match: bringing a note back or deleting it again in a later transaction writes a new stamp, so an old group never claims a later
--                delete. Inside one transaction the stamp stays the same, so nodeTrash.ts markTrashed / markLive also retire (`retired`) the rows
--                that name a note whose deletion they write. Rows are never deleted, only by the cascade of a purge, with their notes.
--                Not carried to another node yet: classified `separate` in spine/syncClasses.json, like note_versions; the snapshot's history layer
--                and the bundles carry it (batches 3 and 4 of the proposal). Until then a node that took the rows judges the pre-migration trash
--                by stamps only (genesis: nothing comes back with the note), and the stamps decide every later delete the same on both.
-- trash_deleted_stamp(ws, note)  'origin/seq' of the note's `deleted` unit (the winning stamp, sync_stamps field 'deleted'); NULL when it has
--                none or the genesis one. The one definition: this migration and nodeTrash.ts both call it.
--
-- WHICH GROUPS ARE WRITTEN HERE: for every deleted note X of a workspace that is not being filled from a snapshot, the notes the event chain says
-- were deleted together with it (the old restorePlan query, word for word), in delete order, whenever
--   * that list is not empty, or
--   * X would be judged by the stamps (it has a stamp, its parent is not deleted with the same one) and another deleted note shares its stamp:
--     the stamps might then say something the chain does not, so the chain's answer (possibly empty) is written down.
-- So on this node restorePlan gives, for everything in the trash today, exactly what it gave before (trashGroups.integration.test.ts).
--
-- TIME AND LOCKS: one statement per step over the deleted notes (an index lookup in sync_stamps per note: its primary key). Writes only trash_groups.
-- Idempotent: ON CONFLICT DO NOTHING.
-- Rolling back: restore the pre-upgrade backup (migrations only go forward). In place: DROP TABLE trash_groups; DROP FUNCTION trash_deleted_stamp(uuid, uuid);
-- the older restorePlan reads neither.
-- drill: no allowance needed; no note body or title is written.
--
-- Read-only preview for the production database (SELECT only; run it BEFORE upgrading): how many groups and rows this migration writes.
-- It is the migration's own selection below, read only (the stamp function does not exist yet, so its body is written out); it counts the
-- markers of both kinds (a chain that is not empty, and a stamp that looks like a start). trashGroups.integration.test.ts runs the block
-- between the markers and checks the migration then writes exactly `rows` rows in `groups` groups.
-- preview:begin
-- WITH ws AS (SELECT w.id FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sync_join j WHERE j.workspace_id = w.id AND j.state = 'joining')),
-- st AS (SELECT s.workspace_id, s.row_key::uuid AS id, s.origin || '/' || s.seq::text AS stamp FROM sync_stamps s
--          WHERE s.table_name = 'content_nodes' AND s.field = 'deleted' AND s.origin <> 'genesis'),
-- trashed AS (SELECT n.workspace_id, n.id, n.parent_id, st.stamp FROM content_nodes n JOIN ws ON ws.id = n.workspace_id
--               LEFT JOIN st ON st.workspace_id = n.workspace_id AND st.id = n.id WHERE n.deleted_at IS NOT NULL),
-- old AS (SELECT root.id AS root_id, n.id AS note_id FROM content_nodes root JOIN ws ON ws.id = root.workspace_id
--           JOIN domain_events e ON e.triggered_by_event_id = root.deleted_by_event_id AND e.event_type = 'NODE_DELETED'
--           JOIN content_nodes n ON n.deleted_by_event_id = e.id AND n.workspace_id = root.workspace_id
--          WHERE root.deleted_at IS NOT NULL AND n.deleted_at IS NOT NULL AND n.id <> root.id),
-- roots AS (SELECT DISTINCT o.root_id AS id FROM old o
--           UNION SELECT t.id FROM trashed t
--            WHERE t.stamp IS NOT NULL
--              AND NOT EXISTS (SELECT 1 FROM trashed p WHERE p.id = t.parent_id AND p.stamp = t.stamp)
--              AND EXISTS (SELECT 1 FROM trashed o WHERE o.workspace_id = t.workspace_id AND o.stamp = t.stamp AND o.id <> t.id)),
-- rows AS (SELECT r.id AS root_id, r.id AS note_id FROM roots r UNION SELECT o.root_id, o.note_id FROM old o)
-- SELECT (SELECT count(*) FROM roots) AS groups, (SELECT count(*) FROM rows) AS rows;
-- preview:end

CREATE OR REPLACE FUNCTION trash_deleted_stamp(p_workspace uuid, p_note uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT s.origin || '/' || s.seq::text FROM sync_stamps s
   WHERE s.workspace_id = p_workspace AND s.table_name = 'content_nodes' AND s.row_key = p_note::text AND s.field = 'deleted' AND s.origin <> 'genesis'
$$;

CREATE TABLE IF NOT EXISTS trash_groups (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  root_id uuid NOT NULL REFERENCES content_nodes(id) ON DELETE CASCADE,
  note_id uuid NOT NULL REFERENCES content_nodes(id) ON DELETE CASCADE,
  -- the order the notes were deleted in (0: the marker); restorePlan brings them back in it
  ordinal integer NOT NULL,
  root_stamp text NOT NULL,
  note_stamp text NOT NULL,
  -- the note's deletion was written again since (nodeTrash.ts forgetGroupsOf): the row says nothing any more; kept, the table only grows
  retired boolean NOT NULL DEFAULT false,
  PRIMARY KEY (root_id, root_stamp, note_id)
);
CREATE INDEX IF NOT EXISTS trash_groups_note_idx ON trash_groups (note_id);

WITH ws AS (SELECT w.id FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sync_join j WHERE j.workspace_id = w.id AND j.state = 'joining')),
trashed AS (
  SELECT n.workspace_id, n.id, n.parent_id, trash_deleted_stamp(n.workspace_id, n.id) AS stamp
    FROM content_nodes n JOIN ws ON ws.id = n.workspace_id WHERE n.deleted_at IS NOT NULL),
old AS (
  SELECT root.workspace_id, root.id AS root_id, n.id AS note_id, row_number() OVER (PARTITION BY root.id ORDER BY e.id)::integer AS ordinal
    FROM content_nodes root JOIN ws ON ws.id = root.workspace_id
    JOIN domain_events e ON e.triggered_by_event_id = root.deleted_by_event_id AND e.event_type = 'NODE_DELETED'
    JOIN content_nodes n ON n.deleted_by_event_id = e.id AND n.workspace_id = root.workspace_id
   WHERE root.deleted_at IS NOT NULL AND n.deleted_at IS NOT NULL AND n.id <> root.id),
roots AS (
  SELECT DISTINCT o.workspace_id, o.root_id AS id FROM old o
  UNION
  SELECT t.workspace_id, t.id FROM trashed t
   WHERE t.stamp IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM trashed p WHERE p.id = t.parent_id AND p.stamp = t.stamp)
     AND EXISTS (SELECT 1 FROM trashed o WHERE o.workspace_id = t.workspace_id AND o.stamp = t.stamp AND o.id <> t.id)),
rows AS (
  SELECT r.workspace_id, r.id AS root_id, r.id AS note_id, 0 AS ordinal FROM roots r
  UNION ALL
  SELECT o.workspace_id, o.root_id, o.note_id, o.ordinal FROM old o)
INSERT INTO trash_groups (workspace_id, root_id, note_id, ordinal, root_stamp, note_stamp)
SELECT x.workspace_id, x.root_id, x.note_id, x.ordinal,
       COALESCE(trash_deleted_stamp(x.workspace_id, x.root_id), ''), COALESCE(trash_deleted_stamp(x.workspace_id, x.note_id), '')
  FROM rows x
ON CONFLICT DO NOTHING;
