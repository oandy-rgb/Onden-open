-- M1: durable cascade intents for the post-commit dispatcher queue.
--
-- The A2 dispatcher queue (services/dispatcherQueue.ts) runs tag-behaviour
-- cascades AFTER the triggering transaction commits, from an in-memory map.
-- Crash mid-chain and the trigger (NODE_UPDATED / NODE_RESTORED) is durable
-- while its cascade (TAG_APPLIED / ATTRIBUTE_SET / NODE_HIDDEN_CHANGED …) is
-- silently lost — the exact failure mode the file header documented as
-- "a future dispatcher catchup job".
--
-- Fix = the same transactional-outbox move migration 046 made for external
-- effects, kept deliberately smaller: one row per triggering event, INSERTed
-- inside the trigger's own transaction (so intent and trigger commit
-- atomically) and DELETEd when the cascade settles. Whatever is in this table
-- at boot is, by construction, a cascade that never reached its success/fail
-- handler — i.e. a crash victim — and runDispatcherCatchup() replays it.
--
-- Why not a domain_events high-water mark instead: event ids are assigned at
-- INSERT time but become visible at COMMIT time, so under concurrent requests
-- an id-ordered watermark can pass over a still-uncommitted trigger and lose
-- it forever once it commits. A per-trigger row has no such ordering problem.
--
-- No FKs on purpose:
--   * event_id → domain_events: the experimental prune path may GC events;
--     a dangling intent is harmless (catch-up just replays from current state).
--   * node_id → content_nodes: a purged node's intent must not block the
--     purge; catch-up discards intents whose node is gone or trashed.
CREATE TABLE IF NOT EXISTS dispatcher_pending (
  -- The committed trigger event whose post-commit cascade this row guards.
  -- PK: one cascade per trigger (all queueDispatcher call sites pass the
  -- mutate() event id of the content change that needs re-derivation).
  event_id bigint PRIMARY KEY,
  workspace_id uuid NOT NULL,
  node_id uuid NOT NULL,
  -- Root-actor attribution for the replay (mutate()'s cascade rule: a
  -- behaviour acts AS whoever triggered it, never as itself / system).
  -- text, NOT uuid — matching domain_events.actor_id: actor ids are
  -- usually actors.id uuids but the column contract tolerates sentinels
  -- (see services/nodes.ts loadActor); catch-up discards intents whose
  -- actor can't be resolved to a real row.
  actor_id text NOT NULL,
  -- Bearer-token id when the trigger came through /api/mcp — replay
  -- re-derives the token's tag scope so a crash can't strip the cascade's
  -- authority bound. NULL = session/native actor (no scope). text for the
  -- same tolerance reason as actor_id; an unresolvable id discards.
  token_id text,
  -- Same label queueDispatcher surfaces in DISPATCHER_FAILED audits.
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The catch-up scan is "everything" at boot and "older than a grace window"
-- on the interval — both walk created_at.
CREATE INDEX IF NOT EXISTS dispatcher_pending_created
  ON dispatcher_pending (created_at);
