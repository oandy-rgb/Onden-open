-- 074_tag_schema_name_slug.sql  (P4.1 collection_schemas → node, EXPAND addendum)
--
-- 073's tag_schema shadow deliberately skipped name/slug, reasoning they were the
-- tag node's own title/slug. They're NOT always the same: a collection_schemas row
-- has its OWN name/slug (e.g. an imported tag-pack schema, or templateExpander's
-- use of cs.slug as the template root). The read sites that need them
-- (templateExpander, services/collections, publishing) therefore can't switch onto
-- the shadow until it carries them.
--
-- Add name + slug to the shared builder (so the triggers mirror them going forward)
-- and re-backfill existing rows. No schema change, just the function + a backfill.

CREATE OR REPLACE FUNCTION public.tag_schema_json(cs public.collection_schemas)
RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'name', cs.name,
    'slug', cs.slug,
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

-- Re-backfill: 073 populated tag_schema without name/slug.
UPDATE public.content_nodes n
   SET tag_schema = public.tag_schema_json(cs)
  FROM public.collection_schemas cs
 WHERE cs.id = n.tag_schema_id;
