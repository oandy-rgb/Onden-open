-- Restoring a backup runs as a job (services/backupRestoreJobs.ts): the apply
-- request answers 202 with the job, the restore commits in batches, and the
-- settings page polls this row for its progress. One job per upload (the
-- upload id is the restore's idempotency key), so a retry finds the job
-- instead of a deleted upload. A job lives only in the process that runs it:
-- on boot, jobs still marked running are failed as "interrupted".
CREATE TABLE IF NOT EXISTS backup_restore_jobs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL,
  upload_id uuid NOT NULL UNIQUE,
  space_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('empty', 'merge')),
  status text NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  phase text NOT NULL DEFAULT 'reading',
  done integer NOT NULL DEFAULT 0,
  total integer NOT NULL DEFAULT 0,
  event_id bigint,
  error text,
  error_status integer,
  rolled_back boolean NOT NULL DEFAULT false,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One running restore per space: a second one into it is refused (409
-- restore_running) rather than interleaving with the first.
CREATE UNIQUE INDEX IF NOT EXISTS backup_restore_jobs_one_running_per_space ON backup_restore_jobs (space_id) WHERE status = 'running';
