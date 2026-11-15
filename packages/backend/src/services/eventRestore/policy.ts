import { assertAuthority, type Authority } from "../../spine/authority.js";
import type { ActorCtx } from "../../types.js";
import { targetsNode } from "../eventTargets.js";

type RestorableEvent = {
  event_type: string;
  target_type: string;
  target_id: string;
  payload: Record<string, unknown>;
  tx_meta: Record<string, unknown>;
};

/** Authorize the operation the inverse will perform, under CURRENT policy.
 * History access uses retained nodes so trash never erases an access policy.
 * Tag membership also checks the tag's own apply/remove policy and scope;
 * permission-defining tag changes keep the principal-only administration gate.
 */
export async function authorizeRestore(
  actor: ActorCtx,
  event: RestorableEvent,
  asNewNode: boolean,
): Promise<void> {
  if (event.target_type === "tag") {
    // A tag definition is the workspace owner's to change, so to restore.
    await assertAuthority(actor, { kind: "principal_admin" });
    return;
  }
  if (!targetsNode(event.target_type)) return;

  let op: Extract<Authority, { kind: "retained_node" }>["op"] = asNewNode && event.event_type === "NODE_UPDATED" ? "read" : "write_node";
  if (event.event_type === "NODE_CREATED" || event.event_type === "NODE_UNDELETED") {
    op = "delete_node";
  } else if (event.event_type === "ATTRIBUTE_SET") {
    op = event.tx_meta?.inverse_op === "attribute.deleted" ? "delete_attribute" : "set_attribute";
  } else if (event.event_type === "ATTRIBUTE_DELETED") {
    op = "set_attribute";
  }
  await assertAuthority(actor, { kind: "retained_node", nodeId: event.target_id, op });

  if (event.event_type === "TAG_APPLIED" || event.event_type === "TAG_REMOVED") {
    const tagId = event.payload?.tag_id ?? event.tx_meta?.tag_id;
    // A malformed legacy event is rejected by its inverse handler, without
    // writing. Do not turn missing event metadata into a fabricated authority.
    if (typeof tagId === "string" && tagId) {
      await assertAuthority(actor, {
        kind: "tag", tagId, op: event.event_type === "TAG_APPLIED" ? "remove" : "apply",
      });
    }
  }
  if (event.event_type === "NODE_UPDATED" && asNewNode) {
    // A copy reads its source but never edits it. The duplicate operation also
    // checks the current parent and each copied direct tag under its lock.
    await assertAuthority(actor, { kind: "any_space_write" });
  }
}
