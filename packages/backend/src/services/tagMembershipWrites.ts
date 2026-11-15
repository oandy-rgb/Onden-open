import { q } from "../db.js";
import { db } from "../dbKysely.js";
import { TAG_NODE_TYPE } from "@onden/markdown/contract";
import type { ActorCtx } from "../types.js";
import { assertAuthority } from "../spine/authority.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { withIdempotencyClaim } from "../spine/idempotency.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { stampTransaction } from "../spine/stamps.js";
import { systemJobOf } from "../spine/systemJobs.js";
import { mutate } from "../spine/mutate.js";
import { recordedTagMembership } from "./tagMembership.js";
import { expandTemplate } from "./templateExpander.js";
import { applyFieldDefaults } from "./fieldDefaults.js";
import { retypeGoverned } from "./attributeChange.js";
import { StatusError } from "../statusError.js";
import { assertNotViewModuleTag, viewModuleOfTag } from "./viewModules.js";
import { liveNodeSql, liveTagNodeSql } from "../spine/nodeSql.js";

/** Record that a tag joined or left a note, in the caller's event transaction,
 *  after the node_tags row changed. The caller already authorized the change
 *  ({tag_membership} here, or its own check), so the spine records it `open`
 *  and links it to `causeEventId`. A tag that is no longer live records
 *  nothing and answers "". The payload names the tag and carries the
 *  membership identity (recordedTagMembership) that restore reads. */
async function recordTagEvent(
  type: "TAG_APPLIED" | "TAG_REMOVED", workspaceId: string, nodeId: string, tagId: string,
  actor: ActorCtx, causeEventId?: string,
): Promise<string> {
  const tag = await db.selectFrom("content_nodes").select("title")
    .where("id", "=", tagId).where("node_type", "=", TAG_NODE_TYPE).where("deleted_at", "is", null).executeTakeFirst();
  if (!tag) return "";
  const applied = type === "TAG_APPLIED";
  return mutate({
    actor, workspaceId,
    authority: { kind: "open", why: `${type} records a tag ${applied ? "application" : "removal"} the caller already authorized via {tag, ${applied ? "apply" : "remove"}}` },
    // A tag joining or leaving a published note changes its chips and tag
    // page (spine/nodeHooks.ts visibilityCommitted).
    visibilityChanged: [nodeId],
    event: {
      type, targetType: "node", targetId: nodeId,
      payload: { tag_id: tagId, tag_name: tag.title, ...await recordedTagMembership(nodeId, tagId, applied) },
      txMeta: { inverse_op: applied ? "tag.removed" : "tag.applied", tag_id: tagId },
      triggeredBy: causeEventId,
    },
    apply: async ({ eventId }) => eventId,
  });
}

export class TagMembershipError extends StatusError {
  constructor(message: string) {
    super(404, message);
    this.name = "TagMembershipError";
  }
}

type MembershipInput = {
  workspaceId: string;
  actor: ActorCtx;
  nodeId: string;
  tagId: string;
  /** Validate current authority and report whether membership would change;
   *  do not write membership, events, defaults or templates. */
  dryRun?: boolean;
  /** The caller's event this apply belongs to (a note's NODE_CREATED): the
   *  TAG_APPLIED chains to it, so undoing that event reverts the apply too. */
  causeEventId?: string;
};

/** Add a tag under current target read/write authority, tag apply policy and
 * both scopes. Token-only enrollment of an untagged ordinary node remains
 * supported; human scope and target/ancestor policies are never waived.
 * A true result means the membership changed (or would change in dry-run).
 * Repeating an already-present relationship records and seeds nothing again.
 * Membership, success history and synchronous effects share one transaction;
 * missing live targets throw TagMembershipError, other refusals propagate.
 * Like other event operations, a nested call remains subject to its caller's
 * transaction. Use: applyTagToNode({ workspaceId, actor, nodeId, tagId }). */
export function applyTagToNode(input: MembershipInput): Promise<boolean> {
  return changeMembership(input, "apply");
}

type AttachInput = {
  workspaceId: string;
  actor: ActorCtx;
  nodeId: string;
  tagId: string;
  /** The caller's event (NODE_CREATED, TAG_MERGED…); TAG_APPLIED chains to it. */
  causeEventId?: string;
  /** Template children and field defaults write INTO the note. false = only
   *  the membership and TAG_APPLIED (e.g. a note the actor may not
   *  write). Pass {depth, visitedTags} from inside template expansion. */
  content?: boolean | { depth: number; visitedTags: Set<string> };
};

/** The one apply contract for code already inside an event transaction whose
 * authority it has checked itself (creation paths, merge, import, template
 * children): link, TAG_APPLIED, template, field defaults. A row
 * that already existed reruns nothing. Returns whether the link was new.
 * Deliberate raw inserts elsewhere: tagMembership undo restore (replays
 * history), noteDuplicate (a copy keeps the source's state, records only),
 * siteConfig and task nodes (system rows with reserved tags). */
export async function attachTagInTx(input: AttachInput): Promise<boolean> {
  const { workspaceId, nodeId, tagId, actor, causeEventId, content = true } = input;
  // A view module tag (#月曆…) describes tags, never notes (rule 6): imports,
  // feeds and templates that name one skip it; a direct apply is refused below.
  if (await viewModuleOfTag(workspaceId, tagId)) return false;
  const inserted = await q(`INSERT INTO node_tags(node_id,tag_id) VALUES($1,$2)
    ON CONFLICT DO NOTHING RETURNING node_id`, [nodeId,tagId]);
  if (!inserted.rowCount) return false;
  // The tag's fields now govern the note's values (D94).
  await retypeGoverned(workspaceId, { nodeIds: [nodeId] });
  const eventId = await recordTagEvent("TAG_APPLIED", workspaceId,nodeId,tagId,actor,causeEventId) || causeEventId;
  if (content === false) return true;
  if (content === true) await expandTemplate(workspaceId,nodeId,tagId,actor,eventId);
  else await expandTemplate(workspaceId,nodeId,tagId,actor,eventId,content.depth,content.visitedTags);
  await applyFieldDefaults(workspaceId,nodeId,tagId,actor,eventId);
  return true;
}

/** Remove a currently authorized relationship. An absent relationship is a
 * no-op only after the same current target/tag checks. A removal records
 * TAG_REMOVED; nothing else runs. */
export function removeTagFromNode(input: MembershipInput): Promise<boolean> {
  return changeMembership(input, "remove");
}

function changeMembership(input: MembershipInput, operation: "apply" | "remove"): Promise<boolean> {
  const { workspaceId, nodeId, tagId, dryRun = false } = input;
  // A change that finds nothing to do still claims the request's Idempotency-Key, so a retry after a lost
  // reply is acknowledged (app.ts replay shield) even when the note or tag is gone by then.
  return withIdempotencyClaim(workspaceId, (claim) => withEventTransaction(workspaceId, async () => {
    // Do not trust role/scope captured before waiting for the shared event lock.
    const actor = await resolveCurrentActor(input.actor, workspaceId);
    const tag = await q(`SELECT 1 FROM content_nodes WHERE id=$1 AND workspace_id=$2
      AND ${liveTagNodeSql()}`, [tagId,workspaceId]);
    if (!tag.rows.length) throw new TagMembershipError("tag not found");
    const node = await q(`SELECT 1 FROM content_nodes WHERE id=$1 AND workspace_id=$2 AND ${liveNodeSql()}`, [nodeId,workspaceId]);
    if (!node.rows.length) throw new TagMembershipError("node not found");
    await assertAuthority(actor, { kind: "tag_membership", nodeId, tagId, op: operation });
    if (operation === "apply") await assertNotViewModuleTag(workspaceId, tagId);

    if (!dryRun) await claim();
    // The link row is written before the first event goes through mutate(), so the transaction is stamped here, with
    // the actor as author; else the row's stamp is made by the trigger with no author.
    if (!dryRun) await stampTransaction(workspaceId, actor.id, { system: !!systemJobOf(actor) });
    if (dryRun) {
      const existing = await q("SELECT 1 FROM node_tags WHERE node_id=$1 AND tag_id=$2", [nodeId,tagId]);
      return operation === "apply" ? existing.rows.length === 0 : existing.rows.length > 0;
    }
    if (operation === "apply") {
      if (!await attachTagInTx({ workspaceId, nodeId, tagId, actor, causeEventId: input.causeEventId })) return false;
    } else {
      const removed = await q("DELETE FROM node_tags WHERE node_id=$1 AND tag_id=$2 RETURNING node_id", [nodeId,tagId]);
      if (!removed.rowCount) return false;
      await retypeGoverned(workspaceId, { nodeIds: [nodeId] });
      await recordTagEvent("TAG_REMOVED", workspaceId,nodeId,tagId,actor);
    }
    // node_tags triggers record membership identity and epoch in this same tx.
    return true;
  }));
}
