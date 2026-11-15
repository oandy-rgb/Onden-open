// P2 tag merge: fold #source into #target. Mechanics chosen for
// reversibility WITHOUT new restore machinery:
//   • every source member gains #target through the FULL apply path
//     (node_tags insert + dispatchTagApply + expandTemplate +
//     applyFieldDefaults) — target's contract genuinely applies, and every
//     TAG_APPLIED chains triggered_by to the one TAG_MERGED root, so the
//     cascade-preview shows the whole blast radius;
//   • the source tag is then soft-DELETED, NOT stripped: its junction rows
//     survive invisibly, so undeleting #source from the Trash dissolves the
//     merge (both tags coexist again).
// Schema posture: target's schema WINS; source-only fields' values stay as
// plain properties (fields assist, they don't imprison). Owner-only, and never
// with a reserved tag on either end (services/reservedTags.ts).
// Routes (routes/tags.ts) only parse the request and shape the response;
// refusals throw TagMergeError, which httpError.ts answers with its body.

import { pool, q } from "../db.js";
import type { ActorCtx } from "../types.js";
import { mutate } from "../spine/mutate.js";
import { assertAuthority } from "../spine/authority.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { canSeeTag, readableScopeSql } from "./readPolicy.js";
import { spaceCanWrite } from "../spine/spaceScope.js";
import { attachTagInTx } from "./tagMembershipWrites.js";
import { descendantsOf, TagNameConflictError } from "./tagHierarchy.js";
import { assertReparent } from "./nodeTree.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { markTrashed } from "./nodeTrash.js";
import { nodeLifecycleCommitted } from "../spine/nodeHooks.js";
import { assertTagDefinitionChange } from "./reservedTags.js";
import { loadExtendsGraph, wouldCreateExtendsCycle } from "./functionRefs.js";
import { extendsIdsOf } from "./tagExtendsList.js";
import { changeTagSchema } from "./tagWrites.js";
import { retypeGoverned } from "./attributeChange.js";
import { moduleMarkerOfTag, viewModuleOfTag, ViewModuleTagError } from "./viewModules.js";
import { liveTagNodeSql, tagNodeSql } from "../spine/nodeSql.js";
import { db } from "../dbKysely.js";
import { sql } from "kysely";
import { TAG_NODE_TYPE } from "@onden/markdown/contract";

/** A merge the request asked for but can't happen; `body` is the response. */
export class TagMergeError extends Error {
  constructor(readonly status: 400 | 404 | 409, readonly body: { error: string; detail?: string }) {
    super(body.detail ?? body.error);
    this.name = "TagMergeError";
  }
}

const notFound = () => new TagMergeError(404, { error: "tag not found" });
const intoItself = () => new TagMergeError(400, { error: "cannot merge a tag into itself" });

/** Both tags, visible to the actor, or a 404 (a hidden tag reads as missing). */
async function assertBothVisible(actor: ActorCtx, sourceId: string, targetId: string): Promise<void> {
  if (!(await canSeeTag(actor, sourceId)) || !(await canSeeTag(actor, targetId))) throw notFound();
}

/** Neither end may be a reserved tag: #source would be trashed, and folding
 *  notes into #target would give them its system role. */
async function assertMergeable(workspaceId: string, sourceId: string, targetId: string): Promise<void> {
  await assertTagDefinitionChange(sourceId, "merge_source");
  await assertTagDefinitionChange(targetId, "merge_target");
  // A view module tag (#月曆…) has no notes of its own and is never applied to
  // one (rule 6), so it can be neither end.
  for (const id of [sourceId, targetId]) {
    const view = await viewModuleOfTag(workspaceId, id);
    if (view) throw new TagMergeError(409, { error: "view_module_tag", detail: new ViewModuleTagError(view.module, view.title).message });
  }
}

/** #target may not be one of #source's own sub-tags (once #source's children move under #target it would be its own parent)
 *  nor a module tag (a tag that provides a module is not a place to collect notes). The picker leaves both out
 *  (frontend components/tagPage/useTagMerge.ts); these are the refusals behind it. */
async function assertMergeTarget(workspaceId: string, sourceId: string, targetId: string): Promise<void> {
  if ((await descendantsOf(workspaceId, sourceId)).includes(targetId)) {
    throw new TagMergeError(400, { error: "merge_into_sub_tag", detail: "cannot merge a tag into one of its own sub-tags" });
  }
  const module = await moduleMarkerOfTag(workspaceId, targetId);
  if (module) throw new TagMergeError(409, { error: "merge_into_module_tag", detail: "cannot merge a tag into a module tag" });
}

type ExtendsRepoint = {
  tag: { id: string; title: string; tag_schema: Record<string, unknown> | null };
  extends: string[];
};

/** The live tags that extend #source, each with its extends list re-pointed at
 *  #target (D57). Membership and inherited fields/modules follow `extends` as
 *  well as parent_id, so leaving the list naming the trashed source would drop
 *  the extender's notes from #target. A tag already extending #target too keeps
 *  it once, and #target itself just stops extending #source. Throws 409 when a
 *  re-point would make tags extend each other (#target extends the extender). */
async function planExtendsRepoints(
  workspaceId: string, sourceId: string, target: { id: string; title: string }, lock: boolean,
): Promise<ExtendsRepoint[]> {
  // #source is trashed by the merge: judge cycles without it.
  const abilities = (await loadExtendsGraph(workspaceId)).filter((r) => r.id !== sourceId);
  const repointed = new Map<string, string[]>();
  for (const row of abilities) {
    const list = extendsIdsOf(row.extends);
    if (!list.includes(sourceId)) continue;
    const next = [...new Set(list.map((id) => (id === sourceId ? target.id : id)))].filter((id) => id !== row.id);
    repointed.set(row.id, next);
  }
  if (!repointed.size) return [];
  const tags = await q<{ id: string; title: string; tag_schema: Record<string, unknown> | null }>(
    `SELECT id, title, tag_schema FROM content_nodes
      WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND ${liveTagNodeSql()}
      ORDER BY id${lock ? " FOR UPDATE" : ""}`,
    [workspaceId, [...repointed.keys()]],
  );
  const after = abilities.map((r) => (repointed.has(r.id) ? { ...r, extends: repointed.get(r.id) } : r));
  for (const tag of tags.rows) {
    if (wouldCreateExtendsCycle(after, tag.id, repointed.get(tag.id)!)) {
      throw new TagMergeError(409, {
        error: "extends_cycle",
        detail: `#${tag.title} extends this tag and #${target.title} extends #${tag.title}; change one of them first`,
      });
    }
  }
  return tags.rows.map((tag) => ({ tag, extends: repointed.get(tag.id)! }));
}

/** What merging would do, counted over the caller's readable members. */
export async function previewTagMerge(actor: ActorCtx, workspaceId: string, sourceId: string, targetId: string) {
  if (!targetId) throw new TagMergeError(400, { error: "target query param required" });
  if (targetId === sourceId) throw intoItself();
  // Member COUNTS below are readable-scoped, but the preview also exposes both
  // tags' titles and field names — a hidden endpoint reads as nonexistent.
  await assertBothVisible(actor, sourceId, targetId);
  await assertMergeable(workspaceId, sourceId, targetId);
  await assertMergeTarget(workspaceId, sourceId, targetId);
  const tags = await pool.query<{ id: string; title: string }>(
    `SELECT id, title FROM content_nodes
      WHERE id = ANY($1::uuid[]) AND workspace_id = $2 AND ${liveTagNodeSql()}`,
    [[sourceId, targetId], workspaceId],
  );
  const source = tags.rows.find((t) => t.id === sourceId);
  const target = tags.rows.find((t) => t.id === targetId);
  if (!source || !target) throw notFound();

  // Scope the counts to the caller's READABLE members — an unscoped count leaks
  // how many read-restricted nodes carry #source / already carry #target (L3).
  const memberParams: unknown[] = [sourceId, targetId];
  const memberScope = readableScopeSql(actor, "n", memberParams);
  const { rows: visible } = await pool.query<{ node_id: string; in_target: boolean }>(
    `SELECT nt.node_id, EXISTS (
        SELECT 1 FROM node_tags t2 WHERE t2.node_id = nt.node_id AND t2.tag_id = $2
      ) AS in_target
      FROM node_tags nt
      JOIN content_nodes n ON n.id = nt.node_id
     WHERE nt.tag_id = $1 AND ${memberScope}`,
    memberParams,
  );
  const fieldNames = async (tagNodeId: string): Promise<string[]> => {
    // P4.1 CONTRACT: read fields off the class_tag node's own tag_schema.
    const r = await pool.query<{ fields: Array<{ name?: string }> | null }>(
      `SELECT tag_schema->'fields' AS fields FROM content_nodes
        WHERE id = $1 AND ${tagNodeSql()} LIMIT 1`, [tagNodeId]);
    return (r.rows[0]?.fields ?? []).map((f) => f?.name).filter((n): n is string => !!n);
  };
  const sourceFields = await fieldNames(source.id);
  const targetFields = new Set(await fieldNames(target.id));
  const repoints = await planExtendsRepoints(workspaceId, source.id, target, false);
  // The merge soft-deletes #source, and the functions and views it holds stay on it in the Trash: they are not given to #target.
  const held = await db.selectFrom("function_refs")
    .select([sql<number>`count(*) FILTER (WHERE instance = '')::int`.as("functions"), sql<number>`count(*) FILTER (WHERE instance <> '')::int`.as("views")])
    .where("workspace_id", "=", workspaceId).where("holder_node_id", "=", source.id).executeTakeFirst();
  return {
    source: { id: source.id, name: source.title },
    target: { id: target.id, name: target.title },
    members_gaining_target: visible.filter((m) => !m.in_target).length,
    already_in_target: visible.filter((m) => m.in_target).length,
    fields_only_in_source: sourceFields.filter((f) => !targetFields.has(f)),
    // What #source has that #target does NOT get: the merge moves notes, not functions or views.
    functions_not_carried: held?.functions ?? 0,
    views_not_carried: held?.views ?? 0,
    // Tags extending #source that will extend #target instead.
    extenders_repointed: repoints.length,
    reversible: true, // undelete #source from Trash dissolves the merge
  };
}

/** Fold #source into #target. Returns how many members gained #target and the
 *  TAG_MERGED event id (the full-undo handle). */
export async function mergeTags(actor: ActorCtx, workspaceId: string, sourceId: string, targetId: string): Promise<{ applied: number; mergeEventId: string }> {
  // The owner's, decided before anything about the tags is looked up (the
  // mutate below re-checks under the lock).
  await assertAuthority(actor, { kind: "principal_admin" });
  if (targetId === sourceId) throw intoItself();
  // Both tags must be visible to the caller (a tag-scoped admin cannot merge
  // tags outside its scope); an invisible tag answers exactly like a missing one.
  await assertBothVisible(actor, sourceId, targetId);
  // reserved_key is set when a tag is created or adopted and never cleared,
  // so checking before the lock is as good as under it.
  await assertMergeable(workspaceId, sourceId, targetId);
  // Merging a parent into its own descendant would point that descendant's
  // parent_id at itself once #source's children are reparented onto #target.
  await assertMergeTarget(workspaceId, sourceId, targetId);
  let mergeEventId = "";
  // The tags and #source's members are read under the event lock, so a
  // member added while this request waited is merged too, and the event's
  // member_count matches what was moved.
  const merged = await withEventTransaction(workspaceId, async () => {
    // The child moves below are judged for the actor as it is now.
    const current = await resolveCurrentActor(actor, workspaceId);
    const tags = await q<{ id: string; title: string }>(
      `SELECT id, title FROM content_nodes
        WHERE id = ANY($1::uuid[]) AND workspace_id = $2 AND ${liveTagNodeSql()}
        FOR UPDATE`,
      [[sourceId, targetId], workspaceId],
    );
    const source = tags.rows.find((t) => t.id === sourceId);
    const target = tags.rows.find((t) => t.id === targetId);
    if (!source || !target) return null;
    // Trashed members are included: a note restored later must still carry
    // #target, since #source is gone. They get the link only (see below).
    const members = await q<{ node_id: string; trashed: boolean }>(
      `SELECT nt.node_id, (n.deleted_at IS NOT NULL) AS trashed FROM node_tags nt
        JOIN content_nodes n ON n.id = nt.node_id AND n.workspace_id = $2
       WHERE nt.tag_id = $1`,
      [sourceId, workspaceId],
    );
    const liveCount = members.rows.filter((m) => !m.trashed).length;
    // Judged before anything is written, so a cycle refuses the merge cleanly.
    const repoints = await planExtendsRepoints(workspaceId, sourceId, target, true);
    return mutate<{ applied: number }>({
      actor,
      workspaceId,
      // Folding #source into #target re-tags its members and soft-deletes
      // #source: changing two global tag definitions is the owner's. Tags carry
      // no permission, so nobody's readable set moves (no epoch bump).
      authority: { kind: "principal_admin" },
      event: {
        type: "TAG_MERGED",
        targetType: "tag",
        targetId: sourceId,
        payload: {
          source_name: source.title, target_id: target.id, target_name: target.title,
          member_count: liveCount,
        },
        txMeta: { ui_context: "tag.merge", inverse_op: "node.restored" },
      },
      apply: async ({ eventId }) => {
        let applied = 0;
        mergeEventId = eventId;
        for (const m of members.rows) {
          if (m.trashed) {
            if (await viewModuleOfTag(workspaceId, target.id)) continue; // same skip as attachTagInTx
            // No template or default runs on a note nobody sees; the
            // link alone keeps #target on it for the day it is restored.
            const linked = await q(
              `INSERT INTO node_tags(node_id,tag_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING node_id`,
              [m.node_id, target.id],
            );
            if (linked.rowCount) await retypeGoverned(workspaceId, { nodeIds: [m.node_id] });
            continue;
          }
          // The apply contract, chained to the merge root. Behaviours gate
          // themselves; template children and field defaults are writes INTO the
          // note, so only where the owner may write it — a note in someone else's
          // space keeps #target without content added to it.
          const linked = await attachTagInTx({
            workspaceId, nodeId: m.node_id, tagId: target.id, actor, causeEventId: eventId,
            content: await spaceCanWrite(actor, m.node_id, "live"),
          });
          if (linked) applied++; // else it already carried #target
        }
        // Reparent #source's CHILD tags onto #target. Without this they keep
        // pointing parent_id at the about-to-be-soft-deleted source — orphaned
        // hierarchy rows with a dangling parent (M8). Each move is its OWN
        // NODE_UPDATED chained (triggered_by) to the merge root and carrying the
        // prior parent in prev_field_values, so the standard cascade restore
        // (undelete #source) walks them back to sourceId — the merge stays fully
        // reversible. Tags are global definitions, so no readable set moves.
        const childTags = await q<{ id: string; title: string }>(
          `SELECT id, title FROM content_nodes
            WHERE workspace_id = $1 AND parent_id = $2
              AND ${liveTagNodeSql()}`,
          [workspaceId, sourceId],
        );
        // Each child's move under #target is judged by the rules every move
        // shares (nodeTree.assertReparent), all before the first is written.
        // A child whose name #target already has under it would break the
        // (workspace, parent, title) uniqueness: the whole merge is refused
        // (409 sub_tag_name_conflict) instead of failing mid-way with a 500. A
        // child declaring a field #target (or its ancestors) gives is refused
        // (FieldNameClashError, D93).
        for (const child of childTags.rows) {
          try {
            await assertReparent(workspaceId, { id: child.id, node_type: TAG_NODE_TYPE, title: child.title, parent_id: sourceId }, target.id, current);
          } catch (error) {
            if (error instanceof TagNameConflictError) {
              throw new TagMergeError(409, { error: "sub_tag_name_conflict", detail: `#${child.title} exists under both tags; rename one first` });
            }
            throw error;
          }
        }
        for (const child of childTags.rows) {
          await mutate({
            actor, workspaceId,
            authority: { kind: "cascade" },
            event: {
              type: "NODE_UPDATED", targetType: "node", targetId: child.id,
              payload: { parent_id: target.id },
              txMeta: { prev_field_values: { parent_id: sourceId }, ui_context: "tag.merge.reparent" },
            },
            apply: async () => {
              await q(
                `UPDATE content_nodes SET parent_id = $3, updated_at = now()
                  WHERE id = $1 AND workspace_id = $2`,
                [child.id, workspaceId, target.id],
              );
            },
          });
        }
        // The moved children's notes' values now follow #target's fields
        // (D94). #source's own notes are retyped as it is trashed
        // (nodeTrash.markTrashed).
        if (childTags.rows.length) {
          await retypeGoverned(workspaceId, { tagIds: childTags.rows.map((child) => child.id) });
        }
        // Re-point the tags that extend #source at #target (D57) through the
        // extends writer: each is its own TAG_SCHEMA_UPDATED chained to the merge
        // root with the prior list in prev_field_values, so the cascade restore
        // puts `extends` back to #source just as it walks the reparents back.
        for (const r of repoints) {
          await changeTagSchema({
            actor, workspaceId, tag: r.tag, patch: { extends: [...new Set(r.extends)] }, whenNew: "private", uiContext: "tag.merge.extends",
          });
        }
        // Soft-delete #source — junction rows survive; Trash undelete
        // dissolves the merge. Modules that follow notes hear about it once
        // the merge commits (services/nodeTrash.ts).
        await markTrashed(workspaceId, sourceId, eventId);
        await nodeLifecycleCommitted({ workspaceId, actor, nodeIds: [sourceId], change: "trashed" });
        return { applied };
      },
    });
  });
  if (!merged) throw notFound();
  return { applied: merged.applied, mergeEventId };
}
