-- 235: a note's slug is a unit that travels: the slug the WRITE chose is stamped and carried (own-node transport, batch 5; docs/architecture/proposals/
-- own-node-transport-2026-11-22.md §2.12.6, and spine/stampedMerge/README.md 「接上傳輸前必須完成」: three or more notes moved or restored into one space
-- at once ended with different suffixes on two nodes, because the suffix a note that gave way took was the first free one on that node's state).
--
-- THE TWO COLUMNS (the same split as migration 218 made for a note's space):
--   written_slug   the slug the write that set it chose (a creation, a rename, a move or a restore that had to take `-2`): the unit `slug`, stamped by the
--                  stamp trigger, carried and merged like every unit. On the node that writes it is always the slug (content_nodes_written_slug, below).
--   slug           the slug the note HAS: the one every reader uses (addresses, `[[slug]]`). On the node that writes, the slug it wrote; on a node that
--                  takes a bundle, a function of replicated state only: among the live notes of one space that want one name (same written_slug), the
--                  one with the earliest claim has it, every other one has `<name>-<first eight of its id>` (content_nodes_settle_slugs). A node that holds
--                  the same writes has the same slugs, whatever order they came in.
--   A claim is the latest stamp of the note's own creation, title, slug, deletion (a restore) and written space (stamps replicate: every node orders them alike,
--   hlc.ts compareOps; of two equal claims the smaller id). Not its place: the owner decided (2026-11-23, PR #1992) that a note moved under another note of the
--   same space keeps its name, so a published address and the links people saved do not change with a move in the tree; it lets the name go only by leaving
--   the space, being deleted or being renamed. Only the note's OWN units count, not those of the notes above it: a change of any passes through this note's row,
--   so it is seen where the group is settled again (content_nodes_slug_group_left on the node that writes, the bundle's own notes on the node that takes it).
--
-- WHAT A SINGLE SERVER SEES: nothing changes. Every write there goes through the write path, which keeps written_slug = slug (the BEFORE trigger copies
-- it), so no two live notes of a space ever want one name (the unique index content_nodes_space_slug_uq holds the slugs, and they are the names), the
-- group settle finds nothing to do, and the trigger that settles a group again on a local write only looks (one index probe on an index that is empty on
-- such a server: content_nodes_slug_losers). The slug stamp does not count as an edit for `updated_at` (sync_touch_updated_at, redefined here with 'slug'
-- next to '*' and 'sort': a move's `-2` is not an edit of the note), so the recently-updated order does not move either. Running it writes written_slug
-- of every note once (= its slug; no other column, no stamp: the stamp trigger does not watch the column until it is replaced below, the same order as
-- migration 218's written_space_id). No slug changes.
--
-- WHAT THIS ADDS
--   content_nodes.written_slug, filled from slug; the unit `slug` (stamp trigger fields of content_nodes, spine/stampedMerge/dbUnits.ts UNIT_SOURCES).
--   content_nodes_written_slug()      BEFORE INSERT OR UPDATE OF slug: the write path's slug is the written one. Not while a snapshot or a bundle is taken
--                                     (sync_import_active: it stores what the unit says), nor while a group is settled (onden.slug_settle), nor for the
--                                     `~<id>` a note holds while a move gives slugs: a note under a moved one whose slug ends as it was writes nothing.
--   content_nodes_settle_slugs()      the one rule above, for the notes and names given; called by the merge for every note a bundle bears on
--                                     (spine/noteSlugs.ts settleReceivedSlugs) and by the trigger below.
--   content_nodes_slug_group_left()   (trigger content_nodes_then_settle_slug_group, after the stamp triggers) AFTER a local write of a live note's name, space or deletion: if a note of the group it was in has a slug that
--                                     is not its name (it gave way), the group is settled again (the note that held the name may have left it).
--   content_nodes_written_slug_idx, content_nodes_slug_losers   the two look-ups (by name; and the notes that gave way, none on a single server).
--
-- WHAT THIS DOES NOT DO: it does not change how a slug is chosen on the node that writes (services/nodes.ts uniqueSlug, spine/noteSlugs.ts settleSlugs:
-- the notes being written give way and take the first free one, as before). It writes no stamp, no event, no outbox job.
--
-- Rolling back: restore the pre-upgrade backup (migrations only go forward). In place: run migration 218's three stamp triggers of content_nodes, 209's
-- sync_touch_updated_at and 206's sync_stamp_put_over again, then DROP the two triggers, the three functions, the two indexes and the column this file adds; DELETE FROM sync_stamps
-- WHERE table_name = 'content_nodes' AND field = 'slug' (and the same in sync_stamp_heads) removes the stamps (nothing else reads them).
-- drill: no allowance needed. This migration writes only content_nodes.written_slug, a new column; no title, body or slug changes.
--
-- Read-only preview for the production database (SELECT only; works with default_transaction_read_only = on; counts only). The first line is the rows the
-- UPDATE below writes; a slug can change later only for a live note in a group of more than one (same workspace, space and slug), which the unique index
-- content_nodes_space_slug_uq rules out, so the second and third lines count what would change and what the index of the notes that gave way would hold:
--
--   SELECT 'notes that get written_slug (= their slug; nothing else is written)' AS part, count(*)::bigint AS n FROM content_nodes
--   UNION ALL SELECT 'live notes in a group of more than one that wants one name: notes whose slug a settle could change (must be 0)', coalesce(sum(n), 0) FROM (
--     SELECT count(*) AS n FROM content_nodes WHERE deleted_at IS NULL GROUP BY workspace_id, COALESCE(space_id, '00000000-0000-0000-0000-000000000000'::uuid), slug HAVING count(*) > 1) g
--   UNION ALL SELECT 'notes that will hold a slug other than the one their write chose (the index content_nodes_slug_losers; written_slug := slug, so must be 0)', count(*)
--     FROM content_nodes WHERE slug IS DISTINCT FROM slug
--   ;
--
-- And after it ran, the same two numbers read from what it wrote (must be 0 and 0):
--   SELECT count(*) FROM content_nodes WHERE written_slug IS DISTINCT FROM slug;
--   SELECT count(*) FROM content_nodes WHERE slug IS DISTINCT FROM written_slug AND left(slug, 1) <> '~';

ALTER TABLE content_nodes ADD COLUMN IF NOT EXISTS written_slug text;
-- (only while no trigger watches the new column, i.e. on the first run, as 218 did for written_space_id)
UPDATE content_nodes SET written_slug = slug WHERE written_slug IS DISTINCT FROM slug
   AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'content_nodes_written_slug' AND tgrelid = 'content_nodes'::regclass);

CREATE INDEX IF NOT EXISTS content_nodes_written_slug_idx ON content_nodes (workspace_id, written_slug);
CREATE INDEX IF NOT EXISTS content_nodes_slug_losers ON content_nodes (workspace_id, written_slug) WHERE slug IS DISTINCT FROM written_slug;

CREATE OR REPLACE FUNCTION content_nodes_written_slug() RETURNS trigger AS $$
BEGIN
  IF sync_import_active(NEW.workspace_id) OR current_setting('onden.slug_settle', true) = 'on' THEN RETURN NEW; END IF;
  -- `~<id>` is the name a note holds only while slugs are given (spine/noteSlugs.ts settleSlugs): no write chose it, so a move that gives a note its own slug
  -- back writes nothing of it (a subtree move stamps its root only, migration 218)
  IF TG_OP = 'UPDATE' AND left(NEW.slug, 1) = '~' THEN RETURN NEW; END IF;
  NEW.written_slug := NEW.slug;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER content_nodes_written_slug BEFORE INSERT OR UPDATE OF slug ON content_nodes FOR EACH ROW EXECUTE FUNCTION content_nodes_written_slug();

-- The one rule (header). p_ids: notes whose slug is to be given again (a bundle's notes; they may hold `~<id>` meanwhile); p_names: names whose groups are settled
-- again besides those of p_ids (the names a bundle's notes had before it). In the caller's transaction; the slug writes are no person's (onden.slug_settle).
CREATE OR REPLACE FUNCTION content_nodes_settle_slugs(p_ws uuid, p_ids uuid[], p_names text[]) RETURNS void AS $$
DECLARE r record; v_names text[]; v_want text; v_ids uuid[] := '{}'; v_wants text[] := '{}'; i int;
BEGIN
  PERFORM set_config('onden.slug_settle', 'on', true);
  SELECT array_agg(DISTINCT n) INTO v_names FROM (SELECT unnest(COALESCE(p_names, '{}')) AS n
                                                  UNION SELECT written_slug FROM content_nodes WHERE workspace_id = p_ws AND id = ANY(COALESCE(p_ids, '{}'))) x WHERE n IS NOT NULL;
  -- a note in the trash has its name (no unique slug among the trash)
  UPDATE content_nodes SET slug = written_slug WHERE workspace_id = p_ws AND id = ANY(COALESCE(p_ids, '{}')) AND deleted_at IS NOT NULL AND slug IS DISTINCT FROM written_slug;
  FOR r IN
    SELECT c.id, c.slug, c.written_slug AS w,
           row_number() OVER (PARTITION BY COALESCE(c.space_id, '00000000-0000-0000-0000-000000000000'::uuid), c.written_slug
                              ORDER BY COALESCE(cl.wall, 0), COALESCE(cl.counter, 0), cl.origin COLLATE "C" NULLS FIRST, COALESCE(cl.seq, 0), c.id::text COLLATE "C") AS rank
      FROM content_nodes c
      LEFT JOIN LATERAL (SELECT s.hlc_wall AS wall, s.hlc_counter AS counter, s.origin, s.seq FROM sync_stamps s
                          WHERE s.workspace_id = p_ws AND s.table_name = 'content_nodes' AND s.row_key = c.id::text AND s.field IN ('*', 'title', 'slug', 'deleted', 'space')
                          ORDER BY s.hlc_wall DESC, s.hlc_counter DESC, s.origin COLLATE "C" DESC, s.seq DESC LIMIT 1) cl ON true
     WHERE c.workspace_id = p_ws AND c.written_slug = ANY(COALESCE(v_names, '{}')) AND c.deleted_at IS NULL
  LOOP
    v_want := CASE WHEN r.rank = 1 THEN r.w ELSE r.w || '-' || split_part(r.id::text, '-', 1) END;
    IF r.slug IS DISTINCT FROM v_want THEN v_ids := v_ids || r.id; v_wants := v_wants || v_want; END IF;
  END LOOP;
  IF cardinality(v_ids) = 0 THEN PERFORM set_config('onden.slug_settle', '', true); RETURN; END IF;
  -- every note that changes lets go of its slug first, so none of them stands in another's way (a slug is unique among the live notes of a space)
  UPDATE content_nodes SET slug = '~' || id::text WHERE workspace_id = p_ws AND id = ANY(v_ids);
  FOR i IN 1 .. cardinality(v_ids) LOOP
    v_want := v_wants[i];
    -- a name taken by a note outside the group (only a title that is another note's `<name>-<eight>`): the whole id, which no other note's name is
    IF EXISTS (SELECT 1 FROM content_nodes o, content_nodes c WHERE c.id = v_ids[i] AND o.workspace_id = p_ws AND o.slug = v_want AND o.deleted_at IS NULL AND o.id <> c.id
                  AND COALESCE(o.space_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(c.space_id, '00000000-0000-0000-0000-000000000000'::uuid)) THEN
      v_want := (SELECT c.written_slug || '-' || c.id::text FROM content_nodes c WHERE c.id = v_ids[i]);
    END IF;
    UPDATE content_nodes SET slug = v_want WHERE workspace_id = p_ws AND id = v_ids[i];
  END LOOP;
  PERFORM set_config('onden.slug_settle', '', true);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION content_nodes_slug_group_left() RETURNS trigger AS $$
BEGIN
  IF sync_import_active(OLD.workspace_id) OR current_setting('onden.slug_settle', true) = 'on' OR OLD.written_slug IS NULL THEN RETURN NULL; END IF;
  -- a note that holds `~<id>` is in the middle of a move here (spine/noteSlugs.ts settleSlugs): its slug is given by that move, and the write that gives it comes here again
  IF TG_OP = 'UPDATE' AND left(NEW.slug, 1) = '~' THEN RETURN NULL; END IF;
  -- one probe of an index that holds only the notes that gave way (none on a single server); one that holds `~<id>` did not give way, it is being moved
  IF EXISTS (SELECT 1 FROM content_nodes c WHERE c.workspace_id = OLD.workspace_id AND c.written_slug = OLD.written_slug AND c.slug IS DISTINCT FROM c.written_slug
                AND left(c.slug, 1) <> '~') THEN
    PERFORM content_nodes_settle_slugs(OLD.workspace_id, '{}', ARRAY[OLD.written_slug]);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
-- named to run AFTER the stamp triggers of content_nodes (AFTER row triggers run in name order: `then` after `sync_stamp_*` and `tag_schema_*`), so the group is settled
-- with the claim this very write makes (review of PR #1992, round 1, point 4: before it, the writer settled with the old claim and the receiver with the new one)
CREATE OR REPLACE TRIGGER content_nodes_then_settle_slug_group AFTER UPDATE OF slug, written_slug, title, written_space_id, space_id, deleted_at ON content_nodes FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL) EXECUTE FUNCTION content_nodes_slug_group_left();
CREATE OR REPLACE TRIGGER content_nodes_then_settle_slug_group_delete AFTER DELETE ON content_nodes FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL) EXECUTE FUNCTION content_nodes_slug_group_left();

-- The unit `slug` (written_slug) in the stamp trigger of content_nodes: migration 218's three triggers with one field more.
CREATE OR REPLACE TRIGGER content_nodes_sync_stamp_insert AFTER INSERT ON content_nodes FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('content_nodes', 'id', 'workspace_id',
    'title=title,body=markdown,parent=parent_id,sort=order_key,hidden=hidden,space=written_space_id,deleted=deleted_at,slug=written_slug',
    'parent=parent_id,sort=order_key,space=space_id,deleted=deleted_at');
CREATE OR REPLACE TRIGGER content_nodes_sync_stamp_update AFTER UPDATE ON content_nodes FOR EACH ROW
  WHEN (OLD.title IS DISTINCT FROM NEW.title OR OLD.markdown IS DISTINCT FROM NEW.markdown
     OR OLD.parent_id IS DISTINCT FROM NEW.parent_id OR OLD.order_key IS DISTINCT FROM NEW.order_key
     OR OLD.hidden IS DISTINCT FROM NEW.hidden OR OLD.space_id IS DISTINCT FROM NEW.space_id
     OR OLD.written_space_id IS DISTINCT FROM NEW.written_space_id
     OR (OLD.deleted_at IS NULL) IS DISTINCT FROM (NEW.deleted_at IS NULL)
     OR OLD.written_slug IS DISTINCT FROM NEW.written_slug)
  EXECUTE FUNCTION sync_stamp_trigger('content_nodes', 'id', 'workspace_id',
    'title=title,body=markdown,parent=parent_id,sort=order_key,hidden=hidden,space=written_space_id,deleted=deleted_at,slug=written_slug',
    'parent=parent_id,sort=order_key,space=space_id,deleted=deleted_at');
CREATE OR REPLACE TRIGGER content_nodes_sync_stamp_delete AFTER DELETE ON content_nodes FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('content_nodes', 'id', 'workspace_id',
    'title=title,body=markdown,parent=parent_id,sort=order_key,hidden=hidden,space=written_space_id,deleted=deleted_at,slug=written_slug',
    'parent=parent_id,sort=order_key,space=space_id,deleted=deleted_at');

-- A note's `updated_at` (209): the slug's stamp is not an edit of the note (a move that has to take `-2`, a group settled again), as its position is not.
CREATE OR REPLACE FUNCTION sync_touch_updated_at(p_ws uuid, p_key text) RETURNS void AS $$
DECLARE v_wall bigint;
BEGIN
  SELECT max(w) INTO v_wall FROM (
    SELECT hlc_wall AS w FROM sync_stamps WHERE workspace_id = p_ws AND table_name IN ('content_nodes', 'content_nodes.tag_schema') AND row_key = p_key AND origin <> 'genesis' AND field NOT IN ('*', 'sort', 'slug') AND COALESCE(meta->>'quiet', '') <> 'true'
    UNION ALL SELECT hlc_wall FROM sync_stamp_heads WHERE workspace_id = p_ws AND table_name IN ('content_nodes', 'content_nodes.tag_schema') AND row_key = p_key AND origin <> 'genesis' AND field NOT IN ('*', 'sort', 'slug') AND COALESCE(meta->>'quiet', '') <> 'true') x;
  IF v_wall IS NOT NULL AND v_wall > 0 THEN
    UPDATE content_nodes SET updated_at = to_timestamp(v_wall / 1000.0) WHERE id = p_key::uuid AND workspace_id = p_ws AND updated_at IS DISTINCT FROM to_timestamp(v_wall / 1000.0);
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ... and the stamp write itself (206 sync_stamp_put_over, word for word but for 'slug' beside '*' and 'sort'): a slug's stamp does not even CALL it, so a note whose
-- `updated_at` was moved forward without a stamp (a board's or a canvas's own write) keeps it when a move gives it `-2` (review of PR #1992, round 1, point 1)
CREATE OR REPLACE FUNCTION sync_stamp_put_over(p_ws uuid, p_table text, p_key text, p_field text, p_deleted boolean, s jsonb, p_old text, p_old_known boolean, p_meta jsonb DEFAULT NULL) RETURNS void AS $$
DECLARE
  v_origin text := s->>'origin';
  v_seq bigint := (s->>'seq')::bigint;
  d record;
  h record;
  v_saw jsonb := '{}'::jsonb;
  v_meta jsonb;
  v_again boolean := false;
  v_prev_seen jsonb;
  v_quiet boolean := p_field <> '*' AND COALESCE(current_setting('onden.stamp_quiet', true), '') = 'on'; -- this write is housekeeping: it does not count for `updated_at`
BEGIN
  IF sync_import_active(p_ws) THEN RETURN; END IF;
  SELECT * INTO d FROM sync_stamps WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND field = p_field;
  IF FOUND THEN
    v_prev_seen := d.meta -> 'seen'; -- what a delete of this row had seen, carried by a creation that covers it
    IF d.origin = v_origin AND d.seq = v_seq THEN
      v_again := true; v_saw := d.saw; v_meta := d.meta; -- this transaction wrote the unit already: it has not seen itself
    ELSIF d.origin = 'genesis' THEN
      IF p_field = '*' THEN v_saw := jsonb_build_object('genesis:' || sync_genesis_hash('j:{}'), 0);
      ELSIF p_old_known THEN v_saw := jsonb_build_object('genesis:' || sync_genesis_hash(sync_content_text(p_old)), 0); END IF;
    ELSE
      v_saw := sync_saw_merge(d.saw, jsonb_build_object(d.origin, d.seq));
    END IF;
  ELSIF p_field <> '*' THEN
    -- no stamp of its own: the field was written together with its row and follows its creation
    SELECT * INTO d FROM sync_stamps WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND field = '*';
    IF FOUND AND NOT (d.origin = v_origin AND d.seq = v_seq) THEN
      IF d.origin = 'genesis' THEN
        IF p_old_known THEN v_saw := jsonb_build_object('genesis:' || sync_genesis_hash(sync_content_text(p_old)), 0); END IF;
      ELSE
        -- what the creation gives a field has no saw of its own (the creation's saw speaks about the creation unit, README "跟著 `*` 的欄位"), only its stamp:
        -- the same state sawOf of the core is given (src/test/stampSaw.integration.test.ts compares the two)
        v_saw := jsonb_build_object(d.origin, d.seq);
      END IF;
    END IF;
    -- the row's creation can have other heads (two nodes made the same derived id): the field follows each of them, so a person's write has seen all of them.
    -- They are the creation's heads, not this field's: they stay.
    FOR h IN SELECT * FROM sync_stamp_heads WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND field = '*' AND origin <> 'genesis' LOOP
      IF NOT (h.origin = v_origin AND h.seq = v_seq) THEN v_saw := sync_saw_merge(v_saw, jsonb_build_object(h.origin, h.seq)); END IF;
    END LOOP;
  END IF;
  -- a system job does not resolve a conflict nobody has looked at: its write has seen only the head the unit shows, and a `saw` cannot say that
  IF COALESCE(s->>'system', '') = 'true' AND NOT v_again
     AND EXISTS (SELECT 1 FROM sync_stamp_heads x WHERE x.workspace_id = p_ws AND x.table_name = p_table AND x.row_key = p_key AND x.field = p_field) THEN
    RAISE EXCEPTION 'sync_unit_in_conflict' USING ERRCODE = 'ON001';
  END IF;
  -- a write by this node has seen every head the unit had: they are replaced
  FOR h IN DELETE FROM sync_stamp_heads WHERE workspace_id = p_ws AND table_name = p_table AND row_key = p_key AND field = p_field RETURNING * LOOP
    IF h.origin = 'genesis' THEN v_saw := sync_saw_merge(v_saw, jsonb_build_object('genesis:' || h.content_hash, 0));
    ELSIF NOT (h.origin = v_origin AND h.seq = v_seq) THEN v_saw := sync_saw_merge(v_saw, sync_saw_merge(h.saw, jsonb_build_object(h.origin, h.seq)));
    END IF;
  END LOOP;
  IF p_meta IS NOT NULL THEN v_meta := p_meta;
  ELSIF NOT v_again AND p_table = 'content_nodes' AND p_field = 'parent' AND p_old_known THEN v_meta := jsonb_build_object('from', p_old);
  ELSIF NOT v_again AND p_field = '*' AND NOT p_deleted AND v_prev_seen IS NOT NULL THEN v_meta := jsonb_build_object('seen', v_prev_seen); END IF;
  IF v_quiet THEN v_meta := COALESCE(v_meta, '{}'::jsonb) || '{"quiet": true}'::jsonb;
  ELSIF v_meta ? 'quiet' THEN v_meta := NULLIF(v_meta - 'quiet', '{}'::jsonb); END IF;
  INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, author, device, deleted, saw, meta)
  VALUES (p_ws, p_table, p_key, p_field, v_origin, v_seq, (s->>'wall')::bigint, (s->>'counter')::int,
          s->>'author', NULLIF(s->>'device', '')::uuid, p_deleted, v_saw, v_meta)
  ON CONFLICT (workspace_id, table_name, row_key, field) DO UPDATE SET
    origin = EXCLUDED.origin, seq = EXCLUDED.seq, hlc_wall = EXCLUDED.hlc_wall, hlc_counter = EXCLUDED.hlc_counter,
    author = EXCLUDED.author, device = EXCLUDED.device, deleted = EXCLUDED.deleted, saw = EXCLUDED.saw, meta = EXCLUDED.meta;
  IF p_table = 'content_nodes' AND NOT p_deleted AND NOT v_quiet AND p_field NOT IN ('*', 'sort', 'slug') THEN PERFORM sync_touch_updated_at(p_ws, p_key); END IF;
END;
$$ LANGUAGE plpgsql;

