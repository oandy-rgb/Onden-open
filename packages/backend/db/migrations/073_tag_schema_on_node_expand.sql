-- 073_tag_schema_on_node_expand.sql  (P4.1 collection_schemas → node, EXPAND phase)
--
-- collection_schemas is the last parallel table carrying a class_tag's domain
-- semantics: a class_tag node links to it via content_nodes.tag_schema_id, and
-- the schema (fields / policy / behaviour / template_children / views / …) lives
-- off-node. Every authorization read (dispatcher/permissions, readPolicy) and
-- every dispatch / default / template path JOINs it back in. The end state folds
-- the schema onto the class_tag node itself.
--
-- This is the EXPAND step of expand-migrate-contract (the same shape migration
-- 037 used to fold tags into content_nodes): add a shadow `tag_schema` jsonb
-- column on content_nodes, backfill it, and keep it in sync with collection_schemas
-- via triggers BOTH WAYS. Nothing reads tag_schema yet — this changes no behaviour,
-- it just makes the data available on the node so the MIGRATE step can switch reads
-- one site at a time, with collection_schemas still authoritative until CONTRACT.
--
-- name/slug are intentionally NOT mirrored: those are the tag node's own
-- title/slug. tag_schema holds only the schema-specific bits.

ALTER TABLE public.content_nodes ADD COLUMN IF NOT EXISTS tag_schema jsonb;

-- Single source of the shadow shape, shared by the backfill and both triggers so
-- they can't drift. Pure function of the collection_schemas row.
CREATE OR REPLACE FUNCTION public.tag_schema_json(cs public.collection_schemas)
RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'fields', cs.fields,
    'policy', cs.policy,
    'behaviour', cs.behaviour,
    'template_children', cs.template_children,
    'views', cs.views,
    'block_template', cs.block_template,
    'description', cs.description,
    'version', cs.version,
    'dependencies', to_jsonb(cs.dependencies)
  );
$$;

-- Backfill existing class_tag nodes.
UPDATE public.content_nodes n
   SET tag_schema = public.tag_schema_json(cs)
  FROM public.collection_schemas cs
 WHERE cs.id = n.tag_schema_id;

-- Sync 1: a collection_schemas write mirrors onto the node(s) that reference it.
-- (On a fresh schema INSERT no node references it yet — the node-side trigger
-- below pulls it in when the class_tag is created with this tag_schema_id.)
CREATE OR REPLACE FUNCTION public.sync_tag_schema_from_cs() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.content_nodes
     SET tag_schema = public.tag_schema_json(NEW)
   WHERE tag_schema_id = NEW.id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS cs_sync_tag_schema ON public.collection_schemas;
CREATE TRIGGER cs_sync_tag_schema
  AFTER INSERT OR UPDATE ON public.collection_schemas
  FOR EACH ROW EXECUTE FUNCTION public.sync_tag_schema_from_cs();

-- Sync 2: setting/changing a node's tag_schema_id pulls the schema onto the row.
CREATE OR REPLACE FUNCTION public.pull_tag_schema_into_node() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tag_schema_id IS NOT NULL THEN
    SELECT public.tag_schema_json(cs) INTO NEW.tag_schema
      FROM public.collection_schemas cs WHERE cs.id = NEW.tag_schema_id;
  ELSE
    NEW.tag_schema := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS node_pull_tag_schema ON public.content_nodes;
CREATE TRIGGER node_pull_tag_schema
  BEFORE INSERT OR UPDATE OF tag_schema_id ON public.content_nodes
  FOR EACH ROW EXECUTE FUNCTION public.pull_tag_schema_into_node();
