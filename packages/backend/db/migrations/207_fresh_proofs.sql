-- 207: short-lived, single-use tickets that say "this person has just proved who they are" (src/services/freshProof.ts). A route that hands out the
-- whole workspace asks for one, so a request that only holds a session cannot do it. Adds only: two tables and one index. No existing row is read,
-- changed or deleted.
--
-- WHAT THIS ADDS
--   fresh_proofs   one row per ticket handed out: the sha-256 of the ticket (the ticket itself is never stored, so a copy of the database holds nothing
--                  that can be presented), who it was handed to, the sign-in session it was handed in (NULL for a request with none), what it is for, when it stops being good (the database's clock, so one clock decides),
--                  and when it was used (NULL until then; a used row stays until it is old, so a second try is told apart from a wrong ticket).
--   fresh_proof_attempts   one row per person who has typed a password to get a ticket: how many attempts since the last success, and until when they are locked
--                  (the fifth attempt in a row locks for 15 minutes, each one after the lock ends doubles it, at most a day). In the database so a restart does not
--                  forget it, and a success deletes the row. See src/services/freshProof.ts.
--   Both are node-local like the sessions of the sign-in: not carried by a snapshot (src/spine/syncClasses.json).
--
-- WHY A TABLE OF ITS OWN (and not better-auth's `verification`): that table is made by the sign-in library's own boot step, not by migrate(), so a
-- database that only migrate() prepared (the test template, a fresh install before the first sign-in) would not have it, and its columns are the
-- library's to change. This one is migrate()'s, so it exists wherever the rest of the schema does, the PGlite database of the browser version included.
--
-- READ-ONLY PREVIEW (run before; changes nothing): SELECT to_regclass('public.fresh_proofs'), to_regclass('public.fresh_proof_attempts');   -- NULLs before this migration, the names after

CREATE TABLE IF NOT EXISTS fresh_proofs (
  ticket_hash text PRIMARY KEY,
  actor_id    uuid NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  purpose     text NOT NULL,
  session_id  text,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

-- the cleanup at each hand-out looks for old rows by this
CREATE INDEX IF NOT EXISTS fresh_proofs_expires_idx ON fresh_proofs (expires_at);

CREATE TABLE IF NOT EXISTS fresh_proof_attempts (
  actor_id     uuid PRIMARY KEY REFERENCES actors(id) ON DELETE CASCADE,
  failures     integer NOT NULL DEFAULT 0,
  locked_until timestamptz
);
