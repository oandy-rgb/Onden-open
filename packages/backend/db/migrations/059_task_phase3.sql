-- D8 Tasks Phase 3 — the substrate half: richer status, scheduling fields,
-- and the recurrence rule the time-trigger + break-or-make logic ride on.
--
--   status: todo|doing → the open agenda; waiting (blocked on someone/something)
--           and later (deliberately parked) exclude noise from the agenda
--           without deleting intent; done|cancelled are terminal.
--   due_date: plain date — agenda buckets (Overdue/Today/Upcoming) are
--           SERVER-computed from it (GET /api/tasks/agenda), not client filters.
--   recur:  minimal interval token `<n><d|w|m>` (e.g. '1d', '2w', '1m').
--           Break-or-make: every occurrence is a REAL row + event — completing
--           a recurring task mints the next occurrence; the time-trigger
--           breaks (cancels) an unattended one and mints the next, so a
--           skipped day never silently kills the chain.

ALTER TABLE node_tasks DROP CONSTRAINT IF EXISTS node_tasks_status_check;
ALTER TABLE node_tasks ADD CONSTRAINT node_tasks_status_check
  CHECK (status = ANY (ARRAY['todo'::text, 'doing'::text, 'waiting'::text, 'later'::text, 'done'::text, 'cancelled'::text]));

ALTER TABLE node_tasks ADD COLUMN IF NOT EXISTS due_date date;
ALTER TABLE node_tasks ADD COLUMN IF NOT EXISTS recur text
  CHECK (recur IS NULL OR recur ~ '^[0-9]{1,3}[dwm]$');

-- The agenda scan: open tasks by due date, workspace-scoped.
CREATE INDEX IF NOT EXISTS node_tasks_agenda
  ON node_tasks (workspace_id, due_date)
  WHERE status NOT IN ('done', 'cancelled');
