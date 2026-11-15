-- Tasks become NODES; node_tasks — the substrate's last big parallel table —
-- is retired ([[collab-merge-model]] "node = main primitive, not yet the only
-- one"; same move as migration 061's RSS rebuild).
--
-- A task is now an ordinary node: hidden=true, parent_id = the owning note,
-- title = the task title, carrying the #task class tag (found-or-created BY
-- NAME per workspace, like #review / #subscription) plus reserved attributes:
--   _task_status  todo|doing|waiting|later|done|cancelled
--   _task_due     YYYY-MM-DD     (absent = unscheduled)
--   _task_recur   <n><d|w|m>     (absent = one-off; n >= 1 enforced at the API
--                                 and defensively by the scheduler — the old
--                                 060 CHECK retires with the table)
--
-- Parallel tables don't merge, don't restore, don't pass inbox governance,
-- don't respect read policy. Task nodes get all four for free.
--
-- ID CONTINUITY: the task node REUSES the old node_tasks.id, so ids the
-- frontend holds (localDb mirror, open agenda views) and old TASK_* events in
-- the log stay valid. created_at/updated_at are carried over so created_at
-- ordering (agenda ties, bootstrap order) is preserved.
--
-- Re-runnable: everything is guarded (to_regclass / ON CONFLICT), so the
-- migration-fixture test can seed a legacy node_tasks table and execute this
-- file again against an already-migrated database.

DO $$
DECLARE
  ws record;
  v_tag_id uuid;
BEGIN
  IF to_regclass('public.node_tasks') IS NULL THEN
    RETURN; -- fresh install (or already migrated): nothing to carry over
  END IF;

  FOR ws IN SELECT DISTINCT workspace_id FROM node_tasks LOOP
    -- Find-or-create the `task` class tag in this workspace. Matched BY NAME —
    -- an ordinary tag, no special-casing in tag CRUD.
    SELECT id INTO v_tag_id FROM content_nodes
     WHERE workspace_id = ws.workspace_id AND node_type = 'class_tag'
       AND title = 'task' AND deleted_at IS NULL
     LIMIT 1;
    IF v_tag_id IS NULL THEN
      INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug)
      VALUES (ws.workspace_id, 'manual', 'class_tag', 'task',
              'tag-task-' || substr(md5(ws.workspace_id::text), 1, 6))
      RETURNING id INTO v_tag_id;
    END IF;

    -- The task node, same id, same timestamps. Hosts that were soft-deleted
    -- keep their tasks (parity: node_tasks rows survived soft-delete and were
    -- filtered out of reads by the host join — task nodes behave the same).
    INSERT INTO content_nodes
      (id, workspace_id, source_type, node_type, title, slug, markdown, parent_id, hidden, created_at, updated_at)
    SELECT t.id, t.workspace_id, 'manual', 'content', t.title, 'task-' || t.id::text, '',
           t.node_id, true, t.created_at, t.updated_at
      FROM node_tasks t
     WHERE t.workspace_id = ws.workspace_id
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO node_tags (node_id, tag_id)
    SELECT t.id, v_tag_id FROM node_tasks t WHERE t.workspace_id = ws.workspace_id
    ON CONFLICT DO NOTHING;

    INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, is_inheritable, source)
    SELECT t.workspace_id, t.id, '_task_status', t.status, 'text', false, 'explicit'
      FROM node_tasks t WHERE t.workspace_id = ws.workspace_id
    ON CONFLICT (node_id, key) DO NOTHING;

    INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, is_inheritable, source)
    SELECT t.workspace_id, t.id, '_task_due', to_char(t.due_date, 'YYYY-MM-DD'), 'text', false, 'explicit'
      FROM node_tasks t WHERE t.workspace_id = ws.workspace_id AND t.due_date IS NOT NULL
    ON CONFLICT (node_id, key) DO NOTHING;

    INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, is_inheritable, source)
    SELECT t.workspace_id, t.id, '_task_recur', t.recur, 'text', false, 'explicit'
      FROM node_tasks t WHERE t.workspace_id = ws.workspace_id AND t.recur IS NOT NULL
    ON CONFLICT (node_id, key) DO NOTHING;

    v_tag_id := NULL;
  END LOOP;
END $$;

DROP TABLE IF EXISTS node_tasks;

-- The agenda scan's index support (replaces the old node_tasks_agenda index).
-- Partial on the reserved key so the agenda/scheduler queries — which filter
-- node_attributes by key='_task_status' / '_task_due' — index-scan instead of
-- seq-scanning every attribute row. Values are compared as TEXT (YYYY-MM-DD
-- sorts identically to date), so plain btree on value is the right shape.
CREATE INDEX IF NOT EXISTS node_attr_task_status
  ON node_attributes (workspace_id, value)
  WHERE key = '_task_status';

CREATE INDEX IF NOT EXISTS node_attr_task_due
  ON node_attributes (workspace_id, value)
  WHERE key = '_task_due';
