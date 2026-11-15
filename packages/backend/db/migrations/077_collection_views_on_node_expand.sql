-- 077_collection_views_on_node_expand.sql  (P4.1 batch 2: collection_views → node, EXPAND)
--
-- collection_views is the last parallel table carrying a class_tag's domain data:
-- N saved views per tag (filters / sorts / group_by / layout / visible_fields /
-- layout_config / pin_order), FK tag_id -> content_nodes(id). Unlike the schema
-- (1:1, folded to tag_schema), this is 1-to-many, so it folds onto the node as a
-- jsonb ARRAY: content_nodes.collection_views = [ {id, name, layout, …}, … ].
--
-- EXPAND (mirrors 073): add the shadow array column, backfill it, and keep it in
-- sync from the table via a trigger that rebuilds the affected tag's array on any
-- view INSERT/UPDATE/DELETE. Nothing reads collection_views (the column) yet — the
-- table stays authoritative until CONTRACT. The MIGRATE step switches reads onto
-- the node one site at a time.

ALTER TABLE public.content_nodes ADD COLUMN IF NOT EXISTS collection_views jsonb;

-- Canonical array shape for a tag's views — the exact element shape GET
-- /:tagId/views returns, ordered the same way (pin_order, then name). Single
-- source shared by the backfill and the trigger so they can't drift.
CREATE OR REPLACE FUNCTION public.collection_views_json(p_tag_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'id', cv.id,
             'tag_id', cv.tag_id,
             'name', cv.name,
             'layout', cv.layout,
             'filters', cv.filters,
             'sorts', cv.sorts,
             'group_by', cv.group_by,
             'visible_fields', cv.visible_fields,
             'layout_config', cv.layout_config,
             'pin_order', cv.pin_order,
             'created_at', cv.created_at,
             'updated_at', cv.updated_at
           ) ORDER BY cv.pin_order ASC, cv.name ASC
         ), '[]'::jsonb)
  FROM public.collection_views cv
  WHERE cv.tag_id = p_tag_id;
$$;

-- Backfill class_tag nodes that own at least one view.
UPDATE public.content_nodes n
   SET collection_views = public.collection_views_json(n.id)
 WHERE n.node_type = 'class_tag'
   AND EXISTS (SELECT 1 FROM public.collection_views cv WHERE cv.tag_id = n.id);

-- Sync: any view INSERT/UPDATE/DELETE rebuilds the owning tag's array (whole-array
-- rebuild keeps pin/name ordering correct without per-element surgery). On the last
-- view's delete the builder yields '[]'.
CREATE OR REPLACE FUNCTION public.sync_collection_views_to_node() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE t uuid;
BEGIN
  t := COALESCE(NEW.tag_id, OLD.tag_id);
  UPDATE public.content_nodes SET collection_views = public.collection_views_json(t) WHERE id = t;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS cv_sync_to_node ON public.collection_views;
CREATE TRIGGER cv_sync_to_node
  AFTER INSERT OR UPDATE OR DELETE ON public.collection_views
  FOR EACH ROW EXECUTE FUNCTION public.sync_collection_views_to_node();
