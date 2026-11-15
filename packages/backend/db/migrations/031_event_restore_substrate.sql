-- Event-restore substrate — structural columns on domain_events for the
-- "LWW + strong event-based revert" path.
--
-- The user-facing promise: any DB-level state change should be revertable,
-- ideally as one click in TimelineView. To deliver that without paying
-- CRDT/OT complexity (per memory/feedback_problem_solving_reference_first
-- survey of 8 ref note apps), this migration adds three substrate columns:
--
--   1. tx_meta JSONB — open-ended context bundled with every event.
--      Logseq's `tx-meta` pattern (logseq-master/src/main/frontend/
--      handler/history.cljs + modules/outliner/op.cljs). Contents include:
--        - inverse_patch (string) — diff-match-patch unified inverse for
--          body markdown, mirroring etherpad-develop/src/static/js/
--          Changeset.ts `inverse()`. Avoids storing prev_body twice;
--          patches are typically <5% of body size for incremental edits.
--        - prev_field_values (object) — small fields (title, status,
--          attribute value) where storing prev value is cheaper than
--          diff-and-apply.
--        - cursor_state (object) — block_id + offset for restore-cursor
--          UX. Mirrors Logseq's restore-cursor! handler.
--        - ui_context (string) — which UI surface initiated this event,
--          useful for "revert all of my last 5 min of edits in canvas".
--      JSONB keeps the column schema-free; consumers read what they need.
--
--   2. triggered_by_event_id BIGINT — cause chain for dispatcher cascade.
--      When `dispatchTagApply` reacts to a `tag.applied` event by emitting
--      `attribute.set`, the dispatched event carries triggered_by pointing
--      at the cause. A single user action → cascade of derived events
--      forms a tree rooted at the user's event.
--      Reverting the root with `?cascade=true` walks this tree and reverts
--      children too. No ref note app implements this — emerged from
--      Onden's W4 MCP agent vision where a single agent action can ripple
--      across many rows via behaviour rules.
--      ON DELETE SET NULL so deleting a root doesn't cascade-delete events
--      (events are append-only via trigger; this is just FK hygiene for
--      the rare case where audit was manually pruned).
--
--   3. external BOOLEAN — marks events whose side effect is outside PG
--      and CANNOT be reverted by replaying inverse_patch.
--      Examples: writeAndCommit (FS git), pushNoteToBackup (GitHub API),
--      future MCP agent tool calls. The restore endpoint MUST NOT
--      attempt to undo these; UI shows "external — see <ref> for manual
--      revert". Same posture as git revert when commits have been pushed.
--
-- Indexes:
--   - triggered_by_event_id: cascade-walk is the hot path
--   - actor_id + created_at: per-actor scope revert
--     ("undo all of agent-X's actions in this window")
--   - external WHERE not external: cheap filter for "show me only
--     restorable events"
--
-- Trigger note:
--   The existing `domain_events_no_update` trigger blocks UPDATE. New
--   columns get values via INSERT only — this is consistent with the
--   append-only contract. Restoring an event does NOT mutate the event
--   row; it INSERTs a new event with `event_type = '*.reverted'` and a
--   triggered_by pointer at the reverted event.

ALTER TABLE domain_events
  ADD COLUMN IF NOT EXISTS tx_meta              jsonb   NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS triggered_by_event_id bigint  REFERENCES domain_events(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS external             boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS domain_events_triggered_by_idx
  ON domain_events (triggered_by_event_id)
  WHERE triggered_by_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS domain_events_actor_window_idx
  ON domain_events (actor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS domain_events_restorable_idx
  ON domain_events (workspace_id, created_at DESC)
  WHERE external = false;

-- The tx_meta column will accept arbitrary JSON; document the shape
-- callers should follow. PG cannot enforce structural sub-keys without
-- triggers, so this stays as application-layer discipline.
COMMENT ON COLUMN domain_events.tx_meta IS
  'Restore context for this event. Conventional keys: '
  'inverse_patch (string, diff-match-patch unified patch for body markdown), '
  'prev_field_values (object, {field: prev_value} for small fields), '
  'cursor_state (object, {block_id, offset} for editor restore), '
  'ui_context (string, which UI surface initiated the event).';

COMMENT ON COLUMN domain_events.triggered_by_event_id IS
  'Cause event in a dispatcher cascade. Reverting the root with ?cascade '
  'walks the tree and reverts children too.';

COMMENT ON COLUMN domain_events.external IS
  'true when this event has an out-of-PG side effect (FS git commit, '
  'GitHub push, external tool call). Restore endpoints MUST NOT attempt '
  'to replay inverse for these.';
