-- Task lines (docs/architecture/block-nodes.md, B4): `- [ ] text {task}` in a
-- note is a task. The line is a block node; its task is an ordinary task node
-- (#task + _task_status, a hidden child of the note), so the agenda, due
-- dates, recurrence, reminders and sync keep working unchanged. This column
-- links the two: the box follows the task's status and the task follows the
-- box (services/blockTasks.ts, services/taskLines.ts). A task with no line
-- (made in Tasks, or before B4) has no row here and works as before.
ALTER TABLE block_nodes ADD COLUMN IF NOT EXISTS task_id uuid REFERENCES content_nodes(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS block_nodes_task_uq ON block_nodes (task_id) WHERE task_id IS NOT NULL;
