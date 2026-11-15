-- 191: function references batch 3, tasks (docs/architecture/proposals/function-refs-b3-2026-11-12.md §2, §7).
--
-- 1. Every task node gets one function_refs row (function_id 'tasks', holder = the task node, instance '', config {}),
--    replacing the node_tags row that tied it to the tasks module's tag. A task node is a node that has that tag
--    (a live class_tag with tag_schema.module = 'tasks'; any such tag counts, as the old predicate did) AND a _task_status
--    attribute; trashed tasks and tasks under trashed notes are moved too. The node_tags rows of the moved nodes are
--    deleted. A node with the tag but no _task_status was never a task: it is left alone (its tag row stays) and counted.
-- 2. The block_node_tags rows of the tasks module's tag are deleted: `{task}` on a checkbox line is the tasks module's
--    reserved word now and is never resolved to a tag. block_nodes.task_id (the line -> task link) is untouched.
-- 3. A tag no longer makes its notes tasks: function_refs rows of tags for 'tasks_checkable' / 'tasks_dates' are deleted
--    (the notes and their _task_* attribute values stay; the tag ids and the number removed are printed as NOTICE).
-- The new rows take the database default id (computed ids are a later task). The tasks module's tag node itself is NOT
-- removed here. Re-running moves nothing more (the tag rows are gone) and prints zeros.
-- Rolling back to an older backend: it looks for the tag rows this migration deleted, so tasks would not be found;
-- go back by restoring the pre-upgrade backup (migrations only go forward; docs/agents/migrations.md).
-- drill: allows node_tags

DO $$
DECLARE
  removed_refs integer := 0;
  removed_tags text;
  moved integer;
  skipped integer;
  deleted_tag_rows integer;
  deleted_block_rows integer;
  module_tag_names text;
  plain_task_tags integer;
BEGIN
  -- The word that makes a checkbox line a task is the module tag's current name (a renamed tag is written `{任務}`);
  -- these are the names the app will go on recognising, and whether an ordinary tag called `task` shares the workspace.
  SELECT string_agg(DISTINCT workspace_id::text || ': ' || title, ', ') INTO module_tag_names
    FROM content_nodes WHERE node_type = 'class_tag' AND deleted_at IS NULL AND tag_schema->>'module' = 'tasks';
  SELECT count(*) INTO plain_task_tags
    FROM content_nodes WHERE node_type = 'class_tag' AND deleted_at IS NULL AND lower(title) = 'task'
     AND (tag_schema IS NULL OR tag_schema->>'module' IS NULL);
  RAISE NOTICE '[191] tasks module tag name(s) (workspace: name): %; ordinary tags named task: %', COALESCE(module_tag_names, 'none'), plain_task_tags;

  WITH d AS (
    DELETE FROM function_refs
     WHERE function_id IN ('tasks_checkable', 'tasks_dates') AND instance = '' AND holder_node_id IS NOT NULL
    RETURNING holder_node_id, function_id
  )
  SELECT count(*), string_agg(DISTINCT d.holder_node_id::text || ' (' || d.function_id || ')', ', ')
    INTO removed_refs, removed_tags FROM d;
  RAISE NOTICE '[191] removed % tag function reference(s) of tasks_checkable / tasks_dates (tags: %)', removed_refs, COALESCE(removed_tags, 'none');

  CREATE TEMP TABLE task_tag_rows ON COMMIT DROP AS
    SELECT nt.node_id, nt.tag_id, n.workspace_id,
           EXISTS (SELECT 1 FROM node_attributes a WHERE a.node_id = nt.node_id AND a.key = '_task_status') AS has_status
      FROM node_tags nt
      JOIN content_nodes tg ON tg.id = nt.tag_id AND tg.node_type = 'class_tag' AND tg.deleted_at IS NULL
       AND tg.tag_schema->>'module' = 'tasks'
      JOIN content_nodes n ON n.id = nt.node_id;

  WITH ins AS (
    INSERT INTO function_refs (workspace_id, function_id, holder_node_id)
    SELECT DISTINCT r.workspace_id, 'tasks', r.node_id FROM task_tag_rows r WHERE r.has_status
    ON CONFLICT DO NOTHING
    RETURNING 1
  ) SELECT count(*) INTO moved FROM ins;
  SELECT count(DISTINCT node_id) INTO skipped FROM task_tag_rows WHERE NOT has_status;

  DELETE FROM node_tags nt USING task_tag_rows r
   WHERE r.has_status AND nt.node_id = r.node_id AND nt.tag_id = r.tag_id;
  GET DIAGNOSTICS deleted_tag_rows = ROW_COUNT;

  DELETE FROM block_node_tags bt USING content_nodes tg
   WHERE tg.id = bt.tag_id AND tg.node_type = 'class_tag' AND tg.tag_schema->>'module' = 'tasks';
  GET DIAGNOSTICS deleted_block_rows = ROW_COUNT;

  RAISE NOTICE '[191] task nodes given a tasks reference: %; nodes with the tasks tag but no status left alone: %; node_tags rows removed: %; block_node_tags rows removed: %',
    moved, skipped, deleted_tag_rows, deleted_block_rows;
END $$;

-- Every task just got a row: tell the planner now. Without fresh statistics it picks a bad plan for the tasks join
-- (seconds on a thousand tasks) until autovacuum gets to the table, which would be the first agenda after the upgrade.
ANALYZE function_refs;
