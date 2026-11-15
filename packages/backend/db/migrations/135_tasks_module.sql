-- 135: tasks become a built-in module (docs/architecture/tasks-module.md).
--
-- 1. #task stops being a reserved tag. It becomes the module tag of the `tasks`
--    module (tag_schema.module = 'tasks'), like #月曆 for the calendar module:
--    reserved_key 'task' is cleared, the tag keeps its id, name, colour, notes
--    and task members. A module tag has no parent and no tag sits under it
--    (migration 129's rule), so the 129 repair runs again below for it.
--    Not inheritable by block nodes, as the reserved tag was.
-- 2. `_task_due` is renamed `_task_when` ("when to do it"; that is what the old
--    value always meant). A due value with a time of day keeps its day in
--    `_task_when` and moves its time to `_task_remind_at`, so nothing is lost.
-- 3. status `later` ("parked") becomes status `todo` + `_task_someday = true`.
--
-- No row is deleted; node, tag and task counts are unchanged. Attribute rows
-- are added for the two conversions above, so the drill is told:
-- drill: allows attributes
-- Idempotent: a second run finds nothing to change.

-- 1. The module tag.
UPDATE content_nodes t
   SET tag_schema = COALESCE(t.tag_schema, jsonb_build_object(
         'name', t.title, 'slug', 'module-' || t.id, 'fields', '[]'::jsonb, 'policy', '{}'::jsonb,
         'behaviour', '{}'::jsonb, 'template_children', '[]'::jsonb, 'views', '{}'::jsonb,
         'block_template', '[]'::jsonb, 'description', '', 'version', '1.0.0',
         'dependencies', '[]'::jsonb, 'publish_collection', false)) || jsonb_build_object('module', 'tasks'),
       tag_is_inheritable = COALESCE(t.tag_is_inheritable, false),
       reserved_key = NULL,
       updated_at = now()
 WHERE t.node_type = 'class_tag' AND t.reserved_key = 'task';

-- 129 again, for what step 1 just marked: a tag under the module tag becomes a
-- root tag that extends it; a module tag with a parent becomes a root tag
-- (title collisions get " (2)"…). Membership is re-checked for those workspaces.
DROP TABLE IF EXISTS module_tag_parent_moves;
CREATE TEMP TABLE module_tag_parent_moves AS
WITH moving AS (
  SELECT c.id, c.workspace_id, c.title, c.created_at,
         CASE WHEN p.tag_schema->>'module' IS NOT NULL AND c.tag_schema->>'module' IS NULL
              THEN p.id END AS add_extends
    FROM content_nodes c
    JOIN content_nodes p ON p.id = c.parent_id
   WHERE c.node_type = 'class_tag' AND p.node_type = 'class_tag'
     AND (p.tag_schema->>'module' IS NOT NULL OR c.tag_schema->>'module' IS NOT NULL)
), ranked AS (
  SELECT m.*,
         (SELECT count(*) FROM content_nodes r
           WHERE r.workspace_id = m.workspace_id AND r.parent_id IS NULL AND r.node_type = 'class_tag'
             AND r.deleted_at IS NULL AND r.title = m.title) AS taken,
         row_number() OVER (PARTITION BY m.workspace_id, m.title ORDER BY m.created_at, m.id) AS rn
    FROM moving m
   WHERE (SELECT deleted_at FROM content_nodes WHERE id = m.id) IS NULL
)
SELECT id, workspace_id, add_extends,
       CASE WHEN taken + rn > 1 THEN title || ' (' || (taken + rn) || ')' ELSE title END AS new_title
  FROM ranked;

INSERT INTO module_tag_parent_moves (id, workspace_id, add_extends, new_title)
SELECT c.id, c.workspace_id,
       CASE WHEN p.tag_schema->>'module' IS NOT NULL AND c.tag_schema->>'module' IS NULL THEN p.id END,
       c.title
  FROM content_nodes c
  JOIN content_nodes p ON p.id = c.parent_id
 WHERE c.node_type = 'class_tag' AND p.node_type = 'class_tag' AND c.deleted_at IS NOT NULL
   AND (p.tag_schema->>'module' IS NOT NULL OR c.tag_schema->>'module' IS NOT NULL);

UPDATE content_nodes t
   SET parent_id = NULL,
       title = mv.new_title,
       tag_schema = CASE WHEN mv.add_extends IS NULL OR COALESCE(t.tag_schema->'extends', '[]'::jsonb) ? mv.add_extends::text
         THEN t.tag_schema
         ELSE jsonb_set(
           COALESCE(t.tag_schema, jsonb_build_object(
             'name', t.title, 'slug', 'module-' || t.id, 'fields', '[]'::jsonb, 'policy', '{}'::jsonb,
             'behaviour', '{}'::jsonb, 'template_children', '[]'::jsonb, 'views', '{}'::jsonb,
             'block_template', '[]'::jsonb, 'description', '', 'version', '1.0.0',
             'dependencies', '[]'::jsonb, 'publish_collection', false)),
           '{extends}',
           CASE WHEN jsonb_typeof(t.tag_schema->'extends') = 'array' THEN t.tag_schema->'extends' ELSE '[]'::jsonb END
             || to_jsonb(mv.add_extends::text)) END,
       updated_at = now()
  FROM module_tag_parent_moves mv
 WHERE t.id = mv.id;

UPDATE workspaces SET membership_epoch = membership_epoch + 1
 WHERE id IN (SELECT workspace_id FROM module_tag_parent_moves);

DROP TABLE module_tag_parent_moves;

-- 2. _task_due → _task_when. The time of day of a timed value becomes the reminder.
INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, is_inheritable, source, updated_at)
SELECT d.workspace_id, d.node_id, '_task_remind_at', d.value, 'text', false, 'ui', now()
  FROM node_attributes d
 WHERE d.key = '_task_due' AND d.value LIKE '%T%'
   AND NOT EXISTS (SELECT 1 FROM node_attributes r WHERE r.node_id = d.node_id AND r.key = '_task_remind_at')
ON CONFLICT (node_id, key) DO NOTHING;

UPDATE node_attributes d
   SET key = '_task_when', value = left(d.value, 10), value_type = 'date', updated_at = now()
 WHERE d.key = '_task_due'
   AND NOT EXISTS (SELECT 1 FROM node_attributes w WHERE w.node_id = d.node_id AND w.key = '_task_when');

-- The partial index the agenda scans by day follows the key.
DROP INDEX IF EXISTS node_attr_task_due;
CREATE INDEX IF NOT EXISTS node_attr_task_when ON node_attributes (workspace_id, value) WHERE key = '_task_when';

-- 3. status later → todo + someday.
INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, is_inheritable, source, updated_at)
SELECT s.workspace_id, s.node_id, '_task_someday', 'true', 'bool', false, 'ui', now()
  FROM node_attributes s
 WHERE s.key = '_task_status' AND s.value = 'later'
ON CONFLICT (node_id, key) DO NOTHING;

UPDATE node_attributes SET value = 'todo', updated_at = now() WHERE key = '_task_status' AND value = 'later';

COMMENT ON COLUMN content_nodes.reserved_key IS 'Role of a system-reserved class_tag (workspace-config, page); NULL for ordinary nodes. See services/reservedTags.ts. (task became the tasks module tag in migration 135; subscription retired by migration 114.)';
