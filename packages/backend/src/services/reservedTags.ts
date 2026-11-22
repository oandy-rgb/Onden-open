// System-reserved class tags, found by role (content_nodes.reserved_key,
// migration 100) instead of by title. A reserved tag is an ordinary tag to the
// user — renameable, colourable — but the code that gives it meaning (tasks,
// pages, site settings) must not depend on what it is called.

import { q } from "../db.js";
import { db } from "../dbKysely.js";
import { mutate } from "../spine/mutate.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import type { ActorCtx } from "../types.js";
import { insertTagRow } from "./tagWrites.js";
import { TASKS_MODULE_ID, TASK_TAG_NAME } from "../spine/taskIdentity.js";
import { isViewLayout } from "./viewLayouts.js";
import { workspaceUsesModule } from "./workspaceModules.js";

import { RESERVED_TAGS, reservedTagPredicate, type ReservedTagKey } from "../spine/reservedTagKeys.js";
import { liveTagNodeSql, tagNodeSql } from "../spine/nodeSql.js";
import { TAG_NODE_TYPE } from "@onden/markdown/contract";

export { RESERVED_TAGS, reservedTagPredicate, type ReservedTagKey };

export async function reservedTagId(workspaceId: string, key: ReservedTagKey): Promise<string | null> {
  const r = await q<{ id: string }>(
    `SELECT id FROM content_nodes t WHERE t.workspace_id = $1 AND ${reservedTagPredicate("t", key, { lifecycle: "live" })} LIMIT 1`,
    [workspaceId],
  );
  return r.rows[0]?.id ?? null;
}

/** Give `key` to the live root tag titled `key` when no tag holds it — a tag
 *  restored from a backup or created by hand before the key existed. Returns
 *  the adopted id. Records a role, not a user-visible change, so it appends no
 *  event; it runs under the event lock so it cannot race a concurrent ensure. */
export async function adoptReservedTag(workspaceId: string, key: ReservedTagKey): Promise<string | null> {
  // Read first: this runs on every site-config read, and only a restored or
  // hand-made tag ever needs the write (which takes the event lock).
  const candidate = await db.selectFrom("content_nodes").select("id")
    .where("workspace_id", "=", workspaceId).where("node_type", "=", TAG_NODE_TYPE).where("deleted_at", "is", null)
    .where("parent_id", "is", null).where("title", "=", key).where("reserved_key", "is", null)
    .limit(1).executeTakeFirst();
  if (!candidate) return null;
  return withEventTransaction(workspaceId, async () => {
    const r = await q<{ id: string }>(
      `UPDATE content_nodes SET reserved_key = $2
        WHERE id = (SELECT id FROM content_nodes
                     WHERE workspace_id = $1 AND ${liveTagNodeSql()}
                       AND parent_id IS NULL AND title = $2 AND reserved_key IS NULL
                     ORDER BY created_at, id LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM content_nodes h WHERE h.workspace_id = $1 AND ${reservedTagPredicate("h", key, { lifecycle: "live" })})
        RETURNING id`,
      [workspaceId, key],
    );
    return r.rows[0]?.id ?? null;
  });
}

/** A change to a reserved tag's definition that would break the code that
 *  finds it by role; answered 409 with `body` (httpError.ts). A module's own
 *  tag (`module` set) answers `module_tag` — a different sentence for the
 *  person: it is the module that is on, not a system role. */
export class ReservedTagError extends Error {
  readonly status = 409;
  readonly body: { error: "reserved_tag" | "module_tag"; detail: string };
  constructor(readonly reservedKey: string, change: TagDefinitionChange, readonly module?: string) {
    const what = change === "merge_target" ? "merged into" : change === "merge_source" ? "merged away" : "deleted";
    const detail = module
      ? `#${reservedKey} is the tag of the ${module} module, which is on, and cannot be ${what}`
      : `#${reservedKey} is a system tag and cannot be ${what}`;
    super(detail);
    this.name = "ReservedTagError";
    this.body = { error: module ? "module_tag" : "reserved_tag", detail };
  }
}

export type TagDefinitionChange = "delete" | "merge_source" | "merge_target";

/** Refuse (ReservedTagError, 409) a change that would end or absorb a tag the
 *  code finds by role: deleting it, merging it away, or merging another tag
 *  into it. Three kinds:
 *   - a reserved tag (reserved_key: pages, site settings), always;
 *   - the tasks module's tag, always (the module finds and makes it by its mark);
 *   - the own tag of any other module (capture's 收件匣, skills, review…) while that module is ON
 *     in the workspace. Off, it is an ordinary tag again: Settings › the module lists it so it can
 *     be deleted (RemovedModuleTags). Turning the module on makes it again (the inbox, deleted before this rule,
 *     is brought back: moduleTagRevive.reviveModuleTag). A view module's leftover tag is not one: nothing reads
 *     it, the module cannot be turned off, and merge already refuses it (view_module_tag).
 *  A trashed #task would be re-minted and its old row could never come back
 *  (content_nodes_reserved_key_uq), and notes merged into #workspace-config
 *  would turn into config nodes. Renaming and recolouring stay allowed.
 *  No-op for an ordinary tag or any other node; lifecycle-agnostic, like the
 *  key itself. Every path that trashes a row passes through here via
 *  nodeTrash.markTrashed; tag merge checks both ends up front. */
export async function assertTagDefinitionChange(nodeId: string, change: TagDefinitionChange): Promise<void> {
  const row = (await q<{ workspace_id: string; title: string; reserved_key: string | null; module: string | null }>(
    `SELECT workspace_id, title, reserved_key, tag_schema->>'module' AS module FROM content_nodes
      WHERE id = $1 AND ${tagNodeSql()}`,
    [nodeId],
  )).rows[0];
  if (!row) return;
  if (row.reserved_key) throw new ReservedTagError(row.reserved_key, change);
  if (!row.module) return;
  // Tasks: task nodes no longer depend on the tag (they reference the function, taskIdentity.hasTaskRefSql),
  // but the module still finds and makes it by its mark (function-refs-b3 proposal §4 item 5).
  if (row.module === TASKS_MODULE_ID) throw new ReservedTagError(TASK_TAG_NAME, change);
  if (isViewLayout(row.module)) return;
  // As a merge target, tagMerge.assertMergeTarget already refuses every module tag, on or off
  // (merge_into_module_tag): the wider rule, with its own sentence.
  if (change === "merge_target") return;
  if (await workspaceUsesModule(row.workspace_id, row.module)) throw new ReservedTagError(row.title, change, row.module);
}
