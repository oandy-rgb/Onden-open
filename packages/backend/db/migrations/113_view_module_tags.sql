-- View modules as tags (docs/architecture/views-as-modules.md, V4), 2026-10-18:
-- a tag extends the module tag of every layout its saved views use (#表格,
-- #看板, #月曆, #卡片); services/viewModules.ts keeps that up to date as views
-- are added and deleted. This backfills the views saved before:
--  1. each workspace gets the module tag of every layout one of its tags
--     uses — an unused unmarked top-level tag of that name (no notes, child
--     tags, fields or views) is adopted, as ensureModuleTag does; otherwise a
--     new private one is created, named "<name>檢視" when the user's own tag
--     of that name is in use (it keeps its notes);
--  2. each tag with views extends those module tags (other extends kept).
-- A view module tag's own views are left alone (it cannot extend itself).
-- Repeatable.

CREATE TEMP TABLE view_module_names (layout text PRIMARY KEY, name text NOT NULL) ON COMMIT DROP;
INSERT INTO view_module_names VALUES ('table', '表格'), ('kanban', '看板'), ('calendar', '月曆'), ('gallery', '卡片');

CREATE TEMP TABLE view_layouts_used ON COMMIT DROP AS
SELECT DISTINCT t.workspace_id, t.id AS tag_id,
       CASE WHEN v->>'layout' = 'list' THEN 'table' ELSE v->>'layout' END AS layout
  FROM content_nodes t, jsonb_array_elements(t.collection_views) v
 WHERE t.node_type = 'class_tag' AND t.deleted_at IS NULL
   AND jsonb_typeof(t.collection_views) = 'array'
   AND COALESCE(t.tag_schema->>'module', '') NOT IN (SELECT layout FROM view_module_names);
DELETE FROM view_layouts_used WHERE layout NOT IN (SELECT layout FROM view_module_names);

-- 1a. Adopt an unmarked top-level tag of the module tag's name.
UPDATE content_nodes m
   SET tag_schema = COALESCE(m.tag_schema, jsonb_build_object(
         'name', m.title, 'slug', 'module-' || m.id, 'fields', '[]'::jsonb, 'policy', '{}'::jsonb,
         'behaviour', '{}'::jsonb, 'template_children', '[]'::jsonb, 'views', '{}'::jsonb,
         'block_template', '[]'::jsonb, 'description', '', 'version', '1.0.0',
         'dependencies', '[]'::jsonb, 'publish_collection', false))
       || jsonb_build_object('module', n.layout),
       updated_at = now()
  FROM view_module_names n
 WHERE m.node_type = 'class_tag' AND m.deleted_at IS NULL AND m.parent_id IS NULL
   AND lower(m.title) = lower(n.name)
   AND (m.tag_schema IS NULL OR m.tag_schema->>'module' IS NULL)
   AND NOT EXISTS (SELECT 1 FROM node_tags nt WHERE nt.tag_id = m.id)
   AND NOT EXISTS (SELECT 1 FROM content_nodes c WHERE c.parent_id = m.id AND c.deleted_at IS NULL)
   AND COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(m.tag_schema->'fields') = 'array' THEN m.tag_schema->'fields' END), 0) = 0
   AND COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(m.collection_views) = 'array' THEN m.collection_views END), 0) = 0
   AND EXISTS (SELECT 1 FROM view_layouts_used u WHERE u.workspace_id = m.workspace_id AND u.layout = n.layout)
   AND NOT EXISTS (SELECT 1 FROM content_nodes o
                    WHERE o.workspace_id = m.workspace_id AND o.node_type = 'class_tag' AND o.deleted_at IS NULL
                      AND o.tag_schema->>'module' = n.layout);

-- 1b. Create the ones still missing.
INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, tag_color, tag_schema)
SELECT x.id, x.workspace_id, 'manual', 'class_tag', x.name, 'module-' || x.id, '', NULL,
       jsonb_build_object(
         'name', x.name, 'slug', 'module-' || x.id, 'fields', '[]'::jsonb, 'policy', '{}'::jsonb,
         'behaviour', '{}'::jsonb, 'template_children', '[]'::jsonb, 'views', '{}'::jsonb,
         'block_template', '[]'::jsonb, 'description', '', 'version', '1.0.0',
         'dependencies', '[]'::jsonb, 'publish_collection', false, 'module', x.layout)
  FROM (SELECT gen_random_uuid() AS id, w.workspace_id, w.layout,
               CASE WHEN EXISTS (SELECT 1 FROM content_nodes u
                                  WHERE u.workspace_id = w.workspace_id AND u.node_type = 'class_tag' AND u.deleted_at IS NULL
                                    AND u.parent_id IS NULL AND lower(u.title) = lower(n.name))
                    THEN n.name || '檢視' ELSE n.name END AS name
          FROM (SELECT DISTINCT workspace_id, layout FROM view_layouts_used) w
          JOIN view_module_names n USING (layout)
         WHERE NOT EXISTS (SELECT 1 FROM content_nodes o
                            WHERE o.workspace_id = w.workspace_id AND o.node_type = 'class_tag' AND o.deleted_at IS NULL
                              AND o.tag_schema->>'module' = w.layout)) x;

-- 2. Each tag extends the module tags of its views' layouts.
UPDATE content_nodes t
   SET tag_schema = jsonb_set(
         COALESCE(t.tag_schema, jsonb_build_object(
           'name', t.title, 'slug', 'module-' || t.id, 'fields', '[]'::jsonb, 'policy', '{}'::jsonb,
           'behaviour', '{}'::jsonb, 'template_children', '[]'::jsonb, 'views', '{}'::jsonb,
           'block_template', '[]'::jsonb, 'description', '', 'version', '1.0.0',
           'dependencies', '[]'::jsonb, 'publish_collection', false)),
         '{extends}',
         CASE WHEN jsonb_typeof(t.tag_schema->'extends') = 'array' THEN t.tag_schema->'extends' ELSE '[]'::jsonb END
           || add.ids),
       updated_at = now()
  FROM (SELECT u.tag_id, jsonb_agg(DISTINCT m.id::text) AS ids
          FROM view_layouts_used u
          JOIN LATERAL (SELECT o.id FROM content_nodes o
                         WHERE o.workspace_id = u.workspace_id AND o.node_type = 'class_tag' AND o.deleted_at IS NULL
                           AND o.tag_schema->>'module' = u.layout
                         ORDER BY o.created_at LIMIT 1) m ON true
          JOIN content_nodes t2 ON t2.id = u.tag_id
         WHERE NOT COALESCE(t2.tag_schema->'extends', '[]'::jsonb) ? m.id::text
         GROUP BY u.tag_id) add
 WHERE t.id = add.tag_id;
