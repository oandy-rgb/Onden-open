-- 050: node_positions — one home for a node's spatial placement on a surface.
--
-- Consolidates the fragmented position storage (canvas card positions lived in
-- canvases.data jsonb; global-graph positions were written to `_graph_x/y`
-- node ATTRIBUTES — a path the attribute API actually REJECTS, so graph layout
-- silently never persisted). This is the Heptabase "placement" shape: a node's
-- position is per-(node, surface), not on the node and not a per-canvas blob.
--
--   surface = a canvas id (uuid as text)  |  'graph'  (the global force-graph)
--
-- A node on N canvases has N rows. ON DELETE CASCADE on node_id drops a node's
-- placements with it; canvas deletion cleans its surface rows in the route.
--
-- STAGE 1 (this migration + backend): the table is backfilled from existing
-- canvases.data and kept current by a dual-write on canvas save, while the
-- frontend still reads canvases.data (no behaviour change yet). STAGE 2 cuts
-- the frontend over to read/write node_positions and drops the broken `_graph_x`
-- attribute path. (The deeper canvas=node + edges-carry-data unification is
-- rebuild-foundation work; this placement table is forward-compatible — when a
-- canvas becomes a node, `surface` simply becomes that node's id.)

CREATE TABLE IF NOT EXISTS node_positions (
  node_id       uuid NOT NULL REFERENCES content_nodes(id) ON DELETE CASCADE,
  surface       text NOT NULL,            -- canvas id (uuid text) | 'graph'
  x             double precision NOT NULL,
  y             double precision NOT NULL,
  width         double precision,
  height        double precision,
  color         text,
  folded        boolean NOT NULL DEFAULT false,
  sub_canvas_id uuid,
  workspace_id  uuid NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, surface)
);

CREATE INDEX IF NOT EXISTS node_positions_surface ON node_positions (surface);
CREATE INDEX IF NOT EXISTS node_positions_ws      ON node_positions (workspace_id);

-- Backfill canvas card positions from canvases.data.nodes[]. Skips entries
-- whose node was deleted (dangling card) so the FK can't abort the migration.
INSERT INTO node_positions (node_id, surface, x, y, width, height, color, folded, sub_canvas_id, workspace_id)
SELECT (e->>'nodeId')::uuid,
       c.id::text,
       COALESCE((e->>'x')::float, 0),
       COALESCE((e->>'y')::float, 0),
       (e->>'width')::float,
       (e->>'height')::float,
       e->>'color',
       COALESCE((e->>'folded')::boolean, false),
       NULLIF(e->>'subCanvasId', '')::uuid,
       c.workspace_id
FROM canvases c
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c.data->'nodes', '[]'::jsonb)) AS e
WHERE e ? 'nodeId'
  AND EXISTS (SELECT 1 FROM content_nodes n WHERE n.id = (e->>'nodeId')::uuid)
ON CONFLICT (node_id, surface) DO NOTHING;
