import { q } from "../db.js";
import { CodedStatusError } from "../statusError.js";
import { tagNodeSql } from "../spine/nodeSql.js";
import { TAG_NODE_TYPE, isTag } from "@onden/markdown/contract";

// The tag tree and the note tree are separate (audit T12, user decision
// 2026-10-18): a tag's parent is a tag or none; a note's (or board's) parent
// is not a tag. Mixing them made a note's parent menu list tags, and trashing
// a note could take a workspace-wide tag with it (the trash cascade follows
// parent_id).
//
// Checked where a NEW parent is written: creating a note (noteCreate), a tag
// (tagWrites.insertTagRow), reparenting (nodeTree.assertReparent, for
// nodeUpdate, tagMerge and undo, only when parent_id changes) and pinning a
// note under another (services/pointers.ts createPointer, D101). Rows that already mix them are not moved and still read, render,
// save and trash; an edit that keeps their parent is not refused. Find them
// with packages/backend/scripts/mixed-parent-rows.sql.
//
// The 功能 layer takes no part in the tag tree either (owner decision
// 2026-10-24, docs/architecture/module-library.md「模型：分層的圖」): a module
// tag has no parent tag and no tag sits under one; a tag gets a function by
// extending it. assertModuleTagEdge is checked at the same places. Rows that
// already break it are fixed by migration 129 (module-tag-parent-rows.sql
// lists them).

/** A parent of the wrong kind. 409 `parent_kind_mismatch` at the HTTP
 *  boundary (httpError.ts); `detail` says which way. */
export class ParentKindError extends CodedStatusError {
  constructor(readonly childIsTag: boolean) {
    super(409, "parent_kind_mismatch", childIsTag ? "a tag's parent must be a tag" : "a note's parent cannot be a tag");
  }
}

/** Refuse `parentId` as the parent of a node of `childNodeType`. No parent
 *  (null) is always fine. A parent that is not there is the caller's to judge
 *  (its placement check answers 404 without an existence probe); this only
 *  compares kinds. Runs in the caller's transaction (q). */
export async function assertParentKind(workspaceId: string, childNodeType: string, parentId: string | null): Promise<void> {
  if (!parentId) return;
  const parent = (await q<{ node_type: string }>(
    `SELECT node_type FROM content_nodes WHERE workspace_id = $1 AND id = $2`, [workspaceId, parentId],
  )).rows[0];
  if (!parent) return;
  const childIsTag = childNodeType === TAG_NODE_TYPE;
  if (childIsTag !== (isTag(parent))) throw new ParentKindError(childIsTag);
}

/** A module tag with a parent, or a tag under a module tag. 409
 *  `module_tag_parent` at the HTTP boundary (httpError.ts). */
export class ModuleTagParentError extends CodedStatusError {
  constructor(readonly childIsModule: boolean) {
    super(409, "module_tag_parent", childIsModule ? "a function (module tag) cannot have a parent tag" : "a tag cannot be placed under a function (module tag)");
  }
}

/** Refuse a tag edge that touches the function layer: `parentId` set on a
 *  module tag, or `parentId` being a module tag. `child` is a row already
 *  there (`id`) or a tag about to be inserted (`isModule`). No parent is
 *  always fine. Runs in the caller's transaction (q). */
export async function assertModuleTagEdge(
  workspaceId: string, child: { id: string } | { isModule: boolean }, parentId: string | null,
): Promise<void> {
  if (!parentId) return;
  const parent = (await q<{ is_module: boolean }>(
    `SELECT (${tagNodeSql()} AND tag_schema->>'module' IS NOT NULL) AS is_module
       FROM content_nodes WHERE workspace_id = $1 AND id = $2`, [workspaceId, parentId],
  )).rows[0];
  if (!parent) return;
  if (parent.is_module) throw new ModuleTagParentError(false);
  const childIsModule = "isModule" in child ? child.isModule : Boolean((await q<{ is_module: boolean }>(
    `SELECT (${tagNodeSql()} AND tag_schema->>'module' IS NOT NULL) AS is_module
       FROM content_nodes WHERE workspace_id = $1 AND id = $2`, [workspaceId, child.id],
  )).rows[0]?.is_module);
  if (childIsModule) throw new ModuleTagParentError(true);
}
