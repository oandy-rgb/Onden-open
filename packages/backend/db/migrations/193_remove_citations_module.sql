-- 193: the Citations module is removed (owner 2026-11-12, docs/architecture/proposals/function-refs-b3-2026-11-12.md §7).
-- Importing papers by DOI or BibTeX, [@key] links and the BibTeX export are gone; the module tag (#論文) stops being a module.
--
-- Nothing a person wrote is deleted. What changes:
--   1. Every tag marked with the module (tag_schema.module = 'citations', live or in the trash) loses the mark and its
--      tag_schema.behaviour.modules.citations switch, so it is an ordinary tag of the person's: its notes, its fields and their
--      values stay as they are (attributes such as authors, doi, citekey are plain fields now).
--   2. A tag still named 'paper-review' (the internal name, never renamed) is renamed to the workspace's plain name: 論文 when
--      the workspace has any note or tag title with CJK characters, otherwise Paper (the server stores no interface language).
--      A tag renamed by the person is left alone, and so is one when its plain name is already taken by another live top-level
--      tag (the tag keeps its name; counted below).
--   3. A tag that was never changed (named paper-review, paper, 論文 or Paper; fields exactly the ones the module created; no
--      note, no block, no child tag, no tag extending it) goes to the trash through a NODE_DELETED event, so it can be restored
--      from history like any deleted tag.
--      Each tag that stays live (marked, renamed or only switch-cleared) gets a TAG_MODULES_MIGRATED event, and a tag sent to the trash
--      a NODE_DELETED one, so a client holding an older sync cursor re-reads it (as migration 083 does).
--   4. function_refs rows of function 'citations' are deleted (the function no longer exists); the module's id is dropped from
--      workspaces.modules_off / modules_confirmed.
--   5. The `cites` edges with origin 'citation' are deleted. They were derived from [@key] in note text by the module's hook and
--      nothing re-derives them now; left behind they would be arrows nobody can change (derived_edge, 409). The note text
--      itself is not touched: [@key] stays as written and reads as plain text.
-- Deletes data: only the derived edges of step 5 and the function_refs rows of step 4. Notes, tags (except the trash of step 3),
-- attributes and events are kept.
--
-- Safe to re-run: every step selects on what it removes (the mark, the rows, the id in the list).
-- Rolling back to an older backend: restore the pre-upgrade backup (migrations only go forward). Without it the older backend runs
-- on this data but sees the former module tags as plain tags, and the derived edges are rebuilt the next time a note's text is saved.
--
-- Read-only preview for the live database (counts only):
--   SELECT (SELECT count(*) FROM content_nodes WHERE node_type = 'class_tag' AND tag_schema->>'module' = 'citations') AS module_tags,
--          (SELECT count(*) FROM node_edges WHERE origin = 'citation') AS citation_edges,
--          (SELECT count(*) FROM function_refs WHERE function_id = 'citations') AS function_refs,
--          (SELECT count(*) FROM workspaces WHERE modules_off ? 'citations' OR modules_confirmed ? 'citations') AS workspace_lists;

DO $$
DECLARE
  r record;
  ev bigint;
  n_marks integer := 0;
  n_switches integer := 0;
  n_renamed integer := 0;
  n_rename_kept integer := 0;
  n_trashed integer := 0;
  n_refs integer := 0;
  n_edges integer := 0;
  n_lists integer := 0;
  plain_name text;
  paper_fields text[] := ARRAY['authors','venue','year','doi','arxiv_id','citekey','verdict','tldr','method','findings','limitations'];
BEGIN
  FOR r IN
    SELECT t.id, t.workspace_id, t.title, t.deleted_at,
           (t.deleted_at IS NULL AND lower(t.title) = 'paper-review') AS internal_name,
           (t.deleted_at IS NULL
             AND lower(t.title) IN ('paper-review', 'paper', '論文')
             AND ARRAY(SELECT f->>'name' FROM jsonb_array_elements(
                   CASE WHEN jsonb_typeof(t.tag_schema->'fields') = 'array' THEN t.tag_schema->'fields' ELSE '[]'::jsonb END) f) = paper_fields
             AND NOT EXISTS (SELECT 1 FROM node_tags nt WHERE nt.tag_id = t.id)
             AND NOT EXISTS (SELECT 1 FROM block_node_tags bt WHERE bt.tag_id = t.id)
             AND NOT EXISTS (SELECT 1 FROM content_nodes c WHERE c.parent_id = t.id)
             AND NOT EXISTS (SELECT 1 FROM content_nodes x
                              WHERE x.workspace_id = t.workspace_id AND x.node_type = 'class_tag'
                                AND jsonb_typeof(x.tag_schema->'extends') = 'array'
                                AND x.tag_schema->'extends' ? t.id::text)) AS untouched
      FROM content_nodes t
     WHERE t.node_type = 'class_tag' AND t.tag_schema->>'module' = 'citations'
     ORDER BY t.workspace_id, t.created_at, t.id
       FOR UPDATE OF t
  LOOP
    UPDATE content_nodes
       SET tag_schema = CASE
             WHEN jsonb_typeof(tag_schema->'behaviour'->'modules') = 'object' AND (tag_schema->'behaviour'->'modules') ? 'citations'
               THEN jsonb_set(tag_schema - 'module', '{behaviour,modules}', (tag_schema->'behaviour'->'modules') - 'citations')
             ELSE tag_schema - 'module' END,
           updated_at = now()
     WHERE id = r.id;
    n_marks := n_marks + 1;

    IF r.untouched THEN
      INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta)
      VALUES (r.workspace_id, 'system', 'migration:193', 'NODE_DELETED', 'node', r.id::text,
              jsonb_build_object('title', r.title),
              jsonb_build_object('inverse_op', 'node.undeleted', 'ui_context', 'migration.remove_citations_module'))
      RETURNING id INTO ev;
      UPDATE content_nodes SET deleted_at = now(), deleted_by_event_id = ev, updated_at = now() WHERE id = r.id;
      n_trashed := n_trashed + 1;
    ELSIF r.internal_name THEN
      plain_name := CASE WHEN EXISTS (SELECT 1 FROM content_nodes k
                                       WHERE k.workspace_id = r.workspace_id AND k.deleted_at IS NULL
                                         AND k.title ~ '[㐀-鿿]') THEN '論文' ELSE 'Paper' END;
      IF EXISTS (SELECT 1 FROM content_nodes o
                  WHERE o.workspace_id = r.workspace_id AND o.node_type = 'class_tag' AND o.deleted_at IS NULL
                    AND o.parent_id IS NOT DISTINCT FROM (SELECT p.parent_id FROM content_nodes p WHERE p.id = r.id)
                    AND o.title = plain_name AND o.id <> r.id) THEN
        n_rename_kept := n_rename_kept + 1;
      ELSE
        UPDATE content_nodes SET title = plain_name, updated_at = now() WHERE id = r.id;
        n_renamed := n_renamed + 1;
      END IF;
    END IF;

    -- A tag that stays (mark removed, maybe renamed): sync clients holding an older cursor learn of it from a tag event.
    IF NOT r.untouched AND r.deleted_at IS NULL THEN
      INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta)
      VALUES (r.workspace_id, 'system', 'migration:193', 'TAG_MODULES_MIGRATED', 'tag', r.id::text,
              jsonb_build_object('migration', '193_remove_citations_module'),
              jsonb_build_object('ui_context', 'migration.remove_citations_module'));
    END IF;
  END LOOP;

  -- Tags that carried the switch without being the module tag (tag-level on/off of the removed function).
  WITH cleared AS (
    UPDATE content_nodes
       SET tag_schema = jsonb_set(tag_schema, '{behaviour,modules}', (tag_schema->'behaviour'->'modules') - 'citations'),
           updated_at = now()
     WHERE node_type = 'class_tag'
       AND jsonb_typeof(tag_schema->'behaviour'->'modules') = 'object' AND (tag_schema->'behaviour'->'modules') ? 'citations'
    RETURNING id, workspace_id, deleted_at
  ), ev AS (
    INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta)
    SELECT workspace_id, 'system', 'migration:193', 'TAG_MODULES_MIGRATED', 'tag', id::text,
           jsonb_build_object('migration', '193_remove_citations_module'),
           jsonb_build_object('ui_context', 'migration.remove_citations_module')
      FROM cleared WHERE deleted_at IS NULL
    RETURNING 1
  )
  SELECT count(*) INTO n_switches FROM cleared;

  DELETE FROM function_refs WHERE function_id = 'citations';
  GET DIAGNOSTICS n_refs = ROW_COUNT;

  DELETE FROM node_edges WHERE origin = 'citation';
  GET DIAGNOSTICS n_edges = ROW_COUNT;

  UPDATE workspaces
     SET modules_off = COALESCE((SELECT jsonb_agg(v) FROM jsonb_array_elements(modules_off) v WHERE v <> '"citations"'::jsonb), '[]'::jsonb),
         modules_confirmed = CASE WHEN jsonb_typeof(modules_confirmed) = 'array'
           THEN COALESCE((SELECT jsonb_agg(v) FROM jsonb_array_elements(modules_confirmed) v WHERE v <> '"citations"'::jsonb), '[]'::jsonb)
           ELSE modules_confirmed END
   WHERE (jsonb_typeof(modules_off) = 'array' AND modules_off ? 'citations')
      OR (jsonb_typeof(modules_confirmed) = 'array' AND modules_confirmed ? 'citations');
  GET DIAGNOSTICS n_lists = ROW_COUNT;

  RAISE NOTICE '[193] citations removed: % module tag(s) made ordinary (% renamed to a plain name, % kept their name because the plain name was taken, % unused and unchanged -> trash), % tag switch(es) cleared, % function reference(s) and % derived citation edge(s) deleted, % workspace list(s) cleaned',
    n_marks, n_renamed, n_rename_kept, n_trashed, n_switches, n_refs, n_edges, n_lists;
END $$;
