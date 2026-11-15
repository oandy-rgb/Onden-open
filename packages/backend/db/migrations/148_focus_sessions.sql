-- 148: focus records (docs/architecture/day-timeline.md, 專注紀錄).
--
-- One row per time a person focused — on a task, or on nothing in particular:
-- when it began, when it ended (null while it runs), and the one sentence they
-- wrote when it ended. A person has at most one running at a time. The row is
-- the state; each change is also a domain event (FOCUS_STARTED / FOCUS_ENDED /
-- FOCUS_EDITED) written in the same transaction, with the times and the task
-- but never the sentence. Additive: no existing row changes.

CREATE TABLE IF NOT EXISTS focus_sessions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  -- A deleted task leaves the record: it keeps its times and its sentence.
  task_id uuid REFERENCES content_nodes(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT focus_sessions_order_chk CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS focus_sessions_one_running_uq ON focus_sessions (actor_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS focus_sessions_actor_start_idx ON focus_sessions (actor_id, started_at);
CREATE INDEX IF NOT EXISTS focus_sessions_task_idx ON focus_sessions (task_id) WHERE task_id IS NOT NULL;
