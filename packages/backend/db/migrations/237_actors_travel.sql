-- 237: the people and AI operators of a workspace (actors) travel by change bundle, and are written on the main server only (own-node transport, batch 5;
-- proposal docs/architecture/proposals/own-node-transport-2026-11-22.md §2.11 first row and §4.3 N6). Before, a snapshot carried them as identity and no bundle
-- did: an AI operator made on the server after a device joined never reached the device, and its membership rows (space_members, actor_id NOT NULL) could
-- never be made there (`missing-ref`).
--
-- THE UNITS (spine/stampedMerge/dbUnits.ts UNIT_SOURCES): key id; the row (`*`: its creation carries id, type and the time it was made, what a snapshot carries),
-- `name` and `write` (write_mode: whether an AI's changes wait for review). Nothing else travels: the sign-in link of a person and every invitation column stay
-- on the node (spine/snapshotTables.json `exclude` / `override`; checkReceived refuses a received type that is not a person or an AI).
-- A TEMPORARY SESSION's row (type 'session') never leaves the node it was opened on (syncClasses.json `neverLeaves`): its rows are never stamped (the triggers'
-- WHEN), the genesis pass skips them (it reads the same WHEN), and a stamp naming one is never sent (snapshotTables.json `neverLeaves`, by the key alone: a
-- session's row is never deleted and keeps its type, migration 217).
--
-- WRITTEN ON THE MAIN SERVER ONLY (actors_written_on_the_centre): on a node whose workspace joined from another node (a sync_join row that is done: a device of
-- the first phase, proposal §1), a write that makes, renames, retypes, changes the write mode of or deletes a person or an AI operator is refused, SQLSTATE
-- ON237, which spine/unitInConflict.ts turns into a 409 `actors_on_main_server` (no screen shows it yet: there is no transport, so no device joined). Not
-- refused there: a temporary session (it lives on that node), a change of the sign-in link or of an invitation (this node's own columns), and a merge or a
-- snapshot import (they store what the centre wrote).
--
-- ALSO: sync_carried_labels() (migration 215) names the seven labels of 236 and 237 too, so a restored server's renewal holds its old id for them as for the others.
--
-- WHAT A SINGLE SERVER SEES: nothing changes. It never joined from another node, so nothing is refused; its writes of these rows are stamped from now on.
--
-- Rolling back: restore the pre-upgrade backup. In place: DROP the triggers and the function this file adds; DELETE FROM sync_stamps WHERE table_name = 'actors'.
-- drill: no allowance needed. This migration writes genesis stamps only.
--
-- Read-only preview for the production database (SELECT only; works with default_transaction_read_only = on; counts only):
--
--   SELECT 'actors rows that get a genesis stamp (people and AI operators)' AS part, count(*)::bigint AS n FROM actors WHERE type <> 'session'
--   UNION ALL SELECT 'temporary sessions (never stamped, never sent)', count(*) FROM actors WHERE type = 'session'
--   UNION ALL SELECT 'workspaces of this node that joined from another node (where writes of people and AI operators are refused from now on; expected 0 on the server)', count(*) FROM sync_join WHERE state = 'done'
--   ;

CREATE OR REPLACE FUNCTION actors_written_on_the_centre() RETURNS trigger AS $$
DECLARE r actors%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  IF sync_import_active(r.workspace_id) OR r.type = 'session' OR (TG_OP = 'UPDATE' AND OLD.type = 'session') THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'UPDATE' AND OLD.name IS NOT DISTINCT FROM NEW.name AND OLD.type IS NOT DISTINCT FROM NEW.type AND OLD.write_mode IS NOT DISTINCT FROM NEW.write_mode
     AND OLD.id IS NOT DISTINCT FROM NEW.id AND OLD.workspace_id IS NOT DISTINCT FROM NEW.workspace_id THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM sync_join j WHERE j.workspace_id = r.workspace_id AND j.state = 'done') THEN
    RAISE EXCEPTION 'the people and AI operators of this workspace are written on the main server' USING ERRCODE = 'ON237';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER actors_written_on_the_centre BEFORE INSERT OR UPDATE OR DELETE ON actors FOR EACH ROW EXECUTE FUNCTION actors_written_on_the_centre();

CREATE OR REPLACE TRIGGER actors_sync_stamp_insert AFTER INSERT ON actors FOR EACH ROW WHEN (NEW.type <> 'session')
  EXECUTE FUNCTION sync_stamp_trigger('actors', 'id', 'workspace_id', 'name=name,write=write_mode', '');
CREATE OR REPLACE TRIGGER actors_sync_stamp_update AFTER UPDATE ON actors FOR EACH ROW
  WHEN (NEW.type <> 'session' AND (OLD.name IS DISTINCT FROM NEW.name OR OLD.write_mode IS DISTINCT FROM NEW.write_mode))
  EXECUTE FUNCTION sync_stamp_trigger('actors', 'id', 'workspace_id', 'name=name,write=write_mode', '');
CREATE OR REPLACE TRIGGER actors_sync_stamp_delete AFTER DELETE ON actors FOR EACH ROW WHEN (OLD.type <> 'session')
  EXECUTE FUNCTION sync_stamp_trigger('actors', 'id', 'workspace_id', 'name=name,write=write_mode', '');

-- The labels a change bundle carries, for a restored server's renewal (migration 215 sync_carried_labels; it holds its old id up to its last number for each): the
-- seven of migrations 236 and 237 added, in the order of spine/stampedMerge/dbUnits.ts CARRIED_LABELS (guards/restoreRenewsNodeId.guard.test.ts compares them).
CREATE OR REPLACE FUNCTION sync_carried_labels() RETURNS text[] AS $$
  SELECT ARRAY['workspaces', 'actors', 'spaces', 'space_members', 'content_nodes', 'node_attributes', 'node_tags', 'node_edges', 'note_pointers', 'node_positions', 'note_anchor_places', 'block_anchors', 'block_nodes', 'block_node_tags', 'function_refs', 'rss_subscriptions', 'rss_mutes', 'external_calendars', 'actor_module_settings', 'ai_edit_suggestions', 'ai_edit_suggestion_items', 'actor_prefs', 'review_states', 'focus_sessions', 'block_link_bindings', 'content_nodes.tag_schema', 'spaces.capabilities', 'function_refs.config', 'workspaces.modules_off', 'workspaces.modules_confirmed']::text[];
$$ LANGUAGE sql IMMUTABLE;

SELECT * FROM sync_genesis_pass();
