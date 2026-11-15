-- Remove x/y canvas position columns from content_nodes.
-- Position data lives in canvas JSONB (canvases.data.nodes[].x/y).
-- The All Cards global view uses physics-based auto-layout (no stored positions).
ALTER TABLE content_nodes DROP COLUMN IF EXISTS x;
ALTER TABLE content_nodes DROP COLUMN IF EXISTS y;
