-- Freeze existing capability identity once. Future tag names do not enable
-- modules. The previous reading UI recognized only schema-less #toread;
-- #review enrollment accepted both label and schema tags. Preserve that set.
-- Progress and membership remain unchanged.
-- A schema created only for modules must not enter the legacy public collection
-- list or acquire a name-based template identity. Existing schemas keep both.
-- This is a migration baseline, not an owner-requested reversible schema edit;
-- the event exists to refresh
-- held tag/member projections on clients resuming an existing sync cursor.
WITH candidates AS (
  SELECT id, workspace_id, title, slug, tag_schema,
         CASE WHEN title='review' THEN 'review' ELSE 'read_later' END AS module
    FROM content_nodes
   WHERE node_type='class_tag' AND deleted_at IS NULL
     AND (title='review' OR (title='toread' AND tag_schema IS NULL))
), configured AS (
  SELECT *, COALESCE(tag_schema, jsonb_build_object(
    'name',title,'slug','module-' || id::text,'publish_collection',false,'fields','[]'::jsonb,'views','{}'::jsonb,
    'policy','{}'::jsonb,'behaviour','{}'::jsonb,'template_children','[]'::jsonb,
    'block_template','[]'::jsonb,'description','','version','1.0.0','dependencies','[]'::jsonb
  )) AS schema_value
  FROM candidates
  WHERE NOT COALESCE(tag_schema->'behaviour'->'modules', '{}'::jsonb) ? module
), updated AS (
  UPDATE content_nodes n
     SET tag_schema=jsonb_set(c.schema_value, '{behaviour}',
       COALESCE(c.schema_value->'behaviour','{}'::jsonb) || jsonb_build_object('modules',
         COALESCE(c.schema_value->'behaviour'->'modules','{}'::jsonb) ||
         jsonb_build_object(c.module,jsonb_build_object('enabled',true)))),
         updated_at=now()
    FROM configured c WHERE n.id=c.id
  RETURNING n.id, n.workspace_id
)
INSERT INTO domain_events(workspace_id,actor_type,actor_id,event_type,target_type,target_id,payload,tx_meta)
SELECT workspace_id,'system','migration:083','TAG_MODULES_MIGRATED','tag',id::text,
       jsonb_build_object('migration','083_tag_module_bindings'),
       jsonb_build_object('ui_context','migration.tag_modules')
  FROM updated;
