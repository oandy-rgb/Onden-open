-- Undo migration 139 (docs/architecture/canvas-as-view.md「白板複本併回原筆記」):
-- the whiteboard copies it folded into their original note come back.
--
--   psql "$DATABASE_URL" -1 -f packages/backend/scripts/restoreFoldedBoards.sql
--
-- Only rows of board_copy_folds that are not restored yet are touched. Per row:
--   * the copy B leaves the trash if it is still deleted by the fold's own delete
--     (a copy already restored by hand stays as it is);
--   * the cards that moved to S's board and are still there go back to B; the
--     cards the fold dropped (S's own card, a card S already had) are put back on
--     B (a card already on B is left);
--   * the sections go back to B if they are still S's row of the fold and B has none;
--   * the whiteboard tab the fold added to S is removed (or the canvas view it
--     changed is put back as it was); other views stay, and collection_views goes
--     back to NULL if it was NULL and is empty again.
-- Edits made since (S's text, its other views, cards placed on S's board after
-- the fold) stay. Events are written (NODE_UNDELETED on B, CANVAS_UPDATED on both,
-- a view event on S) so devices that are open see it with their next sync.
-- restored_at is filled, so it runs once. Prints the ids it restored.
--
-- Migration 141 also moved the original out from under its copy before folding
-- it (board_copy_unparents). After the folds are undone, such an original goes
-- back under its copy, at its old position, if it is still at the top level where
-- 141 put it and the copy is back (a NODE_UPDATED event, like a move).

DO $restore$
DECLARE
  f record;
  fixed jsonb;
  moved_back int;
BEGIN
  FOR f IN
    SELECT * FROM board_copy_folds WHERE restored_at IS NULL ORDER BY node_id FOR UPDATE
  LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM content_nodes WHERE id = f.node_id)
               OR NOT EXISTS (SELECT 1 FROM content_nodes WHERE id = f.folded_into);

    UPDATE content_nodes SET deleted_at = NULL, deleted_by_event_id = NULL, updated_at = now()
     WHERE id = f.node_id AND deleted_at IS NOT NULL AND deleted_by_event_id = f.delete_event_id;
    IF FOUND THEN
      INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta)
      VALUES (f.workspace_id, 'system', 'migration:139', 'NODE_UNDELETED', 'node', f.node_id::text,
              jsonb_build_object('title', (SELECT title FROM content_nodes WHERE id = f.node_id)),
              jsonb_build_object('inverse_op', 'node.deleted', 'ui_context', 'migration.fold_board_copy.restore'));
    END IF;

    WITH m AS (
      UPDATE node_positions p SET surface = f.node_id::text
       WHERE p.surface = f.folded_into::text AND p.node_id = ANY(f.moved_card_ids::uuid[])
         AND NOT EXISTS (SELECT 1 FROM node_positions q WHERE q.surface = f.node_id::text AND q.node_id = p.node_id)
      RETURNING 1
    ) SELECT count(*) INTO moved_back FROM m;
    INSERT INTO node_positions (node_id, surface, x, y, width, height, color, folded, sub_canvas_id, workspace_id, updated_at)
    SELECT (c->>'node_id')::uuid, c->>'surface', (c->>'x')::double precision, (c->>'y')::double precision,
           (c->>'width')::double precision, (c->>'height')::double precision, c->>'color',
           (c->>'folded')::boolean, (c->>'sub_canvas_id')::uuid, (c->>'workspace_id')::uuid, (c->>'updated_at')::timestamptz
      FROM jsonb_array_elements(f.dropped_cards) c
     WHERE EXISTS (SELECT 1 FROM content_nodes n WHERE n.id = (c->>'node_id')::uuid)
    ON CONFLICT (node_id, surface) DO NOTHING;

    IF f.moved_sections_id IS NOT NULL THEN
      UPDATE node_attributes SET node_id = f.node_id
       WHERE id = f.moved_sections_id AND node_id = f.folded_into
         AND NOT EXISTS (SELECT 1 FROM node_attributes WHERE node_id = f.node_id AND key = '_canvas_sections');
    END IF;

    SELECT COALESCE((SELECT jsonb_agg(CASE WHEN f.prev_view IS NOT NULL AND e->>'id' = f.prev_view->>'id' THEN f.prev_view ELSE e END ORDER BY ord)
                       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(n.collection_views) = 'array' THEN n.collection_views ELSE '[]'::jsonb END)
                            WITH ORDINALITY AS x(e, ord)
                      WHERE f.added_view_id IS NULL OR e->>'id' <> f.added_view_id), '[]'::jsonb)
      INTO fixed FROM content_nodes n WHERE n.id = f.folded_into;
    UPDATE content_nodes
       SET collection_views = CASE WHEN fixed = '[]'::jsonb AND f.prev_collection_views IS NULL THEN NULL ELSE fixed END
     WHERE id = f.folded_into;

    INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta)
    VALUES (f.workspace_id, 'system', 'migration:139',
            CASE WHEN f.added_view_id IS NULL THEN 'COLLECTION_VIEW_UPDATED' ELSE 'COLLECTION_VIEW_DELETED' END,
            'node', f.folded_into::text,
            jsonb_build_object('node_id', f.folded_into, 'view_id', COALESCE(f.added_view_id, f.prev_view->>'id'), 'layout', 'canvas'),
            jsonb_build_object('ui_context', 'migration.fold_board_copy.restore'));
    INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta)
    SELECT f.workspace_id, 'system', 'migration:139', 'CANVAS_UPDATED', 'canvas', id::text,
           jsonb_build_object('fields', jsonb_build_array('layout'), 'cards', jsonb_build_object('upserted', moved_back, 'removed', moved_back),
                              'sections', jsonb_build_object('upserted', 0, 'removed', 0)),
           jsonb_build_object('ui_context', 'migration.fold_board_copy.restore')
      FROM unnest(ARRAY[f.node_id, f.folded_into]) AS id;

    UPDATE board_copy_folds SET restored_at = now() WHERE node_id = f.node_id;
    RAISE NOTICE 'restored %', f.node_id;
  END LOOP;
END
$restore$;

DO $unparent_restore$
DECLARE
  u record;
  cur_sort integer;
BEGIN
  IF to_regclass('board_copy_unparents') IS NULL THEN RETURN; END IF;
  FOR u IN
    SELECT * FROM board_copy_unparents WHERE restored_at IS NULL ORDER BY node_id FOR UPDATE
  LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM content_nodes WHERE id = u.node_id AND parent_id IS NULL AND deleted_at IS NULL)
               OR NOT EXISTS (SELECT 1 FROM content_nodes WHERE id = u.prev_parent_id AND deleted_at IS NULL);
    SELECT sort_order INTO cur_sort FROM content_nodes WHERE id = u.node_id;
    INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta)
    VALUES (u.workspace_id, 'system', 'migration:141', 'NODE_UPDATED', 'node', u.node_id::text,
            jsonb_build_object('title', (SELECT title FROM content_nodes WHERE id = u.node_id),
                               'parent_id', u.prev_parent_id, 'sort_order', u.prev_sort_order),
            jsonb_build_object('inverse_patch', NULL,
                               'prev_field_values', jsonb_build_object('parent_id', NULL, 'sort_order', cur_sort),
                               'ui_context', 'migration.fold_board_copy.restore'));
    UPDATE content_nodes SET parent_id = u.prev_parent_id, sort_order = u.prev_sort_order WHERE id = u.node_id;
    UPDATE board_copy_unparents SET restored_at = now() WHERE node_id = u.node_id;
    RAISE NOTICE 'moved back under its copy %', u.node_id;
  END LOOP;
END
$unparent_restore$;
