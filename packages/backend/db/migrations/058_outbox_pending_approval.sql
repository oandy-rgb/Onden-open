-- D7: approve-before-apply for outbound/irreversible effects, as an outbox
-- state — domain_events stays a pure append-only log of committed facts.
--
-- State machine: pending_approval → (owner approves) pending → done/dead
--                                 → (owner rejects)  dead
--
-- A delegated agent requesting an outbound effect (today: publish_site — the
-- "deploy the published website" request) enqueues it as 'pending_approval'.
-- The reconciler drains only 'pending', so the effect sits inert until a
-- human principal decides in the inbox. Nothing is built or exposed before
-- approval: the publish snapshot itself is only created when the approved
-- request is performed.

-- Collapse semantics for held requests, mirroring outbox_pending_dedup:
-- at most one awaiting-approval row per dedup_key (a burst of agent publish
-- requests folds into one decision).
CREATE UNIQUE INDEX IF NOT EXISTS outbox_pending_approval_dedup
  ON outbox (dedup_key)
  WHERE status = 'pending_approval';

-- The inbox approval queue scan.
CREATE INDEX IF NOT EXISTS outbox_awaiting_approval
  ON outbox (workspace_id, created_at DESC)
  WHERE status = 'pending_approval';
