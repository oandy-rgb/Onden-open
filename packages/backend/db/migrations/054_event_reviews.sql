-- D7: inbox-as-governance.
--
-- A review decision over a single domain_event authored by a non-human actor
-- (the AI agent now; other collaborators later). The inbox is a LENS, not a
-- table of its own: an event is "in the inbox" precisely when it has NO row
-- here. Approving or rejecting records a row, which removes it from the queue.
--
-- domain_events stays a pure, append-only audit log — review state lives
-- alongside it, keyed by the event being judged. This is apply-then-review
-- (the sandbox/staging layer was removed in 047): the agent's change is already
-- applied and reversible, and rejecting it runs the event's inverse-undo
-- (services/eventRestore) rather than blocking it up front.

CREATE TABLE IF NOT EXISTS event_reviews (
  event_id          bigint PRIMARY KEY REFERENCES domain_events(id) ON DELETE CASCADE,
  workspace_id      uuid   NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  decision          text   NOT NULL CHECK (decision IN ('approved', 'rejected')),
  -- actors.id is a uuid, but reviewers may also be the seeded 'system' string
  -- in tests/native paths, so this mirrors domain_events.actor_id (text).
  reviewed_by       text   NOT NULL,
  reviewed_at       timestamptz NOT NULL DEFAULT now(),
  -- When rejected AND invertible, the NODE_RESTORED/inverse event that undid it.
  -- NULL for approvals (and for rejections of uninvertible events, which the
  -- API refuses — kept here only for forward flexibility).
  restore_event_id  bigint REFERENCES domain_events(id) ON DELETE SET NULL,
  note              text
);

-- The inbox query filters by workspace then anti-joins on event_id; this index
-- supports the workspace scope (the PK covers the anti-join).
CREATE INDEX IF NOT EXISTS event_reviews_workspace_idx ON event_reviews (workspace_id);
