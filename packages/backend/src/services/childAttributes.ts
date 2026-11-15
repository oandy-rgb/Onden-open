// `child:` prefix attributes — Trilium's copying-inheritance pattern.
//
// A parent node carrying an attribute named `child:status` with value
// `todo` causes any new direct child to receive `status=todo` at create
// time. The prefix is stripped on copy. The propagation is a
// one-shot — purely the initial value, not a live link — so the child
// is free to overwrite without disturbing the parent or siblings.
//
// Why not "real" inheritance (per-attribute is_inheritable scope-down):
// CSS-style cascade brings specificity wars and "spooky action" at
// scale (Logseq abandoned inherited block-properties for the same
// reason). `child:` is the conservative middle ground — explicit,
// one-shot, opt-in per attribute, and the parent's row is plainly
// visible in the attribute panel.
//
// Scope: only direct children. Re-applying inheritance recursively
// would require the parent's parent's `child:` attributes too, which
// CSS-style mental model again; stay shallow.

import { isSystemAttr } from "@onden/markdown";
import { q } from "../db.js";
import type { ActorCtx } from "../types.js";
import { recordAttributeChange } from "./attributeChange.js";

/** Copy the parent's `child:*` attributes onto a new direct child, each an
 *  ATTRIBUTE_SET (services/attributeChange.ts) so it syncs and undoes. Call
 *  inside the child's creation, whose cascade authorizes the copies; a value
 *  the child already has is kept. */
export async function applyChildPrefixAttributes(
  workspaceId: string,
  parentNodeId: string,
  childNodeId: string,
  actor: ActorCtx,
): Promise<void> {
  const parentAttrs = await q<{ key: string; value: string; value_type: string }>(
    `SELECT key, value, value_type
     FROM node_attributes
     WHERE workspace_id = $1 AND node_id = $2
       AND key LIKE 'child:%'`,
    [workspaceId, parentNodeId],
  );

  for (const attr of parentAttrs.rows) {
    const targetKey = attr.key.slice("child:".length);
    // Reserved-key system attributes (`child:_x`) are skipped — those are
    // dispatcher / template internals and were never intended as a
    // user-facing inheritance surface. (Not in SQL: `_` is a LIKE wildcard.)
    if (!targetKey || isSystemAttr(targetKey)) continue;
    await recordAttributeChange({
      workspaceId, nodeId: childNodeId, key: targetKey, actor,
      next: { value: attr.value, value_type: attr.value_type, is_inheritable: false, source: "derived" },
      rule: "absent", inheritedAtCreation: true,
      authority: { kind: "cascade" },
      uiContext: "node.child_prefix",
      payload: { from_parent: parentNodeId },
    });
  }
}
