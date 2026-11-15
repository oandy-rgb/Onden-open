-- 068_membership_epoch.sql
--
-- The membership-reconciliation keystone (docs/architecture/membership-and-
-- permission-epoch.md). A workspace-scoped monotonic counter bumped IN THE SAME
-- TRANSACTION as any change that can alter the result of readableNodeIdSet()
-- (role / matter scope / token scope / tag policy / permission tag apply-remove /
-- reparent / restore of any of those). The sync client compares its last-seen
-- epoch to this; it runs the (expensive) membership reconciliation ONLY when the
-- epoch advanced, taking the cheap event-cursor path otherwise.
--
-- Starts at 0; every readable-set-affecting commit does
--   UPDATE workspaces SET membership_epoch = membership_epoch + 1 WHERE id = $1
-- via bumpMembershipEpoch() (q(), so it joins the caller's transaction — NOT
-- pool.query, which would commit independently and break atomicity).

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS membership_epoch BIGINT NOT NULL DEFAULT 0;
