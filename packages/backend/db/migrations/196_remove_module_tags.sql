-- 196: the module tag nodes go (docs/architecture/proposals/function-refs-b3-2026-11-12.md §4 item 5, owner 2026-11-12).
-- A function (review, tasks, a view) no longer needs a hidden tag node to exist; tasks moved in 191, saved views in 188,
-- review in 195. What is left of those tags is a definition row nobody reads.
--
-- A tag is a "module tag" when tag_schema.module is set. For every one in a workspace, EXCEPT the two modules that still read
-- their tag (listed in the NOTICE, left exactly as they are):
--   skills   (「當成技能」 is a membership of the skills tag; moving it to a note reference is a later batch)
--   capture  (the inbox: its notes are found through the 收件匣 tag until the inbox is a personal reference, part 2)
-- a LIVE tag that nobody changed goes to the trash through a NODE_DELETED event (inverse_op node.undeleted), so it can be
-- restored from history. Its node_tags / block_node_tags rows stay where they are: they are what a restore brings back, and a
-- tag in the trash lists nothing.
-- A tag is "changed" — and then stays, listed in the NOTICE — when any of these is so:
--   renamed (not the default name), a body, a colour (the app's default grey #888888 is not one), a description, fields of its own, behaviour settings other than the module
--   switches (review's scheduler settings live there), saved views, child tags, tags it extends, a reserved key, a person's own settings
--   for it (actor_module_settings), or notes / paragraphs carrying it that are not what the module itself put there (every module
--   but review: any membership means somebody tagged it; for review the members are the cards migration 195 already gave their own
--   reference). A view tag (table, kanban, calendar, gallery) that stays loses its module mark and the module switches in its
--   behaviour: it is an ordinary tag of the person's. A review or tasks tag that stays keeps its mark, because the scheduler
--   settings of review (request_retention, maximum_interval_days) and the renamed task word are still read from it until part 2 re-keys them by function.
--   A tag already in the trash is left as it is (counted).
-- Then, for the removed tags:
--   * a tag that extended one of them loses that entry in tag_schema.extends (nothing is inherited from a module tag: it has no
--     fields), and gets a TAG_MODULES_MIGRATED event; the tag ids are listed in the NOTICE;
--   * function_refs rows of tags whose settings source (config.source_tag_id) is a removed tag are deleted (until this migration moved
--     the source tag to the trash they were valid: a reference whose source is not a live tag provides nothing, so they would
--     provide nothing from now on anyway).
-- Deletes data: only the dangling references of the last step. Notes, tags (except the trash above), memberships, schedules and
-- events are kept.
-- Undoing a tag's NODE_DELETED from History brings that tag back from the trash (its notes are still on it), but NOT the `extends` entry
-- that was taken out of other tags, and NOT the references deleted in the last step: those are not part of the undo. A restored module
-- tag therefore does not give its function back; use the function chooser on the tag.
--
-- Safe to re-run: a trashed tag is not selected again, the extends entries are gone, the dangling references are deleted.
-- Rolling back to an older backend: restore the pre-upgrade backup (migrations only go forward). Without it the older backend runs
-- on this data and makes the missing module tags again the next time a module is turned on.
--
-- Read-only preview for the live database (counts and flags only, never a title or text; one row per module tag: every reason
-- this migration uses to keep it, then what will happen to it). Run before upgrading; src/test/removeModuleTagsMigration.integration.test.ts
-- runs this exact text and checks the `will_happen` column against what the migration really does.
--   WITH m AS (
--     SELECT t.id, t.workspace_id, t.tag_schema->>'module' AS module, (t.deleted_at IS NULL) AS live,
--            t.tag_schema->>'module' IN ('skills', 'capture') AS still_read,
--            NOT (lower(t.title) = ANY (CASE t.tag_schema->>'module'
--                   WHEN 'review' THEN ARRAY['review', '複習'] WHEN 'tasks' THEN ARRAY['task', '任務']
--                   WHEN 'table' THEN ARRAY['table', '表格'] WHEN 'kanban' THEN ARRAY['kanban', '看板']
--                   WHEN 'calendar' THEN ARRAY['calendar', '月曆'] WHEN 'gallery' THEN ARRAY['gallery', '卡片']
--                   ELSE ARRAY[lower(t.tag_schema->>'module')] END)) AS renamed,
--            btrim(COALESCE(t.markdown, '')) <> '' AS has_body,
--            (t.tag_color IS NOT NULL AND t.tag_color <> '#888888') AS has_colour,
--            btrim(COALESCE(t.tag_schema->>'description', '')) <> '' AS has_description,
--            COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(t.tag_schema->'fields') = 'array' THEN t.tag_schema->'fields' END), 0) > 0 AS has_fields,
--            COALESCE(jsonb_typeof(t.tag_schema->'behaviour') = 'object' AND (t.tag_schema->'behaviour') - 'modules' <> '{}'::jsonb, false) AS has_behaviour_settings,
--            (COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(t.collection_views) = 'array' THEN t.collection_views END), 0) > 0
--               OR EXISTS (SELECT 1 FROM function_refs v WHERE v.holder_node_id = t.id AND v.instance <> '')) AS has_saved_views,
--            (SELECT count(*) FROM content_nodes c WHERE c.parent_id = t.id AND c.deleted_at IS NULL) AS child_tags,
--            COALESCE(jsonb_typeof(t.tag_schema->'extends') = 'array' AND jsonb_array_length(t.tag_schema->'extends') > 0, false) AS extends_something,
--            (t.reserved_key IS NOT NULL) AS has_reserved_key,
--            (SELECT count(*) FROM actor_module_settings s WHERE s.tag_id = t.id) AS personal_settings,
--            (SELECT count(*) FROM node_tags nt WHERE nt.tag_id = t.id) AS notes,
--            (SELECT count(*) FROM block_node_tags bt WHERE bt.tag_id = t.id) AS paragraphs,
--            (SELECT count(*) FROM content_nodes x WHERE x.node_type = 'class_tag' AND jsonb_typeof(x.tag_schema->'extends') = 'array'
--                AND x.tag_schema->'extends' ? t.id::text) AS tags_extending_it
--       FROM content_nodes t
--      WHERE t.node_type = 'class_tag' AND jsonb_typeof(t.tag_schema->'module') = 'string'
--   ), r AS (
--     SELECT m.*, (module <> 'review' AND notes + paragraphs > 0) AS members_count,
--            (renamed OR has_body OR has_colour OR has_description OR has_fields OR has_behaviour_settings OR has_saved_views OR child_tags > 0
--              OR extends_something OR has_reserved_key OR personal_settings > 0 OR (module <> 'review' AND notes + paragraphs > 0)) AS changed
--       FROM m)
--   SELECT id, workspace_id, module, NOT live AS in_trash, renamed, has_body, has_colour, has_description, has_fields, has_behaviour_settings,
--          has_saved_views, child_tags, extends_something, has_reserved_key, personal_settings, notes, paragraphs, members_count, tags_extending_it,
--          CASE WHEN still_read THEN 'untouched (still read)' WHEN NOT live THEN 'untouched (already in the trash)'
--               WHEN NOT changed THEN 'trash' WHEN module IN ('table', 'kanban', 'calendar', 'gallery') THEN 'keep (loses the module mark)'
--               ELSE 'keep' END AS will_happen
--     FROM r ORDER BY module, workspace_id, id;
-- drill: allows tags_live, tags_deleted

DO $$
DECLARE
  rec record;
  ev bigint;
  n_total integer; n_trashed integer; n_stripped integer; n_kept integer; n_in_trash integer; n_left integer;
  n_extends integer; n_refs integer;
  removed_ids text; kept_list text; left_list text; extends_ids text;
BEGIN
  CREATE TEMP TABLE m196_tags ON COMMIT DROP AS
  SELECT t.id, t.workspace_id, t.title, t.tag_schema->>'module' AS module, (t.deleted_at IS NULL) AS live,
         ARRAY_REMOVE(ARRAY[
           CASE WHEN NOT (lower(t.title) = ANY (CASE t.tag_schema->>'module'
                  WHEN 'review' THEN ARRAY['review', '複習'] WHEN 'tasks' THEN ARRAY['task', '任務']
                  WHEN 'table' THEN ARRAY['table', '表格'] WHEN 'kanban' THEN ARRAY['kanban', '看板']
                  WHEN 'calendar' THEN ARRAY['calendar', '月曆'] WHEN 'gallery' THEN ARRAY['gallery', '卡片']
                  ELSE ARRAY[lower(t.tag_schema->>'module')] END)) THEN 'renamed' END,
           CASE WHEN btrim(COALESCE(t.markdown, '')) <> '' THEN 'body' END,
           CASE WHEN t.tag_color IS NOT NULL AND t.tag_color <> '#888888' THEN 'colour' END,
           CASE WHEN btrim(COALESCE(t.tag_schema->>'description', '')) <> '' THEN 'description' END,
           CASE WHEN COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(t.tag_schema->'fields') = 'array' THEN t.tag_schema->'fields' END), 0) > 0 THEN 'fields' END,
           CASE WHEN jsonb_typeof(t.tag_schema->'behaviour') = 'object' AND (t.tag_schema->'behaviour') - 'modules' <> '{}'::jsonb THEN 'settings' END,
           CASE WHEN COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(t.collection_views) = 'array' THEN t.collection_views END), 0) > 0
                  OR EXISTS (SELECT 1 FROM function_refs v WHERE v.holder_node_id = t.id AND v.instance <> '') THEN 'views' END,
           CASE WHEN EXISTS (SELECT 1 FROM content_nodes c WHERE c.parent_id = t.id AND c.deleted_at IS NULL) THEN 'child tags' END,
           CASE WHEN jsonb_typeof(t.tag_schema->'extends') = 'array' AND jsonb_array_length(t.tag_schema->'extends') > 0 THEN 'extends' END,
           CASE WHEN t.reserved_key IS NOT NULL THEN 'reserved' END,
           CASE WHEN EXISTS (SELECT 1 FROM actor_module_settings s WHERE s.tag_id = t.id) THEN 'personal settings' END,
           CASE WHEN t.tag_schema->>'module' <> 'review'
                 AND (EXISTS (SELECT 1 FROM node_tags nt WHERE nt.tag_id = t.id)
                      OR EXISTS (SELECT 1 FROM block_node_tags bt WHERE bt.tag_id = t.id)) THEN 'members' END
         ], NULL) AS reasons
    FROM content_nodes t
   WHERE t.node_type = 'class_tag' AND jsonb_typeof(t.tag_schema->'module') = 'string'
     AND t.tag_schema->>'module' NOT IN ('skills', 'capture');

  SELECT count(*) INTO n_total FROM m196_tags;
  SELECT count(*) INTO n_in_trash FROM m196_tags WHERE NOT live;
  SELECT count(*) INTO n_left FROM content_nodes t WHERE t.node_type = 'class_tag' AND t.deleted_at IS NULL AND t.tag_schema->>'module' IN ('skills', 'capture');
  SELECT string_agg(t.tag_schema->>'module' || ' ' || t.id::text, ', ' ORDER BY t.id) INTO left_list
    FROM content_nodes t WHERE t.node_type = 'class_tag' AND t.deleted_at IS NULL AND t.tag_schema->>'module' IN ('skills', 'capture');

  n_trashed := 0;
  FOR rec IN SELECT * FROM m196_tags WHERE live AND cardinality(reasons) = 0 ORDER BY workspace_id, id LOOP
    INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta)
    VALUES (rec.workspace_id, 'system', 'migration:196', 'NODE_DELETED', 'node', rec.id::text,
            jsonb_build_object('title', rec.title),
            jsonb_build_object('inverse_op', 'node.undeleted', 'ui_context', 'migration.remove_module_tags'))
    RETURNING id INTO ev;
    UPDATE content_nodes SET deleted_at = now(), deleted_by_event_id = ev, updated_at = now() WHERE id = rec.id AND deleted_at IS NULL;
    n_trashed := n_trashed + 1;
  END LOOP;
  SELECT string_agg(id::text, ', ' ORDER BY id) INTO removed_ids FROM m196_tags WHERE live AND cardinality(reasons) = 0;

  -- A view tag that stays is an ordinary tag now.
  WITH stripped AS (
    UPDATE content_nodes n
       SET tag_schema = CASE
             WHEN jsonb_typeof(n.tag_schema->'behaviour'->'modules') = 'object'
               THEN jsonb_set(n.tag_schema - 'module', '{behaviour,modules}',
                      (n.tag_schema->'behaviour'->'modules') - 'table' - 'kanban' - 'calendar' - 'gallery')
             ELSE n.tag_schema - 'module' END,
           updated_at = now()
      FROM m196_tags m
     WHERE n.id = m.id AND m.live AND cardinality(m.reasons) > 0 AND m.module IN ('table', 'kanban', 'calendar', 'gallery')
    RETURNING n.id, n.workspace_id
  ), ev2 AS (
    INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta)
    SELECT workspace_id, 'system', 'migration:196', 'TAG_MODULES_MIGRATED', 'tag', id::text,
           jsonb_build_object('migration', '196_remove_module_tags'), jsonb_build_object('ui_context', 'migration.remove_module_tags')
      FROM stripped
    RETURNING 1
  ) SELECT count(*) INTO n_stripped FROM stripped;

  SELECT count(*), string_agg(m.module || ' ' || m.id::text || ' [' || array_to_string(m.reasons, ', ') || ']', '; ' ORDER BY m.module, m.id)
    INTO n_kept, kept_list FROM m196_tags m WHERE m.live AND cardinality(m.reasons) > 0;

  -- Tags that extended a removed tag lose that entry.
  WITH removed AS (SELECT id::text AS id FROM m196_tags WHERE live AND cardinality(reasons) = 0),
  changed AS (
    UPDATE content_nodes t
       SET tag_schema = jsonb_set(t.tag_schema, '{extends}', COALESCE((
             SELECT jsonb_agg(e) FROM jsonb_array_elements(t.tag_schema->'extends') e
              WHERE NOT (e #>> '{}' IN (SELECT id FROM removed))), '[]'::jsonb)),
           updated_at = now()
     WHERE t.node_type = 'class_tag' AND jsonb_typeof(t.tag_schema->'extends') = 'array'
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.tag_schema->'extends') e WHERE e #>> '{}' IN (SELECT id FROM removed))
    RETURNING t.id, t.workspace_id, t.deleted_at
  ), ev3 AS (
    INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta)
    SELECT workspace_id, 'system', 'migration:196', 'TAG_MODULES_MIGRATED', 'tag', id::text,
           jsonb_build_object('migration', '196_remove_module_tags'), jsonb_build_object('ui_context', 'migration.remove_module_tags')
      FROM changed WHERE deleted_at IS NULL
    RETURNING 1
  ) SELECT count(*), string_agg(id::text, ', ' ORDER BY id) INTO n_extends, extends_ids FROM changed;

  WITH d AS (
    DELETE FROM function_refs r
     WHERE r.holder_node_id IS NOT NULL AND r.instance = '' AND r.config ? 'source_tag_id'
       AND r.config->>'source_tag_id' IN (SELECT id::text FROM m196_tags WHERE live AND cardinality(reasons) = 0)
    RETURNING 1
  ) SELECT count(*) INTO n_refs FROM d;

  RAISE NOTICE '[196] module tags: % found (% already in the trash, left as they are)', n_total, n_in_trash;
  RAISE NOTICE '[196] moved to the trash (unchanged): %; ids: %', n_trashed, COALESCE(removed_ids, 'none');
  RAISE NOTICE '[196] kept because a person changed them (view tags lose the module mark: %): % ; %', n_stripped, n_kept, COALESCE(kept_list, 'none');
  RAISE NOTICE '[196] left in place on purpose (skills and the inbox still read their tag): % ; %', n_left, COALESCE(left_list, 'none');
  RAISE NOTICE '[196] tags that extended a removed tag lost that entry: % ; %; dangling function references deleted: %', n_extends, COALESCE(extends_ids, 'none'), n_refs;
END $$;
