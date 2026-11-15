-- Undo migration 138 (docs/architecture/canvas-as-view.md): the notes it turned
-- from node_type 'canvas' into plain notes with a whiteboard tab become
-- node_type 'canvas' again.
--
--   psql "$DATABASE_URL" -1 -f packages/backend/scripts/restoreCanvasNotes.sql
--
-- Only rows of canvas_note_conversions that are not restored yet and are still
-- node_type 'content' are touched. Per row: the whiteboard view the migration
-- added is removed (or the one it changed is put back as it was), every other
-- view stays, and collection_views goes back to NULL if it was NULL and is
-- empty again. Cards, sections, edges, ink, children, tags and every edit made
-- since stay as they are; domain_events is not touched. Run it with the app
-- stopped or at least after deploying a backend from before 138: a backend
-- that serves 138 shows a node_type 'canvas' note as a whiteboard note either way.
-- Prints the ids it restored.

WITH todo AS (
  SELECT c.node_id, c.added_view_id, c.prev_view, c.prev_collection_views, n.collection_views
    FROM canvas_note_conversions c
    JOIN content_nodes n ON n.id = c.node_id AND n.node_type = 'content'
   WHERE c.restored_at IS NULL
     FOR UPDATE OF n
), fixed AS (
  SELECT t.node_id, t.prev_collection_views,
         COALESCE((SELECT jsonb_agg(CASE WHEN t.prev_view IS NOT NULL AND e->>'id' = t.prev_view->>'id' THEN t.prev_view ELSE e END ORDER BY ord)
                     FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.collection_views) = 'array' THEN t.collection_views ELSE '[]'::jsonb END)
                          WITH ORDINALITY AS x(e, ord)
                    WHERE t.added_view_id IS NULL OR e->>'id' <> t.added_view_id), '[]'::jsonb) AS views
    FROM todo t
), restored AS (
  UPDATE content_nodes n
     SET node_type = 'canvas',
         collection_views = CASE WHEN f.views = '[]'::jsonb AND f.prev_collection_views IS NULL THEN NULL ELSE f.views END
    FROM fixed f
   WHERE n.id = f.node_id
  RETURNING n.id
)
UPDATE canvas_note_conversions c
   SET restored_at = now()
  FROM restored r
 WHERE c.node_id = r.id
RETURNING c.node_id AS restored_id;
