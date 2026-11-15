import { isUuid } from "@onden/markdown";
import { inTransaction, q } from "../db.js";
import { nodeVisibilityCommitted } from "../spine/nodeHooks.js";
import { retypeGoverned } from "./attributeChange.js";
import {
  registerRestoreHandler,
  type EventRow, type RestoreContext, type RestoreError, type RestoreResult,
} from "./restoreContract.js";

type MembershipChange = { before_state_id: string | null; after_state_id: string | null };
type MembershipState = {
  is_applied: boolean;
  state_id: string | null;
  previous_state_id: string | null;
};

/** Capture an actual INSERT/DELETE for its TAG_APPLIED/TAG_REMOVED event.
 * Call in the same event transaction, before dispatching behaviours. The DB
 * owns state identities, including writes from imports and eventless producers.
 * This is history lineage, never a sync cursor or an authorization version. */
export async function recordedTagMembership(nodeId: string, tagId: string, applied: boolean) {
  if (!inTransaction()) throw new Error("tag membership event requires the state change transaction");
  const state = await readState(nodeId, tagId, true);
  if (!state || state.is_applied !== applied) {
    throw new Error("tag membership event does not match the stored relation");
  }
  return { membership_change: { before_state_id: state.previous_state_id, after_state_id: state.state_id } };
}

type TagMembershipPreview = {
  kind: "tag_apply" | "tag_remove";
  tag_name: string;
  currently_applied: boolean;
  can_apply_cleanly: boolean;
  force_available: false;
  reason?: string;
  conflict_code?: "state_conflict" | "history_incomplete" | "already_in_state";
};

async function readState(nodeId: string, tagId: string, lock: boolean) {
  return (await q<MembershipState>(
    `SELECT is_applied, state_id::text, previous_state_id::text FROM node_tag_states
      WHERE node_id = $1 AND tag_id = $2 ${lock ? "FOR UPDATE" : ""}`,
    [nodeId, tagId],
  )).rows[0];
}

function changeFrom(row: EventRow): MembershipChange | null {
  const raw = row.payload.membership_change;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const change = raw as Record<string, unknown>;
  const key = (value: unknown) => value === null || (typeof value === "string" && isUuid(value));
  if (!key(change.before_state_id) || !key(change.after_state_id)) return null;
  // An applied relation always has an identity; only a never-applied absence
  // (or its inverse) may have null. Both sides must describe distinct states.
  if (change.before_state_id === change.after_state_id) return null;
  if (row.event_type === "TAG_APPLIED" && change.after_state_id === null) return null;
  if (row.event_type === "TAG_REMOVED" && change.before_state_id === null) return null;
  return change as MembershipChange;
}

async function inspect(row: EventRow, lock: boolean) {
  const tagId = row.payload.tag_id ?? row.tx_meta?.tag_id;
  if (typeof tagId !== "string" || !isUuid(tagId)) {
    return { error: { code: "history_incomplete", status: 409, force_available: false,
      detail: "tag membership event is missing a valid tag id" } satisfies RestoreError };
  }
  const state = await readState(row.target_id, tagId, lock);
  const applied = state?.is_applied ?? false;
  const forwardApplied = row.event_type === "TAG_APPLIED";
  const change = changeFrom(row);
  let refusal: RestoreError | undefined;
  if (applied !== forwardApplied) {
    refusal = { code: "already_in_state", status: 409, detail: "tag membership already matches the inverse" };
  } else if (!change || !state) {
    refusal = { code: "history_incomplete", status: 409, force_available: false,
      detail: "tag membership history cannot identify the state this event changed" };
  } else if (state.state_id !== change.after_state_id) {
    refusal = { code: "state_conflict", status: 409, force_available: false,
      detail: "tag membership changed after this event; restore the later change first" };
  }
  return { tagId, state, applied, forwardApplied, change, refusal };
}

/** Refuse a stale membership even if a remove/reapply cycle looks identical.
 * Only this verified inverse restores the predecessor's identity. A later
 * inverse can then undo the preceding operation without losing newer changes.
 * Behaviours are not replayed; restoreEvent owns the explicit cascade selection. */
async function restoreTagMembership(row: EventRow, context: RestoreContext): Promise<RestoreResult | RestoreError> {
  const inspected = await inspect(row, true);
  if (inspected.error) return inspected.error;
  if (inspected.refusal) return inspected.refusal;
  const { tagId, forwardApplied, change } = inspected;
  if (!change) throw new Error("membership inverse requires a verified transition");
  if (forwardApplied) {
    await q(`DELETE FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [row.target_id, tagId]);
  } else {
    await q(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [row.target_id, tagId]);
  }
  // Which fields govern the note's values moved with the tag (D94).
  await retypeGoverned(row.workspace_id, { nodeIds: [row.target_id] });
  // Like the forward change: a tag joining or leaving a published note moves
  // its chips and tag page on the published site.
  await nodeVisibilityCommitted({ workspaceId: row.workspace_id, actor: context.actorContext, nodeIds: [row.target_id] });
  // The ordinary trigger already advanced membership_epoch atomically. Only
  // undo lineage returns to its predecessor; the sync epoch never goes back.
  await q(`UPDATE node_tag_states SET state_id = $3, previous_state_id = $4
    WHERE node_id = $1 AND tag_id = $2`, [row.target_id, tagId, change.before_state_id, change.after_state_id]);
  return context.record({
    eventType: forwardApplied ? "TAG_REMOVED" : "TAG_APPLIED",
    payload: { tag_id: tagId, tag_name: row.payload.tag_name,
      membership_change: { before_state_id: change.after_state_id, after_state_id: change.before_state_id } },
    inverseOp: forwardApplied ? "tag.applied" : "tag.removed",
    previous: null,
  });
}

async function previewTagMembershipRestore(row: EventRow): Promise<TagMembershipPreview | RestoreError> {
  const inspected = await inspect(row, false);
  if (inspected.error) return inspected.error;
  const { forwardApplied, applied, tagId, refusal } = inspected;
  return {
    kind: forwardApplied ? "tag_remove" : "tag_apply",
    tag_name: typeof row.payload.tag_name === "string" ? row.payload.tag_name : tagId,
    currently_applied: applied,
    can_apply_cleanly: !refusal,
    force_available: false,
    ...(refusal ? { reason: refusal.detail, conflict_code: refusal.code as TagMembershipPreview["conflict_code"] } : {}),
  };
}

registerRestoreHandler({
  eventTypes: ["TAG_APPLIED", "TAG_REMOVED"],
  restore: restoreTagMembership,
  preview: previewTagMembershipRestore,
});
