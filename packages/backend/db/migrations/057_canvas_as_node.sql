-- D2: retire the `canvases` table — a canvas becomes a content_node
-- (node_type='canvas') and its layout lives fully on node_positions
-- (completing migration 050's "STAGE 2"). One mental model: a canvas is a
-- node like everything else — taggable, evented, soft-deletable, mergeable —
-- instead of a parallel entity with its own JSONB blob.
--
-- Where each piece of canvases.data goes:
--   • note cards ({nodeId,x,y,width,height,color,folded,subCanvasId})
--       → node_positions rows, surface = canvas node id. Re-backfilled here
--         because the Stage-1 dual-write was silently broken: the route
--         mapped ReactFlow's NESTED shape (data.nodeId/position.x) while the
--         frontend saves FLAT entries, so every canvas save since 050 wiped
--         the surface and inserted nothing.
--   • sections (visual grouping containers)
--       → node_attributes('_canvas_sections') on the canvas node, as JSON.
--   • edges → dropped: always saved as [] (the canvas renders the global
--         edge set filtered to on-canvas cards; no canvas-local edges exist).
--   • loose text/group cards (entries without nodeId) → dropped: the UI has
--         no way to create them; only test fixtures ever wrote them.

-- 1. Allow the new node kind.
ALTER TABLE content_nodes DROP CONSTRAINT IF EXISTS content_nodes_node_type_check;
ALTER TABLE content_nodes ADD CONSTRAINT content_nodes_node_type_check
  CHECK (node_type = ANY (ARRAY['content'::text, 'class_tag'::text, 'canvas'::text]));
COMMENT ON CONSTRAINT content_nodes_node_type_check ON content_nodes IS
  'Allowed kinds. content=regular note (may carry a view definition in its body); class_tag=tag-as-node (migration 037); canvas=spatial surface-as-node (migration 057, the retired canvases table). The 042 addition of base was rolled back — bases are presentational, not a distinct entity.';

-- 2. Every canvas becomes a node, keeping its id (node_positions.surface and
--    card subCanvasId references stay valid verbatim).
INSERT INTO content_nodes
  (id, workspace_id, source_type, node_type, title, slug, markdown, created_at, updated_at)
SELECT c.id, c.workspace_id, 'manual', 'canvas', c.title, 'canvas-' || c.id, '',
       c.created_at, c.updated_at
FROM canvases c
ON CONFLICT (id) DO NOTHING;

-- 3. Re-backfill card placements from the JSONB (fresher than node_positions,
--    see the broken-dual-write note above). Tolerates the legacy 'node_id'
--    spelling and skips dangling/non-uuid entries.
INSERT INTO node_positions
  (node_id, surface, x, y, width, height, color, folded, sub_canvas_id, workspace_id)
SELECT (COALESCE(e->>'nodeId', e->>'node_id'))::uuid,
       c.id::text,
       COALESCE((e->>'x')::float, 0), COALESCE((e->>'y')::float, 0),
       (e->>'width')::float, (e->>'height')::float,
       e->>'color',
       COALESCE((e->>'folded')::boolean, false),
       NULLIF(e->>'subCanvasId', '')::uuid,
       c.workspace_id
FROM canvases c
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(c.data->'nodes') = 'array' THEN c.data->'nodes' ELSE '[]'::jsonb END
) AS e
WHERE COALESCE(e->>'nodeId', e->>'node_id') ~ '^[0-9a-fA-F-]{36}$'
  AND EXISTS (SELECT 1 FROM content_nodes n
              WHERE n.id::text = COALESCE(e->>'nodeId', e->>'node_id'))
ON CONFLICT (node_id, surface) DO UPDATE
  SET x = EXCLUDED.x, y = EXCLUDED.y, width = EXCLUDED.width,
      height = EXCLUDED.height, color = EXCLUDED.color,
      folded = EXCLUDED.folded, sub_canvas_id = EXCLUDED.sub_canvas_id,
      updated_at = now();

-- 4. Sections move onto the canvas node as a layout attribute.
INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source)
SELECT c.workspace_id, c.id, '_canvas_sections', (c.data->'sections')::text, 'text', 'explicit'
FROM canvases c
WHERE jsonb_typeof(c.data->'sections') = 'array'
  AND jsonb_array_length(c.data->'sections') > 0
ON CONFLICT (node_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- 5. The parallel table is retired.
DROP TABLE canvases;
