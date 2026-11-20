-- 218: a note's space follows its tree; the space a person wrote is a column of its own (stamped-sync, the merge core: src/spine/stampedMerge/rules/space.ts,
-- src/spine/stampedMerge/dbRows.ts deriveNoteSpaces; PR "fix/merge-space-follows-parent"). Adds one column, two functions and two triggers, redefines one function and the three
-- stamp triggers of content_nodes; for spaces the same (one column, the view of a deletion, four functions, four triggers, the three stamp triggers redefined).
-- Copies two columns into the new ones; no other existing row is changed or deleted, no stamp is read, written or rewritten.
--
-- WHY. A note's parent and its space were two units (`parent`, `space`) merged one at a time, while the database holds them together (content_nodes_check_space,
-- DEFERRED: a note is in its parent's space). A per-field merge made combinations nobody wrote (A moves N under X in S1 while B moves N to S2; A moves C under P while
-- B moves P's subtree to S2; A moves P's subtree to S2 while B makes K under P): the whole bundle failed at COMMIT with a raw 23514, and every later bundle carried the
-- same stamps, so two devices stalled for good (src/test/mergeSpaceParent.integration.test.ts). A note under another note is in that note's space; only a note at
-- the top has a space of its own. So:
--
--   content_nodes.written_space_id   NEW. The space a person wrote for the note: what the `space` unit says (src/spine/stampedMerge/dbUnits.ts UNIT_SOURCES maps
--                                    `space` here). It means something for a note at the top; under a parent it is kept, stamped and sent like any unit, and
--                                    not read for the note's space.
--   content_nodes.space_id           UNCHANGED as a column: still what slug uniqueness, content_nodes_check_space and every space-access query read. It is now
--                                    DERIVED only: the written space of the note's top ancestor (after the 4.10 cut of loops). It is no unit, is never
--                                    stamped, and a merge never reads it as the value of a stamp (the mistake of PR #1853, `same-stamp-different-content`).
--
-- WHAT THIS ADDS / CHANGES
--   1. the column (no foreign key: a written space this node does not hold makes the note's derived space the workspace's default one), and the copy written_space_id := space_id for every existing row (tags: NULL as they are). The copy
--      runs BEFORE the stamp triggers watch the new column, and touches no column any other trigger watches, so it writes no stamp, no structure line, no
--      updated_at. A genesis stamp names its value by the sha-256 of the unit's text (migration 205 sync_genesis_hash): the text of `space` was space_id's and is
--      now the copy's, the same text, so every genesis name stays valid.
--   2. content_nodes_derive_space() (redefined; BEFORE INSERT OR UPDATE OF space_id, parent_id, node_type, written_space_id): everything it did, and on a write made
--      on this node (not a snapshot or a merge: sync_import_active) the written space follows the space of a note at the top: a new note gets
--      written_space_id = space_id when none is given; a note that is at the top after the write and whose space or parent changed gets written_space_id = space_id.
--      A note under another note keeps what was written for it (a move of an ancestor changes its space_id, not what anyone wrote for it).
--   3. the stamp triggers of content_nodes (insert, update, delete): `space` is the column written_space_id. The update trigger also runs when written_space_id
--      changes. The structure log still logs space_id (the space the note is in, as the local history has always shown it).
--      So a move of a subtree to another space stamps `space` on its root only; the notes under it are not stamped (they were, one stamp per row, before).
--   A note is AT THE TOP when it has no parent or its parent is a tag: content_nodes_at_top(parent), the same as rules/space.ts spacesOfTree, where the walk ends.
--   4. sync_stamp_space_with_root() AFTER UPDATE OF parent_id, when a note that was not at the top is at the top after the write (a detach to the top, a parent
--      deleted for good: the foreign key empties the column, which is stamped as a write here) and its written space did not change: stamps `space` with the transaction's
--      stamp (the value is the one just written by 2.), as migration 209 stamps `sort` with `parent`. Otherwise another node would show the note at the top in
--      the space of an old head (the one written when it was made, before an ancestor moved).
--   5. sync_stamp_parent_with_space() AFTER UPDATE, when written_space_id changed and the parent did not, for a note at the top (a move of a top note to another
--      space): stamps `parent` and `sort` with the transaction's stamp, their values unchanged (a place is one write, as 209 has it), BESIDE their other heads
--      (sync_stamp_put_beside: `saw` covers the unit's winner only, so a conflict head nobody looked at stays), and the order key's tie stamp (order_stamp)
--      becomes this write's (2.). A space and a parent are one place for a note at the top: a reparent made on another node without seeing the move is then a
--      concurrent write of `parent`, so one wins and the other stays a conflict head (otherwise the move lost with no trace: the space written for a note under a
--      parent is not read); and when the move wins, the note shows the order key it has at the top, not the one the losing drag gave it under its parent.
--   7. an index of the `parent` stamps by the parent a note was moved from (meta.from): the notes a cut of a loop puts back under a note are found by it.
--   6. a space's deletion, the same split (the deletion of a space never reached another node, and a node that deleted a space while another moved a note into it
--      ended with a live note in a deleted space, src/test/mergeCrossFieldSim.test.ts R2):
--      spaces.written_deleted_at   NEW. When a person deleted the space (what the `deleted` unit says; NULL: not deleted). Copied from deleted_at for every row.
--      spaces.deleted_at           UNCHANGED as a column (every read uses it); now DERIVED: the written deletion, unless a live note is in the space. A live note
--                                  there came by a write the deleter had not seen (services/spaces.ts deleteSpace refuses a space with live notes, and no write
--                                  that saw the deletion can put one there): the space is shown, the deletion stays written (a head the deleter can see), and it
--                                  takes effect again once the space is empty. spaces_show_deleted(ws, ids) is that rule, the one definition: the merge calls it
--                                  after its rows are in, and content_nodes_left_kept_space() calls it when an UPDATE here takes a live note out of such a space.
--      spaces_written_deleted()     BEFORE INSERT OR UPDATE OF deleted_at: a write made here writes the deletion (not a snapshot, a merge or the view itself).
--      the three stamp triggers of spaces: `deleted` is written_deleted_at; and sync_stamp_space_deleted_again() stamps a person's delete of a space whose deletion
--      was already written (the view had kept it; the notes have left since), which changes no NULL-ness of the written column and would otherwise not be stamped.
--   Every trigger stands aside while a snapshot or a merge is written (sync_import_active), as every stamp trigger does; the merge derives space_id itself, after
--   the rows are in (src/spine/stampedMerge/dbRows.ts deriveNoteSpaces), and logs and bumps the membership epoch for what that changes, on this node only.
--
-- WHAT THIS DOES NOT DO, on purpose
--   * no stamp is written or rewritten. The `space` stamps the old moves wrote on the notes under the moved root stay: they are writes of the unit and still
--     travel; they are not read for the note's space while it has a parent, and count again if it is ever moved to the top (then its detach stamps `space` anew, 4.).
--   * content_nodes_check_space is unchanged. It still checks a note against its parent and its children at COMMIT, on the stored columns.
--   * no row's space_id changes: the copy makes the new rule give, for every row, the space it has (the preview counts the rows for which it would not: expected 0,
--     content_nodes_check_space has held it).
--
-- DEPLOY. Measured on PostgreSQL 16 without pgroonga (a GIN trigram index over title and body in its place, as on PGlite; 12 indexes on content_nodes), notes with
-- 2 KB bodies in a tree (a one-off script; PR #1907, review round 1, point 7):
--     1,000 notes:  0.1 s; content_nodes heap + indexes 3.36 MB -> 3.41 MB.
--    10,000 notes:  1.1 s; 14.6 MB -> 15.6 MB (+7 %); 10,001 rows updated, 1,011 of them HOT.
--   The copy rewrites every row of content_nodes once (an UPDATE writes a new row version). written_space_id is in no index, so HOT is possible where the page has
--   room; with the default fillfactor 100 most pages have none, so most rows are new versions in other pages and every index (pgroonga's included) gets an entry
--   for each: expect the indexes to grow by about one entry per note until VACUUM, and pgroonga's by more than the GIN index measured here. ALTER TABLE takes an
--   ACCESS EXCLUSIVE lock for the whole migration (one transaction): reads and writes of content_nodes wait for it, about 1 s per 10,000 notes. Run VACUUM
--   (ANALYZE) content_nodes afterwards on a large workspace. A second run changes no row (0 rows updated, measured): the copies are guarded by the triggers 218
--   makes.
--
-- Rolling back: restore the pre-upgrade backup (migrations only go forward). In place: re-run 200's three stamp triggers of content_nodes and the
-- content_nodes_derive_space of the schema before 218; DROP TRIGGER content_nodes_sync_stamp_space_root ON content_nodes; DROP TRIGGER content_nodes_sync_stamp_parent_space ON content_nodes; DROP FUNCTION sync_stamp_space_with_root(), sync_stamp_parent_with_space(), sync_stamp_put_beside(uuid, text, text, jsonb, text), content_nodes_at_top(uuid);
-- DROP INDEX sync_stamps_parent_from_idx;
-- ALTER TABLE content_nodes DROP COLUMN written_space_id; re-run 199's three stamp triggers of spaces; DROP TRIGGER spaces_written_deleted ON spaces;
-- DROP TRIGGER spaces_sync_stamp_deleted_again ON spaces; DROP TRIGGER content_nodes_left_kept_space_update ON content_nodes; DROP FUNCTION spaces_show_deleted(uuid, uuid[]), spaces_written_deleted(), sync_stamp_space_deleted_again(),
-- content_nodes_left_kept_space(); ALTER TABLE spaces DROP COLUMN written_deleted_at. A node that took a bundle under 218 holds `space` stamps of roots only; that is what 218 means by `space`.
-- drill: no allowance needed. The copies write new columns only.
--
-- Read-only preview for the production database (SELECT only; works with default_transaction_read_only = on; counts only):
--
--   WITH RECURSIVE up AS (
--     SELECT c.id, c.parent_id, c.space_id AS own, c.id AS top, 0 AS depth FROM content_nodes c WHERE c.node_type <> 'class_tag'
--     UNION ALL
--     SELECT up.id, p.parent_id, up.own, p.id, up.depth + 1 FROM up JOIN content_nodes p ON p.id = up.parent_id AND p.node_type <> 'class_tag' WHERE up.depth < 1000)
--   SELECT 'notes the new rule would give another space than they have (expected 0)' AS part, count(*)::bigint AS rows, 0::bigint AS est_bytes
--     FROM (SELECT DISTINCT ON (up.id) up.id, up.own, t.space_id AS derived FROM up JOIN content_nodes t ON t.id = up.top ORDER BY up.id, up.depth DESC) d
--    WHERE d.own IS DISTINCT FROM d.derived
--   UNION ALL
--   SELECT 'notes whose written space is set by the copy', count(*)::bigint, (count(*) * 16)::bigint FROM content_nodes WHERE space_id IS NOT NULL
--   UNION ALL
--   SELECT 'space stamps of notes under a parent (kept, not read while the note has a parent)', count(*)::bigint, 0::bigint
--     FROM sync_stamps s JOIN content_nodes c ON c.id::text = s.row_key AND c.workspace_id = s.workspace_id
--    WHERE s.table_name = 'content_nodes' AND s.field = 'space' AND c.parent_id IS NOT NULL
--   UNION ALL
--   SELECT 'spaces whose written deletion is set by the copy', count(*)::bigint, (count(*) * 8)::bigint FROM spaces WHERE deleted_at IS NOT NULL
--   UNION ALL
--   SELECT 'deleted spaces with a live note in them (would be shown as not deleted; expected 0)', count(*)::bigint, 0::bigint
--     FROM spaces s WHERE s.deleted_at IS NOT NULL AND EXISTS (SELECT 1 FROM content_nodes c WHERE c.space_id = s.id AND c.deleted_at IS NULL AND c.node_type <> 'class_tag')
--   UNION ALL SELECT 'sync_stamps rows written or rewritten', 0, 0
--   ;

-- 1. the column and the copy (before any trigger watches it)
-- (no foreign key: what a person wrote is replicated as it was written; a written space this node does not hold derives the workspace's default space,
-- the same on every node: src/spine/stampedMerge/dbRows.ts deriveNoteSpaces)
ALTER TABLE content_nodes ADD COLUMN IF NOT EXISTS written_space_id uuid;
-- (only while no trigger watches the new column, i.e. on the first run: run again by hand later, it would overwrite the space written for a note under a parent,
-- which may rightly differ from the one it is in, and the stamp trigger would stamp it)
UPDATE content_nodes SET written_space_id = space_id WHERE written_space_id IS DISTINCT FROM space_id
   AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'content_nodes_sync_stamp_space_root' AND tgrelid = 'content_nodes'::regclass);

-- A note is at the top when it has no parent or its parent is a tag (the same as src/spine/stampedMerge/rules/space.ts spacesOfTree, where the walk ends).
CREATE OR REPLACE FUNCTION content_nodes_at_top(p_parent uuid) RETURNS boolean AS $$
  SELECT p_parent IS NULL OR EXISTS (SELECT 1 FROM content_nodes p WHERE p.id = p_parent AND p.node_type = 'class_tag');
$$ LANGUAGE sql STABLE;

-- 2. the written space follows the space of a note at the top, on a write made here
CREATE OR REPLACE FUNCTION content_nodes_derive_space() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_space uuid;
  parent_type text;
  actor_space text;
  at_top boolean;
BEGIN
  IF NEW.node_type = 'class_tag' THEN
    NEW.space_id := NULL;
    NEW.written_space_id := NULL;
    RETURN NEW;
  END IF;
  IF NEW.space_id IS NULL THEN
    IF NEW.parent_id IS NOT NULL THEN
      SELECT space_id, node_type INTO parent_space, parent_type FROM content_nodes WHERE id = NEW.parent_id;
      IF parent_type IS DISTINCT FROM 'class_tag' THEN NEW.space_id := parent_space; END IF;
    END IF;
    IF NEW.space_id IS NULL THEN
      actor_space := NULLIF(current_setting('onden.actor_space', true), '');
      IF actor_space IS NOT NULL THEN NEW.space_id := actor_space::uuid; END IF;
    END IF;
    IF NEW.space_id IS NULL THEN
      -- A background job (spine/systemJobs.ts; mutate() sets onden.system_actor)
      -- has no personal space: it names a parent or a space, or the create fails.
      IF current_setting('onden.system_actor', true) = 'on' THEN
        RAISE EXCEPTION 'a system job has no personal space: give the new note a parent or a space'
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT id INTO NEW.space_id FROM spaces WHERE workspace_id = NEW.workspace_id AND is_default;
    END IF;
  END IF;
  -- a snapshot or a merge stores the written space as it was carried, NULL included (it is what the `space` unit says; the merge derives space_id itself,
  -- dbRows.ts deriveNoteSpaces)
  IF sync_import_active(NEW.workspace_id) THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.written_space_id IS NULL THEN NEW.written_space_id := NEW.space_id; END IF;
    RETURN NEW;
  END IF;
  IF NEW.space_id IS NOT DISTINCT FROM OLD.space_id AND NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id THEN RETURN NEW; END IF;
  at_top := content_nodes_at_top(NEW.parent_id);
  IF at_top THEN
    -- a note at the top before and after, whose space changes, is placed there (5. below stamps `parent` and `sort` with this write): the order key's stamp
    -- (migration 200 order_stamp, the tie rule among equal keys) becomes this write's, as order_stamp_follow_parent (209) does for a move
    IF NEW.space_id IS DISTINCT FROM OLD.space_id AND NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id AND content_nodes_at_top(OLD.parent_id)
       AND NEW.written_space_id IS DISTINCT FROM NEW.space_id THEN
      NEW.order_stamp := lpad(sync_stamp_current(NEW.workspace_id)->>'wall', 15, '0') || lpad(sync_stamp_current(NEW.workspace_id)->>'counter', 6, '0');
    END IF;
    NEW.written_space_id := NEW.space_id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS content_nodes_derive_space ON content_nodes;
CREATE TRIGGER content_nodes_derive_space
  BEFORE INSERT OR UPDATE OF space_id, parent_id, node_type, written_space_id ON content_nodes
  FOR EACH ROW EXECUTE FUNCTION content_nodes_derive_space();

-- 3. the stamp triggers: `space` is the written space
CREATE OR REPLACE TRIGGER content_nodes_sync_stamp_insert AFTER INSERT ON content_nodes FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('content_nodes', 'id', 'workspace_id',
    'title=title,body=markdown,parent=parent_id,sort=order_key,hidden=hidden,space=written_space_id,deleted=deleted_at',
    'parent=parent_id,sort=order_key,space=space_id,deleted=deleted_at');
CREATE OR REPLACE TRIGGER content_nodes_sync_stamp_update AFTER UPDATE ON content_nodes FOR EACH ROW
  WHEN (OLD.title IS DISTINCT FROM NEW.title OR OLD.markdown IS DISTINCT FROM NEW.markdown
     OR OLD.parent_id IS DISTINCT FROM NEW.parent_id OR OLD.order_key IS DISTINCT FROM NEW.order_key
     OR OLD.hidden IS DISTINCT FROM NEW.hidden OR OLD.space_id IS DISTINCT FROM NEW.space_id
     OR OLD.written_space_id IS DISTINCT FROM NEW.written_space_id
     OR (OLD.deleted_at IS NULL) IS DISTINCT FROM (NEW.deleted_at IS NULL))
  EXECUTE FUNCTION sync_stamp_trigger('content_nodes', 'id', 'workspace_id',
    'title=title,body=markdown,parent=parent_id,sort=order_key,hidden=hidden,space=written_space_id,deleted=deleted_at',
    'parent=parent_id,sort=order_key,space=space_id,deleted=deleted_at');
CREATE OR REPLACE TRIGGER content_nodes_sync_stamp_delete AFTER DELETE ON content_nodes FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('content_nodes', 'id', 'workspace_id',
    'title=title,body=markdown,parent=parent_id,sort=order_key,hidden=hidden,space=written_space_id,deleted=deleted_at',
    'parent=parent_id,sort=order_key,space=space_id,deleted=deleted_at');

-- 4. a note that comes to the top stamps the space it is in, with the write that put it there
CREATE OR REPLACE FUNCTION sync_stamp_space_with_root() RETURNS trigger AS $$
BEGIN
  IF sync_import_active(NEW.workspace_id) THEN RETURN NULL; END IF;
  PERFORM sync_stamp_put_row(NEW.workspace_id, 'content_nodes', NEW.id::text, 'space', false, sync_stamp_current(NEW.workspace_id), OLD, 'written_space_id');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER content_nodes_sync_stamp_space_root AFTER UPDATE OF parent_id ON content_nodes FOR EACH ROW
  WHEN (OLD.parent_id IS DISTINCT FROM NEW.parent_id AND NEW.node_type <> 'class_tag' AND OLD.written_space_id IS NOT DISTINCT FROM NEW.written_space_id
        AND content_nodes_at_top(NEW.parent_id) AND NOT content_nodes_at_top(OLD.parent_id))
  EXECUTE FUNCTION sync_stamp_space_with_root();

-- 5. a note at the top whose space is written is PLACED there: the write also stamps its parent (the same value, at the top), as 209 stamps `sort` with `parent`.
-- A space and a parent are one place for a note at the top: a reparent made elsewhere without seeing this move is a concurrent write of the same unit, so the
-- later of the two wins and the other stays a conflict head its author can see. Without it, a move to another space lost to a reparent it never met with no
-- trace (the winning `space` of a note under a parent is not read).
-- A stamp of a unit of a note, with its value unchanged, BESIDE the unit's other heads (review of PR #1907, round 1, point 3): its `saw` is the unit's winner only, and
-- the other heads stay. The person moved the note to another space and made no choice between the places two other writes gave it; sync_stamp_put_over, which
-- takes every head as seen and removes it, would drop a head nobody had looked at. On another node the stamp covers the same winner and leaves the same heads,
-- so taking it again, or everything again, changes nothing.
CREATE OR REPLACE FUNCTION sync_stamp_put_beside(p_ws uuid, p_key text, p_field text, s jsonb, p_old text) RETURNS void AS $$
DECLARE d record; v_saw jsonb := '{}'::jsonb; v_meta jsonb;
BEGIN
  IF sync_import_active(p_ws) THEN RETURN; END IF;
  SELECT * INTO d FROM sync_stamps WHERE workspace_id = p_ws AND table_name = 'content_nodes' AND row_key = p_key AND field = p_field;
  IF FOUND THEN
    IF d.origin = s->>'origin' AND d.seq = (s->>'seq')::bigint THEN RETURN; END IF; -- this transaction wrote the unit already
    IF d.origin = 'genesis' THEN v_saw := jsonb_build_object('genesis:' || sync_genesis_hash(sync_content_text(p_old)), 0);
    ELSE v_saw := sync_saw_merge(d.saw, jsonb_build_object(d.origin, d.seq)); END IF;
  ELSE
    -- the field follows its row's creation (README "跟著 `*` 的欄位"), as sync_stamp_put_over reads it
    SELECT * INTO d FROM sync_stamps WHERE workspace_id = p_ws AND table_name = 'content_nodes' AND row_key = p_key AND field = '*';
    IF FOUND AND d.origin = 'genesis' THEN v_saw := jsonb_build_object('genesis:' || sync_genesis_hash(sync_content_text(p_old)), 0);
    ELSIF FOUND AND NOT (d.origin = s->>'origin' AND d.seq = (s->>'seq')::bigint) THEN v_saw := jsonb_build_object(d.origin, d.seq); END IF;
  END IF;
  IF p_field = 'parent' THEN v_meta := jsonb_build_object('from', p_old); END IF;
  INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, author, device, deleted, saw, meta)
  VALUES (p_ws, 'content_nodes', p_key, p_field, s->>'origin', (s->>'seq')::bigint, (s->>'wall')::bigint, (s->>'counter')::int,
          s->>'author', NULLIF(s->>'device', '')::uuid, false, v_saw, v_meta)
  ON CONFLICT (workspace_id, table_name, row_key, field) DO UPDATE SET
    origin = EXCLUDED.origin, seq = EXCLUDED.seq, hlc_wall = EXCLUDED.hlc_wall, hlc_counter = EXCLUDED.hlc_counter,
    author = EXCLUDED.author, device = EXCLUDED.device, deleted = EXCLUDED.deleted, saw = EXCLUDED.saw, meta = EXCLUDED.meta;
END;
$$ LANGUAGE plpgsql;

-- a place is one write (209): `parent` and `sort` together, each beside its other heads
CREATE OR REPLACE FUNCTION sync_stamp_parent_with_space() RETURNS trigger AS $$
DECLARE s jsonb;
BEGIN
  IF sync_import_active(NEW.workspace_id) THEN RETURN NULL; END IF;
  s := sync_stamp_current(NEW.workspace_id);
  PERFORM sync_stamp_put_beside(NEW.workspace_id, NEW.id::text, 'parent', s, OLD.parent_id::text);
  PERFORM sync_stamp_put_beside(NEW.workspace_id, NEW.id::text, 'sort', s, OLD.order_key);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
-- (no column list: written_space_id is set by content_nodes_derive_space, not by the statement, and UPDATE OF fires only for columns the statement names)
CREATE OR REPLACE TRIGGER content_nodes_sync_stamp_parent_space AFTER UPDATE ON content_nodes FOR EACH ROW
  WHEN (OLD.written_space_id IS DISTINCT FROM NEW.written_space_id AND OLD.parent_id IS NOT DISTINCT FROM NEW.parent_id AND NEW.node_type <> 'class_tag'
        AND content_nodes_at_top(NEW.parent_id))
  EXECUTE FUNCTION sync_stamp_parent_with_space();

-- 6. a space's deletion: what a person wrote, and what is shown. spaces.deleted_at stays the column every read uses; `deleted` is now the written column.
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS written_deleted_at timestamptz;
UPDATE spaces SET written_deleted_at = deleted_at WHERE written_deleted_at IS DISTINCT FROM deleted_at
   AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'spaces_written_deleted' AND tgrelid = 'spaces'::regclass);

-- the view: a space whose deletion is written is shown deleted only while no live note is in it (a live note there came by a write the deleter had not seen:
-- deleteSpace refuses a space with live notes, and no write that saw the deletion can put one there). One definition, called by the merge after its rows are in
-- (src/spine/stampedMerge/dbRows.ts storeMergedRows) and by the triggers below when a live note leaves such a space here. Returns how many rows it changed.
CREATE OR REPLACE FUNCTION spaces_show_deleted(p_ws uuid, p_ids uuid[]) RETURNS integer AS $$
DECLARE n integer;
BEGIN
  PERFORM set_config('onden.space_deleted_view', 'on', true);
  UPDATE spaces s SET deleted_at = v.shown
    FROM (SELECT x.id, CASE WHEN x.written_deleted_at IS NOT NULL AND NOT EXISTS (
                   SELECT 1 FROM content_nodes c WHERE c.workspace_id = x.workspace_id AND c.space_id = x.id AND c.deleted_at IS NULL AND c.node_type <> 'class_tag')
                 THEN x.written_deleted_at END AS shown
            FROM spaces x WHERE x.workspace_id = p_ws AND x.id = ANY(p_ids)) v
   WHERE s.id = v.id AND s.deleted_at IS DISTINCT FROM v.shown;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('onden.space_deleted_view', '', true);
  RETURN n;
END;
$$ LANGUAGE plpgsql;

-- a write made here (not a snapshot, a merge or the view) that deletes or restores a space writes it
CREATE OR REPLACE FUNCTION spaces_written_deleted() RETURNS trigger AS $$
BEGIN
  IF current_setting('onden.space_deleted_view', true) = 'on' OR sync_import_active(NEW.workspace_id) THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' OR (OLD.deleted_at IS NULL) IS DISTINCT FROM (NEW.deleted_at IS NULL) THEN NEW.written_deleted_at := NEW.deleted_at; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS spaces_written_deleted ON spaces;
CREATE TRIGGER spaces_written_deleted BEFORE INSERT OR UPDATE OF deleted_at ON spaces FOR EACH ROW EXECUTE FUNCTION spaces_written_deleted();

CREATE OR REPLACE TRIGGER spaces_sync_stamp_insert AFTER INSERT ON spaces FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('spaces', 'id', 'workspace_id', 'name=name,kind=kind,owner=owner_actor_id,deleted=written_deleted_at', '', '', '');
CREATE OR REPLACE TRIGGER spaces_sync_stamp_update AFTER UPDATE OF name, kind, owner_actor_id, deleted_at, written_deleted_at ON spaces FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name OR OLD.kind IS DISTINCT FROM NEW.kind OR OLD.owner_actor_id IS DISTINCT FROM NEW.owner_actor_id
        OR (OLD.written_deleted_at IS NULL) IS DISTINCT FROM (NEW.written_deleted_at IS NULL))
  EXECUTE FUNCTION sync_stamp_trigger('spaces', 'id', 'workspace_id', 'name=name,kind=kind,owner=owner_actor_id,deleted=written_deleted_at', '', '', '');
CREATE OR REPLACE TRIGGER spaces_sync_stamp_delete AFTER DELETE ON spaces FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('spaces', 'id', 'workspace_id', 'name=name,kind=kind,owner=owner_actor_id,deleted=written_deleted_at', '', '', '');

-- a person who deletes a space the view kept (its deletion was already written, the notes have left since) deletes it again: a write, stamped
CREATE OR REPLACE FUNCTION sync_stamp_space_deleted_again() RETURNS trigger AS $$
BEGIN
  IF current_setting('onden.space_deleted_view', true) = 'on' OR sync_import_active(NEW.workspace_id) THEN RETURN NULL; END IF;
  PERFORM sync_stamp_put_row(NEW.workspace_id, 'spaces', NEW.id::text, 'deleted', false, sync_stamp_current(NEW.workspace_id), OLD, 'written_deleted_at');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER spaces_sync_stamp_deleted_again AFTER UPDATE OF deleted_at ON spaces FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND OLD.written_deleted_at IS NOT NULL)
  EXECUTE FUNCTION sync_stamp_space_deleted_again();

-- a live note that leaves a space the view keeps by an UPDATE made here (moved out, put in the trash): the view is worked out again for that space. Only UPDATE:
-- a DELETE (a purge), a note that comes INTO such a space, and a restore are not worked out here; they are worked out at the next merge (README of
-- src/spine/stampedMerge, "接上傳輸前必須完成"). A change of the view here bumps no epoch and writes no event.
CREATE OR REPLACE FUNCTION content_nodes_left_kept_space() RETURNS trigger AS $$
DECLARE v record;
BEGIN
  FOR v IN
    SELECT o.workspace_id AS ws, array_agg(DISTINCT o.space_id) AS ids
      FROM old_rows o LEFT JOIN new_rows n ON n.id = o.id
      JOIN spaces s ON s.id = o.space_id AND s.written_deleted_at IS NOT NULL
     WHERE o.deleted_at IS NULL AND o.space_id IS NOT NULL AND (n.id IS NULL OR n.space_id IS DISTINCT FROM o.space_id OR n.deleted_at IS NOT NULL)
     GROUP BY o.workspace_id
  LOOP
    IF NOT sync_import_active(v.ws) THEN PERFORM spaces_show_deleted(v.ws, v.ids); END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER content_nodes_left_kept_space_update AFTER UPDATE ON content_nodes
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION content_nodes_left_kept_space();

-- 7. the notes a cut of a loop puts back under a note (src/spine/stampedMerge/dbRows.ts effectiveSubtree): found by their winning `parent` write's `meta.from`
CREATE INDEX IF NOT EXISTS sync_stamps_parent_from_idx ON sync_stamps (workspace_id, (meta->>'from'))
  WHERE table_name = 'content_nodes' AND field = 'parent' AND meta ? 'from';
