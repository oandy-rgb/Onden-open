-- Review 2026-06-11: 059's CHECK (recur ~ '^[0-9]{1,3}[dwm]$') admits zero
-- intervals ('0d'/'00w'/'0m'). A zero interval never advances the due date, so
-- nextDueAfter() returns a non-future slot and the 10-minute scheduler cancels
-- + remints the SAME overdue task on every tick — an infinite chain of
-- TASK_OCCURRENCE_MISSED/TASK_CREATED events. The API now rejects n = 0 and
-- drainDueTasks() breaks such chains defensively; this pins n >= 1 in the
-- substrate.
--
-- Existing zero-interval rows lose only their recur rule (the task itself
-- survives as a plain one-off) — they must be cleaned BEFORE the tightened
-- constraint lands or the ALTER would fail validation.

UPDATE node_tasks SET recur = NULL WHERE recur ~ '^0+[dwm]$';

ALTER TABLE node_tasks DROP CONSTRAINT IF EXISTS node_tasks_recur_check;
ALTER TABLE node_tasks ADD CONSTRAINT node_tasks_recur_check
  CHECK (recur IS NULL OR (recur ~ '^[0-9]{1,3}[dwm]$' AND recur !~ '^0+[dwm]$'));
