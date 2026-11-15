-- 199: write stamps for the keys inside JSON columns, spaces, space members and workspace settings
-- (causal-stamps proposal §8 S3, §4.1, §8.5). Records only: nothing reads a stamp or the structure log to decide anything,
-- so what a user sees does not change, and no existing row is rewritten (stamps and log rows are new rows in the side tables).
--
--   1. One more trigger function, sync_stamp_json_trigger(), and the helper it shares with the board-sections stamps:
--      sync_stamp_json_diff() compares the old and the new JSON value and stamps ONLY the keys that changed. Three shapes:
--        'object'  {key: value}                      a key is a unit        (tag_schema, spaces.capabilities)
--        'array'   [{id: ..., ...}, ...]             an element with a string id is a unit, keyed by that id
--                                                   (collection_views, the board's section frames); a reorder alone changes nothing
--        'set'     ["a", "b"]                        a string in the list is a unit (modules_off, modules_confirmed)
--      jsonb compares by content, so a rewrite in another key order or with other whitespace changes nothing. A unit that is
--      gone gets a tombstone (sync_stamps.deleted); a unit that comes back replaces it. A write that changes no unit does not
--      even take a stamp (no clock tick, no sync_clock count). The stamp's table_name says which column ('content_nodes.tag_schema'),
--      row_key is the row, field is '<unit>:<key>' ('key:fields', 'view:<id>', 'switch:backup', 'off:<module>', 'section:<id>').
--      Triggers on content_nodes are `AFTER UPDATE OF <json column>` with a WHEN on the value, so a note body or title save
--      (which does not name these columns) never reaches the function, and one that rewrites a column with the same value
--      is stopped by WHEN before any JSON is looked at.
--   2. Attached to: content_nodes.collection_views, content_nodes.tag_schema, spaces.capabilities, workspaces.modules_off,
--      workspaces.modules_confirmed. The board's section frames (node_attributes '_canvas_sections') get their per-section stamps
--      inside sync_stamp_attribute_trigger() (S2's function, redefined here with those few lines added; S2's whole-value
--      structure_log line for the frames is kept).
--   3. spaces: the whole row, name, kind, owner and deleted state (generic trigger; kind and owner change when a personal space
--      becomes a shared one, which another node must hear about). space_members: one stamp per (space, member) and the
--      permission; a real delete leaves a tombstone. The workspace of a space_members row is found through its space
--      ('space:space_id'); workspaces: time zone and day-change hour each on their own (generic trigger).
--   4. structure_log (so replaying it gives the tables' present state): space_members (table 'space_members', row = space/member,
--      field 'permission': NULL -> view/suggest/edit when added, old -> new when changed, value -> NULL when removed) and
--      spaces.capabilities (table 'spaces', row = the space, field 'capability:<switch>', old/new = the switch's JSON text,
--      NULL when the switch is absent).
--
-- Not stamped on purpose: workspaces.membership_epoch (bumped by every membership change; a counter, not a setting),
-- workspaces.modules (the retired list), workspaces.name / slug / home_node_id / owner_actor_id, spaces.is_default, and a workspace that is deleted (not a product operation; its
-- rows cascade).
--
-- content_nodes.collection_views: migration 188 moved every saved view into function_refs and froze the column (nothing reads or
-- writes it any more). The trigger is attached anyway, as the task and proposal §4.1 ask; it never fires in normal use.
-- The views that matter now are function_refs rows, which a later change stamps.
-- When the column is dropped, drop content_nodes_collection_views_stamp_insert / _update / _delete with it.
--
-- Existing rows get no stamp here (S5 does that): before its first write after this migration a row, or a key inside its JSON,
-- has no stamp, which a reader treats as "unknown". The first write to a row stamps only the keys it changes.
--
-- Read-only preview for the production database, counts only (what each new trigger will watch):
--   SELECT (SELECT count(*) FROM content_nodes WHERE collection_views IS NOT NULL) AS rows_with_collection_views,
--          (SELECT count(*) FROM content_nodes WHERE tag_schema IS NOT NULL) AS rows_with_tag_schema,
--          (SELECT count(*) FROM spaces) AS spaces, (SELECT count(*) FROM space_members) AS space_members,
--          (SELECT count(*) FROM spaces WHERE capabilities <> '{}'::jsonb) AS spaces_with_capabilities,
--          (SELECT count(*) FROM workspaces) AS workspaces,
--          (SELECT count(*) FROM workspaces WHERE modules_off <> '[]'::jsonb) AS workspaces_with_modules_off,
--          (SELECT count(*) FROM node_attributes WHERE key = '_canvas_sections') AS boards_with_section_frames;
--
-- Rolling back to an older backend: it refuses to start on a database with a migration it does not know (db.ts); after
-- restoring the pre-upgrade backup none of this exists. The triggers read only the row being written and the stamp tables, and
-- a failing JSON value can never fail a write: the section-frame text is parsed inside a block that returns NULL on bad
-- JSON. Older code writing the same columns gets the same triggers, so no write it makes can fail on them.

-- ---------------------------------------------------------------------------------------------------------------------
-- helpers

-- A column of the row being changed as jsonb (NULL when the column is NULL); one column at a time, like sync_column().
CREATE OR REPLACE FUNCTION sync_column_jsonb(r anyelement, p_column text) RETURNS jsonb AS $$
DECLARE v jsonb;
BEGIN
  EXECUTE format('SELECT ($1).%I::jsonb', p_column) INTO v USING r;
  RETURN v;
END;
$$ LANGUAGE plpgsql;

-- Text to jsonb, NULL when it is not JSON (a section-frame attribute is free text in a text column).
CREATE OR REPLACE FUNCTION sync_text_jsonb(p text) RETURNS jsonb AS $$
BEGIN
  RETURN p::jsonb;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The units of a JSON value, by shape (see the header). Anything that is not the shape's container has no units.
CREATE OR REPLACE FUNCTION sync_json_units(p jsonb, p_shape text) RETURNS TABLE (k text, v jsonb) AS $$
  SELECT x.key, x.value FROM jsonb_each(CASE WHEN p_shape = 'object' AND jsonb_typeof(p) = 'object' THEN p ELSE '{}'::jsonb END) x
  UNION ALL
  SELECT e->>'id', e FROM jsonb_array_elements(CASE WHEN p_shape = 'array' AND jsonb_typeof(p) = 'array' THEN p ELSE '[]'::jsonb END) e
   WHERE jsonb_typeof(e) = 'object' AND jsonb_typeof(e->'id') = 'string'
  UNION ALL
  SELECT e #>> '{}', e FROM jsonb_array_elements(CASE WHEN p_shape = 'set' AND jsonb_typeof(p) = 'array' THEN p ELSE '[]'::jsonb END) e
   WHERE jsonb_typeof(e) = 'string';
$$ LANGUAGE sql IMMUTABLE;

-- Stamp the units that differ between p_old and p_new (NULL = the value does not exist). p_log_table <> '' also writes one
-- structure_log row per changed unit (field p_log_prefix || key, old and new as JSON text, NULL when the unit is absent).
-- The workspace's stamp is taken only when something changed.
CREATE OR REPLACE FUNCTION sync_stamp_json_diff(p_ws uuid, p_label text, p_row text, p_shape text, p_prefix text,
                                                p_log_table text, p_log_prefix text, p_old jsonb, p_new jsonb) RETURNS void AS $$
DECLARE
  u record;
  s jsonb;
BEGIN
  FOR u IN
    SELECT coalesce(o.k, n.k) AS k, o.v AS old_v, n.v AS new_v
      FROM sync_json_units(p_old, p_shape) o FULL JOIN sync_json_units(p_new, p_shape) n ON o.k = n.k
     WHERE o.v IS DISTINCT FROM n.v
  LOOP
    IF s IS NULL THEN s := sync_stamp_current(p_ws); END IF;
    PERFORM sync_stamp_put(p_ws, p_label, p_row, p_prefix || u.k, u.new_v IS NULL, s);
    IF p_log_table <> '' THEN
      PERFORM sync_structure_put(p_ws, p_log_table, p_row, p_log_prefix || u.k, u.old_v::text, u.new_v::text, s, false);
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Arguments: 0 stamp table label; 1 row key column; 2 workspace column, 'via:' or 'space:'; 3 the jsonb column; 4 shape
-- ('object' | 'array' | 'set'); 5 unit prefix of the stamp field; 6 structure_log table ('' = none); 7 its field prefix.
CREATE OR REPLACE FUNCTION sync_stamp_json_trigger() RETURNS trigger AS $$
DECLARE
  o jsonb;
  n jsonb;
  ws uuid;
  rkey text;
BEGIN
  IF TG_OP <> 'INSERT' THEN o := sync_column_jsonb(OLD, TG_ARGV[3]); END IF;
  IF TG_OP <> 'DELETE' THEN n := sync_column_jsonb(NEW, TG_ARGV[3]); END IF;
  IF o IS NOT DISTINCT FROM n THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' THEN ws := sync_workspace(OLD, TG_ARGV[2]); rkey := sync_column(OLD, TG_ARGV[1]);
  ELSE ws := sync_workspace(NEW, TG_ARGV[2]); rkey := sync_column(NEW, TG_ARGV[1]); END IF;
  IF ws IS NULL THEN RETURN NULL; END IF; -- the workspace is already gone
  PERFORM sync_stamp_json_diff(ws, TG_ARGV[0], rkey, TG_ARGV[4], TG_ARGV[5], TG_ARGV[6], TG_ARGV[7], o, n);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- The row's workspace, now also 'space:col' = the workspace of the space that column names (space_members has no workspace
-- column; while a space is purged its members are already gone, so a missing space means the rows go with the workspace).
CREATE OR REPLACE FUNCTION sync_workspace(r anyelement, p_arg text) RETURNS uuid AS $$
DECLARE c text; w uuid;
BEGIN
  IF left(p_arg, 6) = 'space:' THEN
    EXECUTE format('SELECT s.workspace_id FROM spaces s WHERE s.id = ($1).%I', substr(p_arg, 7)) INTO w USING r;
    RETURN w;
  END IF;
  IF left(p_arg, 4) <> 'via:' THEN RETURN sync_column(r, p_arg)::uuid; END IF;
  FOREACH c IN ARRAY string_to_array(substr(p_arg, 5), ',') LOOP
    EXECUTE format('SELECT n.workspace_id FROM content_nodes n WHERE n.id = ($1).%I', c) INTO w USING r;
    IF w IS NOT NULL THEN RETURN w; END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------------------------------
-- JSON columns of content_nodes

CREATE OR REPLACE TRIGGER content_nodes_collection_views_stamp_insert AFTER INSERT ON content_nodes FOR EACH ROW
  WHEN (NEW.collection_views IS NOT NULL)
  EXECUTE FUNCTION sync_stamp_json_trigger('content_nodes.collection_views', 'id', 'workspace_id', 'collection_views', 'array', 'view:', '', '');
CREATE OR REPLACE TRIGGER content_nodes_collection_views_stamp_update AFTER UPDATE OF collection_views ON content_nodes FOR EACH ROW
  WHEN (OLD.collection_views IS DISTINCT FROM NEW.collection_views)
  EXECUTE FUNCTION sync_stamp_json_trigger('content_nodes.collection_views', 'id', 'workspace_id', 'collection_views', 'array', 'view:', '', '');
CREATE OR REPLACE TRIGGER content_nodes_collection_views_stamp_delete AFTER DELETE ON content_nodes FOR EACH ROW
  WHEN (OLD.collection_views IS NOT NULL)
  EXECUTE FUNCTION sync_stamp_json_trigger('content_nodes.collection_views', 'id', 'workspace_id', 'collection_views', 'array', 'view:', '', '');

CREATE OR REPLACE TRIGGER content_nodes_tag_schema_stamp_insert AFTER INSERT ON content_nodes FOR EACH ROW
  WHEN (NEW.tag_schema IS NOT NULL)
  EXECUTE FUNCTION sync_stamp_json_trigger('content_nodes.tag_schema', 'id', 'workspace_id', 'tag_schema', 'object', 'key:', '', '');
CREATE OR REPLACE TRIGGER content_nodes_tag_schema_stamp_update AFTER UPDATE OF tag_schema ON content_nodes FOR EACH ROW
  WHEN (OLD.tag_schema IS DISTINCT FROM NEW.tag_schema)
  EXECUTE FUNCTION sync_stamp_json_trigger('content_nodes.tag_schema', 'id', 'workspace_id', 'tag_schema', 'object', 'key:', '', '');
CREATE OR REPLACE TRIGGER content_nodes_tag_schema_stamp_delete AFTER DELETE ON content_nodes FOR EACH ROW
  WHEN (OLD.tag_schema IS NOT NULL)
  EXECUTE FUNCTION sync_stamp_json_trigger('content_nodes.tag_schema', 'id', 'workspace_id', 'tag_schema', 'object', 'key:', '', '');

-- ---------------------------------------------------------------------------------------------------------------------
-- spaces and their members

CREATE OR REPLACE TRIGGER spaces_sync_stamp_insert AFTER INSERT ON spaces FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('spaces', 'id', 'workspace_id', 'name=name,kind=kind,owner=owner_actor_id,deleted=deleted_at', '', '', '');
CREATE OR REPLACE TRIGGER spaces_sync_stamp_update AFTER UPDATE OF name, kind, owner_actor_id, deleted_at ON spaces FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name OR OLD.kind IS DISTINCT FROM NEW.kind OR OLD.owner_actor_id IS DISTINCT FROM NEW.owner_actor_id
        OR (OLD.deleted_at IS NULL) IS DISTINCT FROM (NEW.deleted_at IS NULL))
  EXECUTE FUNCTION sync_stamp_trigger('spaces', 'id', 'workspace_id', 'name=name,kind=kind,owner=owner_actor_id,deleted=deleted_at', '', '', '');
CREATE OR REPLACE TRIGGER spaces_sync_stamp_delete AFTER DELETE ON spaces FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('spaces', 'id', 'workspace_id', 'name=name,kind=kind,owner=owner_actor_id,deleted=deleted_at', '', '', '');

-- A space that is really deleted takes its members with it (ON DELETE CASCADE), but by then the space row is gone and the
-- members' stamp trigger can no longer find the workspace, so their tombstones and "removed" log lines would be lost and the old
-- member stamps would stay as if the members were still there. Deleting the members first, while the space can still be seen,
-- gives each the same tombstone and log line as any other removal. (Same transaction, same result as the cascade.)
CREATE OR REPLACE FUNCTION spaces_remove_members_first() RETURNS trigger AS $$
BEGIN
  DELETE FROM space_members WHERE space_id = OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER spaces_remove_members_first BEFORE DELETE ON spaces FOR EACH ROW EXECUTE FUNCTION spaces_remove_members_first();

CREATE OR REPLACE TRIGGER spaces_capabilities_stamp_insert AFTER INSERT ON spaces FOR EACH ROW
  WHEN (NEW.capabilities <> '{}'::jsonb)
  EXECUTE FUNCTION sync_stamp_json_trigger('spaces.capabilities', 'id', 'workspace_id', 'capabilities', 'object', 'switch:', 'spaces', 'capability:');
CREATE OR REPLACE TRIGGER spaces_capabilities_stamp_update AFTER UPDATE OF capabilities ON spaces FOR EACH ROW
  WHEN (OLD.capabilities IS DISTINCT FROM NEW.capabilities)
  EXECUTE FUNCTION sync_stamp_json_trigger('spaces.capabilities', 'id', 'workspace_id', 'capabilities', 'object', 'switch:', 'spaces', 'capability:');
CREATE OR REPLACE TRIGGER spaces_capabilities_stamp_delete AFTER DELETE ON spaces FOR EACH ROW
  WHEN (OLD.capabilities <> '{}'::jsonb)
  EXECUTE FUNCTION sync_stamp_json_trigger('spaces.capabilities', 'id', 'workspace_id', 'capabilities', 'object', 'switch:', 'spaces', 'capability:');

-- space_members: keyed by (space, member); the permission is its own stamp and its own structure_log line.
CREATE OR REPLACE TRIGGER space_members_sync_stamp_insert AFTER INSERT ON space_members FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('space_members', 'space_id,actor_id', 'space:space_id', 'permission=permission', 'permission^permission', '', '');
CREATE OR REPLACE TRIGGER space_members_sync_stamp_update AFTER UPDATE OF permission ON space_members FOR EACH ROW
  WHEN (OLD.permission IS DISTINCT FROM NEW.permission)
  EXECUTE FUNCTION sync_stamp_trigger('space_members', 'space_id,actor_id', 'space:space_id', 'permission=permission', 'permission^permission', '', '');
CREATE OR REPLACE TRIGGER space_members_sync_stamp_delete AFTER DELETE ON space_members FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('space_members', 'space_id,actor_id', 'space:space_id', 'permission=permission', 'permission^permission', '', '');

-- ---------------------------------------------------------------------------------------------------------------------
-- workspace settings: time zone and day-change hour on their own; each module switch (modules_off: the module is off;
-- modules_confirmed: the owner agreed to it) is one unit, so turning a module on again is a tombstone of "off:<module>".
-- Not on membership_epoch (it changes on every membership change) or the rest of the row.

CREATE OR REPLACE TRIGGER workspaces_sync_stamp_insert AFTER INSERT ON workspaces FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('workspaces', 'id', 'id', 'time_zone=time_zone,day_start=day_start_hour', '', '', '');
CREATE OR REPLACE TRIGGER workspaces_sync_stamp_update AFTER UPDATE OF time_zone, day_start_hour ON workspaces FOR EACH ROW
  WHEN (OLD.time_zone IS DISTINCT FROM NEW.time_zone OR OLD.day_start_hour IS DISTINCT FROM NEW.day_start_hour)
  EXECUTE FUNCTION sync_stamp_trigger('workspaces', 'id', 'id', 'time_zone=time_zone,day_start=day_start_hour', '', '', '');

CREATE OR REPLACE TRIGGER workspaces_modules_off_stamp_insert AFTER INSERT ON workspaces FOR EACH ROW
  WHEN (NEW.modules_off <> '[]'::jsonb)
  EXECUTE FUNCTION sync_stamp_json_trigger('workspaces.modules_off', 'id', 'id', 'modules_off', 'set', 'off:', '', '');
CREATE OR REPLACE TRIGGER workspaces_modules_off_stamp_update AFTER UPDATE OF modules_off ON workspaces FOR EACH ROW
  WHEN (OLD.modules_off IS DISTINCT FROM NEW.modules_off)
  EXECUTE FUNCTION sync_stamp_json_trigger('workspaces.modules_off', 'id', 'id', 'modules_off', 'set', 'off:', '', '');
CREATE OR REPLACE TRIGGER workspaces_modules_confirmed_stamp_insert AFTER INSERT ON workspaces FOR EACH ROW
  WHEN (NEW.modules_confirmed IS NOT NULL AND NEW.modules_confirmed <> '[]'::jsonb)
  EXECUTE FUNCTION sync_stamp_json_trigger('workspaces.modules_confirmed', 'id', 'id', 'modules_confirmed', 'set', 'confirmed:', '', '');
CREATE OR REPLACE TRIGGER workspaces_modules_confirmed_stamp_update AFTER UPDATE OF modules_confirmed ON workspaces FOR EACH ROW
  WHEN (OLD.modules_confirmed IS DISTINCT FROM NEW.modules_confirmed)
  EXECUTE FUNCTION sync_stamp_json_trigger('workspaces.modules_confirmed', 'id', 'id', 'modules_confirmed', 'set', 'confirmed:', '', '');

-- ---------------------------------------------------------------------------------------------------------------------
-- a board's section frames: S2's function (194) with the per-section stamps added; everything else in it is unchanged.

CREATE OR REPLACE FUNCTION sync_stamp_attribute_trigger() RETURNS trigger AS $$
DECLARE
  old_kept boolean := false;
  new_kept boolean := false;
  op text;
  ws uuid;
  rkey text;
  attr text;
  s jsonb;
  value_changed boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_kept := OLD.source IN ('ui', 'explicit', 'dispatcher'); END IF;
  IF TG_OP <> 'DELETE' THEN new_kept := NEW.source IN ('ui', 'explicit', 'dispatcher'); END IF;
  IF NOT old_kept AND NOT new_kept THEN RETURN NULL; END IF;
  -- what this change is to the stamps: a source flip counts as made / removed
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND old_kept AND NOT new_kept) THEN op := 'DELETE';
  ELSIF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NOT old_kept AND new_kept) THEN op := 'INSERT';
  ELSE op := 'UPDATE'; END IF;
  IF op = 'DELETE' THEN
    ws := OLD.workspace_id; rkey := OLD.node_id::text || '/' || OLD.key; attr := OLD.key;
  ELSE
    ws := NEW.workspace_id; rkey := NEW.node_id::text || '/' || NEW.key; attr := NEW.key;
  END IF;
  IF op = 'UPDATE' THEN
    value_changed := OLD.value IS DISTINCT FROM NEW.value;
    IF NOT (value_changed OR OLD.value_type IS DISTINCT FROM NEW.value_type OR OLD.is_inheritable IS DISTINCT FROM NEW.is_inheritable) THEN
      RETURN NULL;
    END IF;
  END IF;
  s := sync_stamp_current(ws);
  IF op = 'INSERT' THEN
    PERFORM sync_stamp_put(ws, 'node_attributes', rkey, '*', false, s);
    IF attr = '_canvas_sections' THEN
      PERFORM sync_structure_put(ws, 'node_attributes', rkey, 'sections', NULL, NEW.value, s, false);
      PERFORM sync_stamp_json_diff(ws, 'node_attributes._canvas_sections', NEW.node_id::text, 'array', 'section:', '', '', NULL, sync_text_jsonb(NEW.value));
    END IF;
  ELSIF op = 'DELETE' THEN
    DELETE FROM sync_stamps WHERE workspace_id = ws AND table_name = 'node_attributes' AND row_key = rkey AND field <> '*';
    PERFORM sync_stamp_put(ws, 'node_attributes', rkey, '*', true, s);
    IF attr = '_canvas_sections' THEN
      PERFORM sync_structure_put(ws, 'node_attributes', rkey, 'sections', OLD.value, NULL, s, false);
      PERFORM sync_stamp_json_diff(ws, 'node_attributes._canvas_sections', OLD.node_id::text, 'array', 'section:', '', '', sync_text_jsonb(OLD.value), NULL);
    END IF;
  ELSE
    IF value_changed THEN PERFORM sync_stamp_put(ws, 'node_attributes', rkey, 'value', false, s); END IF;
    IF OLD.value_type IS DISTINCT FROM NEW.value_type THEN PERFORM sync_stamp_put(ws, 'node_attributes', rkey, 'type', false, s); END IF;
    IF OLD.is_inheritable IS DISTINCT FROM NEW.is_inheritable THEN PERFORM sync_stamp_put(ws, 'node_attributes', rkey, 'inheritable', false, s); END IF;
    IF value_changed AND attr = '_canvas_sections' THEN
      PERFORM sync_structure_put(ws, 'node_attributes', rkey, 'sections', OLD.value, NEW.value, s, false);
      PERFORM sync_stamp_json_diff(ws, 'node_attributes._canvas_sections', NEW.node_id::text, 'array', 'section:', '', '', sync_text_jsonb(OLD.value), sync_text_jsonb(NEW.value));
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
