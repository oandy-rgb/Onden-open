-- 139: fold the whiteboard copies "make a board from the sub-notes" left behind
-- back into the note they copied.
--
-- The old "從子筆記建立白板" made a new canvas node with the note's title
-- (createCanvas(selectedNode.title)) and put the note's whole subtree on it —
-- the note itself included. Migration 138 turned that canvas into a plain note,
-- so the workspace now holds two notes with one title: the real one (S) and the
-- copy (B), where S is a card on B's board. The whiteboard is a tab of S now
-- (docs/architecture/canvas-as-view.md), so the copy has no reason to exist.
--
-- B is folded only when it is certainly such a copy (anything else is left
-- exactly as it is):
--   * B is in canvas_note_conversions (it was a board), not restored, and alive;
--   * exactly one other alive note S in the workspace has B's title, S is a plain
--     note (not a tag) and a card on B's board (node_positions surface B, node S);
--   * B has blank text, no child (trashed ones too), no tag, no attribute but
--     '_canvas_sections', no link (edges, pointers), is not a card anywhere, is
--     not the target of a card's sub-board link and is not the workspace's home.
--
-- Per copy B and original S, in the transaction of the migration:
--   * B's cards move to S's board (node_positions.surface B → S, position, size,
--     colour and fold kept). S's own card on B's board is dropped — a note's
--     board does not hold the note — and a card S already has stays as S had it.
--   * B's sections ('_canvas_sections') move to S when S has none.
--   * S gets a whiteboard tab (not opens_first: S opens on its text as before).
--     A canvas view S already has is kept and un-hidden.
--   * B is soft-deleted the way a delete does it (deleted_at, deleted_by_event_id,
--     updated_at), so it can be restored from the trash/history. Nothing is
--     deleted for good; the dropped cards are kept in the record below.
--   * Events, so a device that is already open sees it with its next sync, with
--     no reset or reinstall (docs/architecture/sync-protocol.md: the domain event
--     log is the one sync mechanism; a delta re-ships the node a node event
--     targets, with the board memberships touching it, and a NODE_DELETED is a
--     delete there even for a copy the device still holds as node_type 'canvas'):
--       NODE_DELETED on B; COLLECTION_VIEW_CREATED / _UPDATED and CANVAS_UPDATED on S.
--     Actor: system 'migration:139' (as migration 083 does).
--
-- board_copy_folds records, per fold, what moved: B's cards (all, as they were),
-- the cards moved and the ones dropped, whether the sections moved, the view
-- added (or the one changed), S's views before, and the delete event. Undo, in
-- one transaction (psql -1): packages/backend/scripts/restoreFoldedBoards.sql.
--
-- Counts the restore drill compares: notes_live down / notes_deleted up and
-- whiteboards_deleted up by the number of folds (and notes_gone: each copy leaves
-- the live set); board_cards down by the cards dropped (S's own card, or a card S
-- already had). whiteboards_live is declared too: it stays when S had no tab (B
-- leaves, S joins) and drops by one per fold when S had one. board_cards_not_self
-- (drillInvariants.ts: cards without a note's own card on its own board) is NOT
-- declared, so it must stay equal — only the self cards were dropped.
-- drill: allows notes_live, notes_deleted, whiteboards_live, whiteboards_deleted, board_cards, notes_gone
-- Idempotent: a folded B is deleted, so a second run finds no candidate.

CREATE TABLE IF NOT EXISTS board_copy_folds (
  node_id             uuid PRIMARY KEY REFERENCES content_nodes(id) ON DELETE CASCADE,
  folded_into         uuid NOT NULL,
  workspace_id        uuid NOT NULL,
  -- Every card B had (node_positions rows, whole), the ids moved to S, the rows dropped.
  b_cards             jsonb NOT NULL,
  moved_card_ids      text[] NOT NULL,
  dropped_cards       jsonb NOT NULL,
  -- node_attributes.id of B's sections when they moved to S.
  moved_sections_id   uuid,
  -- The canvas view added to S (null when S had one) and the one S had, as it was.
  added_view_id       text,
  prev_view           jsonb,
  -- S's collection_views before, whole (NULL stays NULL).
  prev_collection_views jsonb,
  delete_event_id     bigint NOT NULL,
  folded_at           timestamptz NOT NULL DEFAULT now(),
  restored_at         timestamptz
);
COMMENT ON TABLE board_copy_folds IS
  'Whiteboard copies (boards made from sub-notes) folded back into the original note by migration 139. Kept so the fold can be undone (scripts/restoreFoldedBoards.sql).';

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
    VALUES (r.workspace_id, 'system', 'migration:139', 'NODE_DELETED', 'node', r.b_id::text,
            jsonb_build_object('title', r.title, 'folded_into', r.s_id),
            jsonb_build_object('inverse_op', 'node.undeleted', 'ui_context', 'migration.fold_board_copy'))
    RETURNING id INTO del_id;
    UPDATE content_nodes SET deleted_at = now(), deleted_by_event_id = del_id, updated_at = now() WHERE id = r.b_id;

    -- What S's readers see change: its tab, and its board (cards, sections).
    INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta)
    VALUES (r.workspace_id, 'system', 'migration:139',
            CASE WHEN existing IS NULL THEN 'COLLECTION_VIEW_CREATED' ELSE 'COLLECTION_VIEW_UPDATED' END,
            'node', r.s_id::text,
            jsonb_build_object('node_id', r.s_id, 'view_id', COALESCE(new_view_id, existing->>'id'),
                               'name', COALESCE(existing->>'name', 'Canvas'), 'layout', 'canvas'),
            jsonb_build_object('ui_context', 'migration.fold_board_copy'));
    INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta)
    VALUES (r.workspace_id, 'system', 'migration:139', 'CANVAS_UPDATED', 'canvas', r.s_id::text,
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
