-- Spine follow-up: the transactional outbox for EXTERNAL effects.
--
-- The spine ([[spine-refactor]]) made event + state-mutation atomic inside PG.
-- But effects that live OUTSIDE PG — the local git commit (writeAndCommit) and
-- the remote GitHub backup push (pushNoteToBackup) — were fired-and-forgotten:
--
--     void writeAndCommit(...).catch(() => null);
--     void pushNoteToBackup(...).catch(() => null);
--
-- which means (1) a transient network/git failure silently loses the backup,
-- (2) the effect can outrace or lag the COMMIT it belongs to, and (3) there is
-- no durable record that the effect was even intended — so nothing can detect
-- or reconcile a miss. (See restore-state.md limit #3: external=true events
-- couldn't be reasoned about precisely because of this.)
--
-- The fix is the standard transactional-outbox pattern: instead of performing
-- the external effect inline, the caller INSERTs an INTENT into this table
-- INSIDE the same transaction as the domain_event + state change. The intent
-- therefore commits (or rolls back) atomically with the state. A separate
-- in-process reconciler (single-instance assumption — same one dispatcherQueue
-- relies on) then drains pending rows, performs the effect, and marks each
-- done / retried-with-backoff / dead.
--
-- Why a dedicated table and NOT polling domain_events (the old sketch in
-- db.ts / dispatcherQueue.ts): domain_events is the IMMUTABLE audit log. An
-- outbox row has mutable retry state (status, attempts, next_attempt_at) and
-- needs collapse semantics (rapid re-saves of one node → one pending push of
-- the latest content). Both are antithetical to an append-only event log.

CREATE TABLE IF NOT EXISTS outbox (
  id              bigserial PRIMARY KEY,
  workspace_id    uuid NOT NULL,
  effect_kind     text NOT NULL,                        -- 'git_commit' | 'github_backup'
  -- Collapse key: effect_kind + ':' + slug. The partial unique index below
  -- keeps at most ONE pending row per key, so a burst of saves on the same
  -- node folds into a single push carrying the newest content.
  dedup_key       text NOT NULL,
  payload         jsonb NOT NULL,                        -- { slug, markdown, message }
  status          text NOT NULL DEFAULT 'pending',       -- pending | done | dead
  attempts        int  NOT NULL DEFAULT 0,
  max_attempts    int  NOT NULL DEFAULT 8,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  -- Provenance: the domain_event whose commit this effect accompanies. Lets a
  -- future "what external effects did this change cause" view (and eventual
  -- reverse-effect undo) walk from an event to its outbox rows.
  triggered_by_event_id bigint,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  done_at         timestamptz
);

-- Due-scan: the reconciler reads pending rows whose backoff has elapsed.
CREATE INDEX IF NOT EXISTS outbox_due
  ON outbox (next_attempt_at)
  WHERE status = 'pending';

-- Collapse: enqueue() does INSERT ... ON CONFLICT (dedup_key) WHERE pending
-- DO UPDATE, superseding the queued content with the latest. Only pending
-- rows are constrained — done/dead history rows accumulate freely.
CREATE UNIQUE INDEX IF NOT EXISTS outbox_pending_dedup
  ON outbox (dedup_key)
  WHERE status = 'pending';
