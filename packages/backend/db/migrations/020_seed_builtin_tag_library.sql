-- Builtin supertag library — Day 2 of the "tag library + plugin" arc.
--
-- Seeds 4 entity types that exercise the substrate end-to-end:
--   #person   — basic CRM-style record (no special behaviour)
--   #book     — reading log (uses $today + notify on completion)
--   #project  — project tracker (uses $today on state transitions)
--   #meeting  — meeting log (auto-fills date=$today on creation)
--
-- All idempotent — re-runs harmless. Uses the same shape as 013_seed_task_tag.

-- ── #person ──────────────────────────────────────────────────────────────────

DO $$
DECLARE
  ws RECORD;
  schema_id_var uuid;
  tag_id_var uuid;
  fields jsonb := jsonb_build_array(
    jsonb_build_object('name', 'email', 'label', 'Email', 'type', 'text'),
    jsonb_build_object('name', 'company', 'label', 'Company', 'type', 'text'),
    jsonb_build_object('name', 'role', 'label', 'Role', 'type', 'text'),
    jsonb_build_object('name', 'phone', 'label', 'Phone', 'type', 'text'),
    jsonb_build_object('name', 'notes', 'label', 'Notes', 'type', 'textarea')
  );
  views jsonb := jsonb_build_object(
    'grid',   jsonb_build_object('title_field', 'email', 'subtitle_field', 'company'),
    'detail', jsonb_build_object('meta_fields', jsonb_build_array('company', 'role', 'email'))
  );
BEGIN
  FOR ws IN SELECT id FROM workspaces LOOP
    SELECT id INTO schema_id_var FROM collection_schemas WHERE workspace_id = ws.id AND slug = 'person';
    IF schema_id_var IS NULL THEN
      INSERT INTO collection_schemas (workspace_id, name, slug, fields, views, behaviour, policy)
      VALUES (ws.id, 'Person', 'person', fields, views, '{}'::jsonb, '{}'::jsonb)
      RETURNING id INTO schema_id_var;
    ELSE
      UPDATE collection_schemas SET fields = fields::jsonb, views = views::jsonb WHERE id = schema_id_var;
    END IF;

    SELECT id INTO tag_id_var FROM tags WHERE workspace_id = ws.id AND name = 'person';
    IF tag_id_var IS NULL THEN
      INSERT INTO tags (workspace_id, name, kind, schema_id, color)
      VALUES (ws.id, 'person', 'supertag', schema_id_var, '#0ea5e9');
    ELSE
      UPDATE tags SET schema_id = schema_id_var, kind = 'supertag' WHERE id = tag_id_var;
    END IF;
  END LOOP;
END $$;

-- ── #book ────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  ws RECORD;
  schema_id_var uuid;
  tag_id_var uuid;
  fields jsonb := jsonb_build_array(
    jsonb_build_object('name', 'author', 'label', 'Author', 'type', 'text'),
    jsonb_build_object('name', 'status', 'label', 'Status', 'type', 'select',
      'options', jsonb_build_array('wishlist', 'reading', 'done', 'dropped')),
    jsonb_build_object('name', 'rating', 'label', 'Rating', 'type', 'number'),
    jsonb_build_object('name', 'started_at', 'label', 'Started', 'type', 'date'),
    jsonb_build_object('name', 'finished_at', 'label', 'Finished', 'type', 'date'),
    jsonb_build_object('name', 'review', 'label', 'Review', 'type', 'textarea')
  );
  views jsonb := jsonb_build_object(
    'grid',   jsonb_build_object('title_field', 'author', 'subtitle_field', 'status'),
    'detail', jsonb_build_object('meta_fields', jsonb_build_array('author', 'status', 'rating'))
  );
  -- Behaviour exercises Day-1 primitives:
  --   on_apply: default status=wishlist
  --   on_attribute_change: when reading → started_at=$today
  --                        when done    → sequence[finished_at=$today, notify]
  behaviour jsonb := jsonb_build_object(
    'on_apply', jsonb_build_object(
      'type', 'set_attribute', 'key', 'status', 'value', 'wishlist', 'value_type', 'text'
    ),
    'on_attribute_change', jsonb_build_object(
      'type', 'sequence',
      'steps', jsonb_build_array(
        jsonb_build_object(
          'type', 'when', 'if_key', 'status', 'equals', 'reading',
          'then', jsonb_build_object('type', 'set_attribute', 'key', 'started_at', 'value', '$today', 'value_type', 'date')
        ),
        jsonb_build_object(
          'type', 'when', 'if_key', 'status', 'equals', 'done',
          'then', jsonb_build_object(
            'type', 'sequence',
            'steps', jsonb_build_array(
              jsonb_build_object('type', 'set_attribute', 'key', 'finished_at', 'value', '$today', 'value_type', 'date'),
              jsonb_build_object('type', 'notify', 'level', 'success', 'message', 'Book finished — log a review?')
            )
          )
        )
      )
    )
  );
BEGIN
  FOR ws IN SELECT id FROM workspaces LOOP
    SELECT id INTO schema_id_var FROM collection_schemas WHERE workspace_id = ws.id AND slug = 'book';
    IF schema_id_var IS NULL THEN
      INSERT INTO collection_schemas (workspace_id, name, slug, fields, views, behaviour, policy)
      VALUES (ws.id, 'Book', 'book', fields, views, behaviour, '{}'::jsonb)
      RETURNING id INTO schema_id_var;
    ELSE
      UPDATE collection_schemas SET fields = fields::jsonb, views = views::jsonb, behaviour = behaviour::jsonb
      WHERE id = schema_id_var;
    END IF;

    SELECT id INTO tag_id_var FROM tags WHERE workspace_id = ws.id AND name = 'book';
    IF tag_id_var IS NULL THEN
      INSERT INTO tags (workspace_id, name, kind, schema_id, color)
      VALUES (ws.id, 'book', 'supertag', schema_id_var, '#f59e0b');
    ELSE
      UPDATE tags SET schema_id = schema_id_var, kind = 'supertag' WHERE id = tag_id_var;
    END IF;
  END LOOP;
END $$;

-- ── #project ─────────────────────────────────────────────────────────────────

DO $$
DECLARE
  ws RECORD;
  schema_id_var uuid;
  tag_id_var uuid;
  fields jsonb := jsonb_build_array(
    jsonb_build_object('name', 'status', 'label', 'Status', 'type', 'select',
      'options', jsonb_build_array('planning', 'active', 'paused', 'done', 'cancelled')),
    jsonb_build_object('name', 'priority', 'label', 'Priority', 'type', 'select',
      'options', jsonb_build_array('low', 'medium', 'high')),
    jsonb_build_object('name', 'owner', 'label', 'Owner', 'type', 'text'),
    jsonb_build_object('name', 'due_date', 'label', 'Due', 'type', 'date'),
    jsonb_build_object('name', 'started_at', 'label', 'Started', 'type', 'date'),
    jsonb_build_object('name', 'finished_at', 'label', 'Finished', 'type', 'date')
  );
  views jsonb := jsonb_build_object(
    'grid',   jsonb_build_object('title_field', 'status', 'subtitle_field', 'owner'),
    'detail', jsonb_build_object('meta_fields', jsonb_build_array('status', 'priority', 'owner', 'due_date'))
  );
  behaviour jsonb := jsonb_build_object(
    'on_apply', jsonb_build_object(
      'type', 'set_attribute', 'key', 'status', 'value', 'planning', 'value_type', 'text'
    ),
    'on_attribute_change', jsonb_build_object(
      'type', 'sequence',
      'steps', jsonb_build_array(
        jsonb_build_object(
          'type', 'when', 'if_key', 'status', 'equals', 'active',
          'then', jsonb_build_object('type', 'set_attribute', 'key', 'started_at', 'value', '$today', 'value_type', 'date')
        ),
        jsonb_build_object(
          'type', 'when', 'if_key', 'status', 'equals', 'done',
          'then', jsonb_build_object(
            'type', 'sequence',
            'steps', jsonb_build_array(
              jsonb_build_object('type', 'set_attribute', 'key', 'finished_at', 'value', '$today', 'value_type', 'date'),
              jsonb_build_object('type', 'notify', 'level', 'success', 'message', 'Project shipped 🎉')
            )
          )
        ),
        jsonb_build_object(
          'type', 'when', 'if_key', 'status', 'equals', 'cancelled',
          'then', jsonb_build_object('type', 'notify', 'level', 'warning', 'message', 'Project cancelled')
        )
      )
    )
  );
BEGIN
  FOR ws IN SELECT id FROM workspaces LOOP
    SELECT id INTO schema_id_var FROM collection_schemas WHERE workspace_id = ws.id AND slug = 'project';
    IF schema_id_var IS NULL THEN
      INSERT INTO collection_schemas (workspace_id, name, slug, fields, views, behaviour, policy)
      VALUES (ws.id, 'Project', 'project', fields, views, behaviour, '{}'::jsonb)
      RETURNING id INTO schema_id_var;
    ELSE
      UPDATE collection_schemas SET fields = fields::jsonb, views = views::jsonb, behaviour = behaviour::jsonb
      WHERE id = schema_id_var;
    END IF;

    SELECT id INTO tag_id_var FROM tags WHERE workspace_id = ws.id AND name = 'project';
    IF tag_id_var IS NULL THEN
      INSERT INTO tags (workspace_id, name, kind, schema_id, color)
      VALUES (ws.id, 'project', 'supertag', schema_id_var, '#16a34a');
    ELSE
      UPDATE tags SET schema_id = schema_id_var, kind = 'supertag' WHERE id = tag_id_var;
    END IF;
  END LOOP;
END $$;

-- ── #meeting ─────────────────────────────────────────────────────────────────

DO $$
DECLARE
  ws RECORD;
  schema_id_var uuid;
  tag_id_var uuid;
  fields jsonb := jsonb_build_array(
    jsonb_build_object('name', 'date', 'label', 'Date', 'type', 'date'),
    jsonb_build_object('name', 'attendees', 'label', 'Attendees', 'type', 'textarea'),
    jsonb_build_object('name', 'summary', 'label', 'Summary', 'type', 'textarea'),
    jsonb_build_object('name', 'action_items', 'label', 'Action items', 'type', 'textarea')
  );
  views jsonb := jsonb_build_object(
    'grid',   jsonb_build_object('title_field', 'date', 'subtitle_field', 'attendees'),
    'detail', jsonb_build_object('meta_fields', jsonb_build_array('date', 'attendees'))
  );
  -- on_apply auto-fills the meeting date — saves a click on every new entry.
  behaviour jsonb := jsonb_build_object(
    'on_apply', jsonb_build_object(
      'type', 'set_attribute', 'key', 'date', 'value', '$today', 'value_type', 'date'
    )
  );
BEGIN
  FOR ws IN SELECT id FROM workspaces LOOP
    SELECT id INTO schema_id_var FROM collection_schemas WHERE workspace_id = ws.id AND slug = 'meeting';
    IF schema_id_var IS NULL THEN
      INSERT INTO collection_schemas (workspace_id, name, slug, fields, views, behaviour, policy)
      VALUES (ws.id, 'Meeting', 'meeting', fields, views, behaviour, '{}'::jsonb)
      RETURNING id INTO schema_id_var;
    ELSE
      UPDATE collection_schemas SET fields = fields::jsonb, views = views::jsonb, behaviour = behaviour::jsonb
      WHERE id = schema_id_var;
    END IF;

    SELECT id INTO tag_id_var FROM tags WHERE workspace_id = ws.id AND name = 'meeting';
    IF tag_id_var IS NULL THEN
      INSERT INTO tags (workspace_id, name, kind, schema_id, color)
      VALUES (ws.id, 'meeting', 'supertag', schema_id_var, '#a855f7');
    ELSE
      UPDATE tags SET schema_id = schema_id_var, kind = 'supertag' WHERE id = tag_id_var;
    END IF;
  END LOOP;
END $$;
