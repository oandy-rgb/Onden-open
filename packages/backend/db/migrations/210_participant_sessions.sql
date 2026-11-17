-- 210: a session as a temporary participant (docs/architecture/proposals/sessions-core-2026-11-17.md; design B of
-- docs/architecture/proposals/roles-spaces-sessions-2026-11-15.md §5). Adds only: one table, one index, and one widened CHECK. No existing row is
-- read, changed or deleted.
--
-- WHAT THIS ADDS
--   actors.type   gains 'session': a participant that exists for one person on one computer for a while. It is an `actors` row (so it can be a member of
--                 spaces, and every question about what it may read or write is answered by the rules that answer it for everyone else: space_members,
--                 spine/spaceAccess.ts) that is neither a person ('human') nor an AI ('agent'). The CHECK is dropped and re-added with the third value;
--                 'system' is still not a database value (src/test/systemJobs.integration.test.ts pins that).
--   participant_sessions   one row per session: the participant (actor_id), who opened it (opened_by: the person it acts for), the sha-256 of its
--                 credential (the credential itself is never stored), when it stops being good (expires_at, the database's clock), when it was ended
--                 (ended_at; a session that is ended or past its time is refused at every request, from these two columns, with no timer that must run),
--                 and its limits and what it has used (requests, request bytes). The spaces a session reaches are its space_members rows; they are the
--                 only record of that, so there is no second list to keep in step.
--   Node-local like the sign-in's own sessions: a credential is for THIS server's door, so the table is not carried by a snapshot
--   (src/spine/syncClasses.json). The session's `actors` row travels like any other member's (identity: id, name, type), so a stamp's `author` still names someone.
--
-- READ-ONLY PREVIEW (run before; changes nothing): SELECT to_regclass('public.participant_sessions');   -- NULL before this migration, the name after

ALTER TABLE actors DROP CONSTRAINT IF EXISTS actors_type_check;
ALTER TABLE actors ADD CONSTRAINT actors_type_check CHECK (type IN ('human', 'agent', 'session'));

CREATE TABLE IF NOT EXISTS participant_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id        uuid NOT NULL UNIQUE REFERENCES actors(id) ON DELETE CASCADE,
  opened_by       uuid NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  credential_hash text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  ended_at        timestamptz,
  max_requests    integer NOT NULL CHECK (max_requests > 0),
  request_count   bigint NOT NULL DEFAULT 0,
  max_bytes       bigint NOT NULL CHECK (max_bytes > 0),
  byte_count      bigint NOT NULL DEFAULT 0,
  last_used_at    timestamptz,
  CHECK (expires_at > created_at)
);

-- "the live sessions of this person" (the member list, ending them when the person is removed)
CREATE INDEX IF NOT EXISTS participant_sessions_opener_idx ON participant_sessions (opened_by) WHERE ended_at IS NULL;
