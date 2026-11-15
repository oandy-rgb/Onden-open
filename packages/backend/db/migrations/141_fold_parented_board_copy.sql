-- 141: fold a whiteboard copy whose only child is the note it copied.
--
-- Migration 139 folded the copies "make a board from the sub-notes" left behind
-- into the note they copied (S), but only a copy B with no child. On the owner's
-- workspace one copy had a child by the time 139 ran: S itself had been put
-- under B (the sidebar listed S under B as a card, and moving it there made it a
-- real child). 139 rightly left that B alone. This migration handles exactly that
-- case and nothing else:
--
--   * B meets every condition of 139 except "no child", B is at the top level,
--     and B's only child — trashed ones included — is S (same title, a card on
--     B's board, the one other alive note with that title);
--   * S goes back to the top level, in B's place among the top-level notes
--     (parent_id null, B's sort_order). A NODE_UPDATED event records the move
--     with its previous parent and position (prev_field_values), as a move from
--     the app does, so open devices see it with their next sync and it can be
--     undone like any move. board_copy_unparents keeps what was changed;
--   * then B is folded into S exactly as 139 does it (the same statement, actor
--     'migration:141'), recorded in board_copy_folds.
--
-- Undo: packages/backend/scripts/restoreFoldedBoards.sql (psql -1) restores the
-- fold, then puts S back under B if it is still where this migration put it.
--
-- drill: allows notes_live, notes_deleted, whiteboards_live, whiteboards_deleted, board_cards, notes_gone
-- Idempotent: S is no longer B's child after the first run, and B is folded.

CREATE TABLE IF NOT EXISTS board_copy_unparents (
  node_id          uuid PRIMARY KEY REFERENCES content_nodes(id) ON DELETE CASCADE,
  copy_id          uuid NOT NULL,
  workspace_id     uuid NOT NULL,
  prev_parent_id   uuid NOT NULL,
  prev_sort_order  integer NOT NULL,
  event_id         bigint NOT NULL,
  unparented_at    timestamptz NOT NULL DEFAULT now(),
  restored_at      timestamptz
);
COMMENT ON TABLE board_copy_unparents IS
  'Notes migration 141 moved out from under their whiteboard copy before folding it (board_copy_folds). Kept so restoreFoldedBoards.sql can put them back.';

DO $unparent$
DECLARE
  r record;
  ev bigint;
BEGIN
  FOR r IN
    SELECT b.id AS b_id, s.id AS s_id, b.workspace_id, b.title, b.sort_order AS b_sort, s.sort_order AS s_sort
      FROM canvas_note_conversions c
      JOIN content_nodes b ON b.id = c.node_id AND b.node_type = 'content' AND b.deleted_at IS NULL AND b.parent_id IS NULL
      JOIN content_nodes s ON s.workspace_id = b.workspace_id AND s.id <> b.id AND s.title = b.title
                          AND s.node_type = 'content' AND s.deleted_at IS NULL AND s.parent_id = b.id
     WHERE c.restored_at IS NULL
       AND btrim(b.markdown) = ''
       AND (SELECT count(*) FROM content_nodes x
             WHERE x.workspace_id = b.workspace_id AND x.deleted_at IS NULL AND x.title = b.title AND x.id <> b.id) = 1
       AND EXISTS (SELECT 1 FROM node_positions p WHERE p.surface = b.id::text AND p.node_id = s.id)
       AND (SELECT count(*) FROM content_nodes ch WHERE ch.parent_id = b.id) = 1
       AND NOT EXISTS (SELECT 1 FROM node_tags t WHERE t.node_id = b.id)
       AND NOT EXISTS (SELECT 1 FROM node_attributes a WHERE a.node_id = b.id AND a.key <> '_canvas_sections')
       AND NOT EXISTS (SELECT 1 FROM node_edges e WHERE e.source_node_id = b.id OR e.target_node_id = b.id)
       AND NOT EXISTS (SELECT 1 FROM note_pointers np WHERE np.parent_id = b.id OR np.target_id = b.id)
       AND NOT EXISTS (SELECT 1 FROM node_positions p WHERE p.node_id = b.id OR p.sub_canvas_id = b.id)
       AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.home_node_id = b.id)
     ORDER BY b.id
       FOR UPDATE OF b, s
  LOOP
    INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta)
    VALUES (r.workspace_id, 'system', 'migration:141', 'NODE_UPDATED', 'node', r.s_id::text,
            jsonb_build_object('title', r.title, 'parent_id', NULL, 'sort_order', r.b_sort),
            jsonb_build_object('inverse_patch', NULL,
                               'prev_field_values', jsonb_build_object('parent_id', r.b_id, 'sort_order', r.s_sort),
                               'ui_context', 'migration.fold_board_copy'))
    RETURNING id INTO ev;
    UPDATE content_nodes SET parent_id = NULL, sort_order = r.b_sort WHERE id = r.s_id;
    INSERT INTO board_copy_unparents (node_id, copy_id, workspace_id, prev_parent_id, prev_sort_order, event_id)
    VALUES (r.s_id, r.b_id, r.workspace_id, r.b_id, r.s_sort, ev);
  END LOOP;
END
$unparent$;

DO $fold$
DECLARE
  r record;
  b_cards jsonb;
  moved text[];
  dropped jsonb;
  attr_id uuid;
  s_views jsonb;
  existing jsonb;
  new_view_id text;
  del_id bigint;
  now_txt text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  FOR r IN
    SELECT b.id AS b_id, s.id AS s_id, b.workspace_id, b.title
      FROM canvas_note_conversions c
      JOIN content_nodes b ON b.id = c.node_id AND b.node_type = 'content' AND b.deleted_at IS NULL
      JOIN content_nodes s ON s.workspace_id = b.workspace_id AND s.id <> b.id AND s.title = b.title
                          AND s.node_type = 'content' AND s.deleted_at IS NULL
     WHERE c.restored_at IS NULL
       AND btrim(b.markdown) = ''
       AND (SELECT count(*) FROM content_nodes x
             WHERE x.workspace_id = b.workspace_id AND x.deleted_at IS NULL AND x.title = b.title AND x.id <> b.id) = 1
       AND EXISTS (SELECT 1 FROM node_positions p WHERE p.surface = b.id::text AND p.node_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM content_nodes ch WHERE ch.parent_id = b.id)
       AND NOT EXISTS (SELECT 1 FROM node_tags t WHERE t.node_id = b.id)
       AND NOT EXISTS (SELECT 1 FROM node_attributes a WHERE a.node_id = b.id AND a.key <> '_canvas_sections')
       AND NOT EXISTS (SELECT 1 FROM node_edges e WHERE e.source_node_id = b.id OR e.target_node_id = b.id)
       AND NOT EXISTS (SELECT 1 FROM note_pointers np WHERE np.parent_id = b.id OR np.target_id = b.id)
       AND NOT EXISTS (SELECT 1 FROM node_positions p WHERE p.node_id = b.id OR p.sub_canvas_id = b.id)
       AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.home_node_id = b.id)
     ORDER BY b.id
       FOR UPDATE OF b, s
  LOOP
    SELECT COALESCE(jsonb_agg(to_jsonb(p)), '[]'::jsonb) INTO b_cards
      FROM node_positions p WHERE p.surface = r.b_id::text;

    -- B's cards to S, except S itself and a card S already has.
    WITH m AS (
      UPDATE node_positions p SET surface = r.s_id::text
       WHERE p.surface = r.b_id::text AND p.node_id <> r.s_id
         AND NOT EXISTS (SELECT 1 FROM node_positions q WHERE q.surface = r.s_id::text AND q.node_id = p.node_id)
      RETURNING p.node_id
    ) SELECT COALESCE(array_agg(node_id::text), '{}') INTO moved FROM m;
    WITH d AS (DELETE FROM node_positions p WHERE p.surface = r.b_id::text RETURNING to_jsonb(p) AS card)
      SELECT COALESCE(jsonb_agg(card), '[]'::jsonb) INTO dropped FROM d;

    -- Sections follow the cards when S has none of its own.
    attr_id := NULL;
    IF NOT EXISTS (SELECT 1 FROM node_attributes WHERE node_id = r.s_id AND key = '_canvas_sections') THEN
      UPDATE node_attributes SET node_id = r.s_id
       WHERE node_id = r.b_id AND key = '_canvas_sections'
      RETURNING id INTO attr_id;
    END IF;

    -- S's whiteboard tab.
    SELECT collection_views INTO s_views FROM content_nodes WHERE id = r.s_id;
    SELECT v INTO existing
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s_views) = 'array' THEN s_views ELSE '[]'::jsonb END) v
     WHERE v->>'layout' = 'canvas' LIMIT 1;
    new_view_id := gen_random_uuid()::text;
    IF existing IS NULL THEN
      UPDATE content_nodes SET collection_views =
        COALESCE(CASE WHEN jsonb_typeof(collection_views) = 'array' THEN collection_views END, '[]'::jsonb)
        || jsonb_build_array(jsonb_build_object(
             'id', new_view_id, 'node_id', id, 'name', 'Canvas', 'layout', 'canvas',
             'filters', '[]'::jsonb, 'sorts', '[]'::jsonb, 'group_by', NULL, 'visible_fields', '[]'::jsonb,
             'layout_config', '{}'::jsonb, 'pin_order', 0, 'created_at', now_txt, 'updated_at', now_txt))
       WHERE id = r.s_id;
    ELSE
      new_view_id := NULL;
      UPDATE content_nodes SET collection_views = (
        SELECT jsonb_agg(CASE WHEN e->>'id' = existing->>'id'
                              THEN jsonb_set(e, '{layout_config}', COALESCE(e->'layout_config', '{}'::jsonb) - 'hidden')
                              ELSE e END ORDER BY ord)
          FROM jsonb_array_elements(collection_views) WITH ORDINALITY AS t(e, ord))
       WHERE id = r.s_id;
    END IF;

    -- B goes to the trash, as a delete does it.
    INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta)
    VALUES (r.workspace_id, 'system', 'migration:141', 'NODE_DELETED', 'node', r.b_id::text,
            jsonb_build_object('title', r.title, 'folded_into', r.s_id),
            jsonb_build_object('inverse_op', 'node.undeleted', 'ui_context', 'migration.fold_board_copy'))
    RETURNING id INTO del_id;
    UPDATE content_nodes SET deleted_at = now(), deleted_by_event_id = del_id, updated_at = now() WHERE id = r.b_id;

    -- What S's readers see change: its tab, and its board (cards, sections).
    INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta)
    VALUES (r.workspace_id, 'system', 'migration:141',
            CASE WHEN existing IS NULL THEN 'COLLECTION_VIEW_CREATED' ELSE 'COLLECTION_VIEW_UPDATED' END,
            'node', r.s_id::text,
            jsonb_build_object('node_id', r.s_id, 'view_id', COALESCE(new_view_id, existing->>'id'),
                               'name', COALESCE(existing->>'name', 'Canvas'), 'layout', 'canvas'),
            jsonb_build_object('ui_context', 'migration.fold_board_copy'));
    INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta)
    VALUES (r.workspace_id, 'system', 'migration:141', 'CANVAS_UPDATED', 'canvas', r.s_id::text,
            jsonb_build_object('fields', jsonb_build_array('layout'),
                               'cards', jsonb_build_object('upserted', COALESCE(array_length(moved, 1), 0), 'removed', 0),
                               'sections', jsonb_build_object('upserted', CASE WHEN attr_id IS NULL THEN 0 ELSE 1 END, 'removed', 0)),
            jsonb_build_object('ui_context', 'migration.fold_board_copy'));

    INSERT INTO board_copy_folds (node_id, folded_into, workspace_id, b_cards, moved_card_ids, dropped_cards,
                                  moved_sections_id, added_view_id, prev_view, prev_collection_views, delete_event_id)
    VALUES (r.b_id, r.s_id, r.workspace_id, b_cards, moved, dropped, attr_id, new_view_id, existing, s_views, del_id);
  END LOOP;
END
$fold$;
