-- 138: the whiteboard is a way of looking at a note, not a kind of note.
--
-- Until now a board was a content_node of node_type 'canvas' (migration 057).
-- Notes got their own "白板" tab in the row of view tabs (content | whiteboard |
-- table …), so a board is now any note's view: its cards are node_positions with
-- the note's own id as surface, its section frames the note's '_canvas_sections'
-- attribute, and the tab is a saved view of layout "canvas" in the note's
-- collection_views (services/noteViews.ts). A note that was a board keeps
-- everything it had and gets that tab, set to open first.
--
-- Per node_type='canvas' row (live and trashed alike):
--   * node_type 'canvas' → 'content'. id, title, slug (`canvas-<id>`, so old
--     links keep working), markdown, parent, space, hidden, sort order, tags,
--     attributes, children, edges, backlinks, history: not touched.
--   * node_positions, the sections attribute, ink (node_attributes 'ink_data' of
--     the cards), edges: not touched — they are keyed by node ids, and the
--     board's id is the note's id.
--   * collection_views gets a canvas view {name 'Canvas', layout_config
--     {"opens_first": true}}. If the row already had a canvas view (its tab was
--     renamed, moved or hidden while it was still a board), that view is kept,
--     un-hidden, and marked opens_first; its original is saved below.
--   * updated_at is not changed, and no domain_events row is written, changed or
--     deleted. Clients that still hold the row as 'canvas' keep working: the
--     frontend reads either, and /api/canvases and /api/boards serve both.
--
-- canvas_note_conversions records each converted id (and what the row's views were),
-- so the conversion can be undone. Undo, in one transaction (also kept as
-- packages/backend/scripts/restoreCanvasNotes.sql — run it with psql -1):
--
--   see the file; in short, for every row of canvas_note_conversions with
--   restored_at IS NULL whose node is still node_type 'content': node_type back to
--   'canvas', the view this migration added removed (or the one it changed put
--   back as it was), collection_views back to NULL if it was and is empty again,
--   and restored_at set. Views, cards and edits made since stay.
--
-- Counts the restore drill compares: notes_live / notes_deleted go up and
-- canvases_live / canvases_deleted go down by the same number (new counts
-- whiteboards_live, whiteboards_deleted and board_cards in drillInvariants.ts
-- show that no board and no card was lost).
-- drill: allows notes_live, notes_deleted, canvases_live, canvases_deleted
-- Idempotent: a second run finds no node_type 'canvas' row.

CREATE TABLE IF NOT EXISTS canvas_note_conversions (
  node_id               uuid PRIMARY KEY REFERENCES content_nodes(id) ON DELETE CASCADE,
  workspace_id          uuid NOT NULL,
  -- The canvas view this migration added (null when the row already had one).
  added_view_id         text,
  -- The canvas view the row already had, as it was (null when none).
  prev_view             jsonb,
  -- The row's collection_views before, whole (NULL stays NULL).
  prev_collection_views jsonb,
  converted_at          timestamptz NOT NULL DEFAULT now(),
  restored_at           timestamptz
);
COMMENT ON TABLE canvas_note_conversions IS
  'Notes that were node_type canvas before migration 138 turned the whiteboard into a view of a note. Kept so the conversion can be undone (scripts/restoreCanvasNotes.sql).';

WITH boards AS (
  SELECT n.id, n.workspace_id, n.collection_views,
         (SELECT v FROM jsonb_array_elements(
                    CASE WHEN jsonb_typeof(n.collection_views) = 'array' THEN n.collection_views ELSE '[]'::jsonb END) v
           WHERE v->>'layout' = 'canvas' LIMIT 1) AS existing,
         gen_random_uuid()::text AS new_view_id
    FROM content_nodes n
   WHERE n.node_type = 'canvas'
     FOR UPDATE
), recorded AS (
  INSERT INTO canvas_note_conversions (node_id, workspace_id, added_view_id, prev_view, prev_collection_views)
  SELECT b.id, b.workspace_id,
         CASE WHEN b.existing IS NULL THEN b.new_view_id END,
         b.existing, b.collection_views
    FROM boards b
  ON CONFLICT (node_id) DO NOTHING
  RETURNING node_id
)
UPDATE content_nodes n
   SET node_type = 'content',
       collection_views = CASE
         WHEN b.existing IS NULL THEN
           COALESCE(CASE WHEN jsonb_typeof(n.collection_views) = 'array' THEN n.collection_views END, '[]'::jsonb)
           || jsonb_build_array(jsonb_build_object(
                'id', b.new_view_id, 'node_id', n.id, 'name', 'Canvas', 'layout', 'canvas',
                'filters', '[]'::jsonb, 'sorts', '[]'::jsonb, 'group_by', NULL, 'visible_fields', '[]'::jsonb,
                'layout_config', jsonb_build_object('opens_first', true),
                'pin_order', 0, 'created_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'updated_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
         ELSE
           (SELECT jsonb_agg(CASE WHEN e->>'id' = b.existing->>'id'
                                  THEN jsonb_set(e, '{layout_config}', (COALESCE(e->'layout_config', '{}'::jsonb) - 'hidden') || '{"opens_first": true}'::jsonb)
                                  ELSE e END ORDER BY ord)
              FROM jsonb_array_elements(n.collection_views) WITH ORDINALITY AS t(e, ord))
       END
  FROM boards b JOIN recorded r ON r.node_id = b.id
 WHERE n.id = b.id;
