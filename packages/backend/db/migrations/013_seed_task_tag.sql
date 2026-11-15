-- #task built-in tag — proves Schema + Behaviour axes together.
--
-- Schema: status (text), due_date (date), priority (text)
-- Behaviour:
--   on_apply           → set status='todo' as default (set_attribute, derived)
--   on_attribute_change→ when status=done, set hidden=true (auto-archive)

DO $$
DECLARE
  ws RECORD;
  task_schema_id uuid;
  task_tag_id uuid;
  task_fields jsonb := jsonb_build_array(
    jsonb_build_object(
      'name', 'status', 'label', 'Status', 'type', 'select',
      'required', true,
      'options', jsonb_build_array('todo', 'in_progress', 'done', 'cancelled')
    ),
    jsonb_build_object(
      'name', 'due_date', 'label', 'Due date', 'type', 'date'
    ),
    jsonb_build_object(
      'name', 'priority', 'label', 'Priority', 'type', 'select',
      'options', jsonb_build_array('low', 'medium', 'high')
    )
  );
  task_views jsonb := jsonb_build_object(
    'grid',   jsonb_build_object('title_field', 'status', 'subtitle_field', 'due_date'),
    'detail', jsonb_build_object('title_field', 'status', 'meta_fields', jsonb_build_array('due_date', 'priority'))
  );
  task_behaviour jsonb := jsonb_build_object(
    'on_apply', jsonb_build_object(
      'type', 'set_attribute', 'key', 'status', 'value', 'todo', 'value_type', 'text'
    ),
    'on_attribute_change', jsonb_build_object(
      'type', 'when', 'if_key', 'status', 'equals', 'done',
      'then', jsonb_build_object('type', 'set_hidden', 'value', true)
    )
  );
BEGIN
  FOR ws IN SELECT id FROM workspaces LOOP
    -- Schema definition
    SELECT id INTO task_schema_id
    FROM collection_schemas
    WHERE workspace_id = ws.id AND slug = 'task';

    IF task_schema_id IS NULL THEN
      INSERT INTO collection_schemas (workspace_id, name, slug, fields, views, behaviour, policy)
      VALUES (ws.id, 'Task', 'task', task_fields, task_views, task_behaviour, '{}'::jsonb)
      RETURNING id INTO task_schema_id;
    ELSE
      UPDATE collection_schemas
      SET fields = task_fields, views = task_views, behaviour = task_behaviour
      WHERE id = task_schema_id;
    END IF;

    -- Tag pointer
    SELECT id INTO task_tag_id
    FROM tags
    WHERE workspace_id = ws.id AND name = 'task';

    IF task_tag_id IS NULL THEN
      INSERT INTO tags (workspace_id, name, kind, schema_id, color)
      VALUES (ws.id, 'task', 'supertag', task_schema_id, '#3b82f6');
    ELSE
      UPDATE tags SET schema_id = task_schema_id, kind = 'supertag' WHERE id = task_tag_id;
    END IF;
  END LOOP;
END $$;
