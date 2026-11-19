// A new note's place on the site, decided by where it is made (owner 2026-11-13):
// made under a note that is 「不發布」, it starts 「不發布」 too. The rule itself is
// @onden/markdown newNoteSiteDefault (the app predicts offline notes with it).
//
// Two attributes carry it, no new column: `_published` 'false' (what the site
// reads, so publishedSet.ts needs no new case) and `_published_by_parent`, which
// says nobody chose that 「不發布」 on this note: the site row and the publish
// preview can then tell the person why it is off. Only the new note is written;
// notes that exist, or are moved, are never re-judged.

import { KEPT_OFF_BY_PARENT_ATTR_KEY, PUBLISHED_ATTR_KEY, newNoteSiteDefault } from "@onden/markdown";
import { db } from "../dbKysely.js";
import type { ActorCtx } from "../types.js";
import { StatusError } from "../statusError.js";
import { recordAttributeChange } from "./attributeChange.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { subtreeIds } from "./nodeTree.js";

/** Give the new note `childId` the site default of its direct parent. Call inside
 *  the note's creation (createNote, a copy, a template slot), whose cascade
 *  authorizes the writes. A `_published` the note already has is kept. */
export async function applyParentSiteDefault(workspaceId: string, parentId: string, childId: string, actor: ActorCtx, triggeredBy?: string): Promise<void> {
  const flag = await db.selectFrom("node_attributes").select("value")
    .where("workspace_id", "=", workspaceId).where("node_id", "=", parentId).where("key", "=", PUBLISHED_ATTR_KEY).executeTakeFirst();
  const attrs = newNoteSiteDefault(flag ? { [PUBLISHED_ATTR_KEY]: flag.value } : null);
  if (!attrs) return;
  const written = await recordAttributeChange({
    workspaceId, nodeId: childId, key: PUBLISHED_ATTR_KEY, actor,
    next: { value: attrs[PUBLISHED_ATTR_KEY]!, value_type: "text", is_inheritable: false, source: "derived" },
    rule: "absent", inheritedAtCreation: true, authority: { kind: "cascade" }, uiContext: "node.site_default", payload: { from_parent: parentId }, triggeredBy,
  });
  if (!written.written) return;
  await recordAttributeChange({
    workspaceId, nodeId: childId, key: KEPT_OFF_BY_PARENT_ATTR_KEY, actor,
    next: { value: "true", value_type: "text", is_inheritable: false, source: "derived" },
    rule: "always", inheritedAtCreation: true, authority: { kind: "cascade" }, uiContext: "node.site_default", payload: { from_parent: parentId }, triggeredBy,
  });
}

/** A person's own say on the note (「不發布」, 「發布」, 「放回網站」) replaces the
 *  default, so the mark that it was inherited goes. Nothing there: nothing written. */
export async function dropParentSiteDefaultMark(workspaceId: string, nodeId: string, actor: ActorCtx): Promise<void> {
  const has = await db.selectFrom("node_attributes").select("key")
    .where("workspace_id", "=", workspaceId).where("node_id", "=", nodeId).where("key", "=", KEPT_OFF_BY_PARENT_ATTR_KEY).executeTakeFirst();
  if (!has) return;
  await recordAttributeChange({
    workspaceId, nodeId, key: KEPT_OFF_BY_PARENT_ATTR_KEY, actor, next: null, rule: "always",
    authority: { kind: "cascade" }, uiContext: "node.site_default.cleared",
  });
}

/** What the site says about a note as stored (`_published` and the inherited mark), for the reply to a create: the app
 *  drew a prediction while the request was out, and settles on this. Empty when the note carries neither. */
export async function siteAttributesOf(nodeId: string): Promise<Record<string, string>> {
  const rows = await db.selectFrom("node_attributes").select(["key", "value"])
    .where("node_id", "=", nodeId).where("key", "in", [PUBLISHED_ATTR_KEY, KEPT_OFF_BY_PARENT_ATTR_KEY]).execute();
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

/** 「不發布這則」 with 「一起不發布」 (owner 2026-11-14): `rootId` and every live
 *  note under it are kept off the site in ONE action. The root's
 *  ATTRIBUTE_SET is the cause and each descendant's is triggered by it, so
 *  restoreEvent(rootEvent, { cascade: true }) is one undo for the whole group.
 *  Each note is judged by its own `set_attribute` authority (no `cascade`
 *  shortcut), in one transaction: a note the actor may not change refuses the
 *  whole action and nothing is written. Notes already 「不發布」 are left as they
 *  are. Returns how many notes were newly marked, the root included. */
export async function keepSubtreeOffSite(authenticated: ActorCtx, workspaceId: string, rootId: string): Promise<{ marked: number; rootEventId: string }> {
  return withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(authenticated, workspaceId);
    const ids = await subtreeIds(workspaceId, rootId, { lifecycle: "live", includeRoot: true, skipTagDefinitions: true });
    if (ids[0] !== rootId) throw new StatusError(404, "node not found");
    const already = new Set((await db.selectFrom("node_attributes").select("node_id")
      .where("workspace_id", "=", workspaceId).where("node_id", "in", ids).where("key", "=", PUBLISHED_ATTR_KEY).where("value", "=", "false")
      .execute()).map((row) => row.node_id));
    let rootEventId = "";
    let marked = 0;
    for (const nodeId of ids) {
      // The root is always written: it is the cause the others hang from.
      if (nodeId !== rootId && already.has(nodeId)) continue;
      const written = await recordAttributeChange({
        workspaceId, nodeId, key: PUBLISHED_ATTR_KEY, actor,
        next: { value: "false", value_type: "text", is_inheritable: false, source: "ui" },
        rule: "always", validate: true,
        authority: { kind: "node", nodeId, op: "set_attribute" },
        uiContext: "node.site_keep_off_subtree",
        triggeredBy: nodeId === rootId ? undefined : rootEventId,
      });
      if (!written.written) continue;
      if (nodeId === rootId) rootEventId = written.eventId;
      await dropParentSiteDefaultMark(workspaceId, nodeId, actor);
      marked++;
    }
    return { marked, rootEventId };
  });
}
