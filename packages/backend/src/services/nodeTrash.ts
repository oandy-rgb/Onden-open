// Deleting notes, bringing them back, and deleting them for good — the one
// place that owns it.
//
// A note is deleted by stamping deleted_at (ER5.5): its versions, attributes,
// tags, edges and tasks stay, so bringing it back is a single UPDATE.
// Recovery is History (an event restore) or the undo toast right after a
// delete; there is no trash to empty.
//
// The tree stays whole (D111): a live note never has a deleted parent.
//   - trashLive deletes a note with its live subtree, each descendant with its
//     own NODE_DELETED chained (triggered_by) to the note's.
//   - restoreLive brings a note back with the subtree deleted together with it
//     (that chain) and, first, every deleted note above it.
// Every delete and every way back goes through these two: the delete route
// (trashNode), the undo toast (undeleteNode) and History's restore of a
// NODE_DELETED / NODE_UNDELETED / NODE_CREATED event
// (services/eventRestore/restore.ts). markTrashed/markLive stamp one row and
// are private to them; test/nodeLifecycleOwner.test.ts fails on any other
// caller (tag merge is the one exception: it trashes the merged tag alone,
// its sub-tags having moved to the target first).
//
// Deleting for good (purgeDeleted, from History's 「已刪除的筆記」, one note at
// a time; purgeSpaceDeleted, from deleting a shared space) is the only hard
// delete of a note row, and test/nodeLifecycleOwner.test.ts keeps it so. It
// takes an already deleted note with everything under it (all deleted: a live
// descendant refuses), and erases its content wherever the server kept it
// (services/purgedContent.ts, stored publish snapshots included). Only a
// manager of the note's space may do it: the owner in a shared space, the
// person in their own personal space.
//
// Every delete and restore calls nodeLifecycleCommitted in its transaction, so
// a module that follows notes (the published website) records its follow-up
// with the change. A purge does not: the note was already deleted, so off the
// site, and the stored snapshots are rewritten in the purge itself.

import { db } from "../dbKysely.js";
import { q } from "../db.js";
import { mutate, runCascade } from "../spine/mutate.js";
import type { ActorCtx } from "../types.js";
import { relinkTarget, retryOnSlugConflict, slugForTitle, syncWikilinkEdges } from "./nodes.js";
import { nodeLifecycleCommitted } from "../spine/nodeHooks.js";
import { ancestorIds, subtreeIds } from "./nodeTree.js";
import { assertTagDefinitionChange } from "./reservedTags.js";
import { retypeGoverned } from "./attributeChange.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { assertAuthority, assertUndoableBy, AuthorityError } from "../spine/authority.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { taskNodeIdsAmong } from "./tasksStore.js";
import { taskSeam } from "./taskSeam.js";
import { MEDIA_TYPES } from "@onden/markdown";
import {
  deleteUnreferencedBlobs, dropQueuedWorkAbout, eraseEventsAbout, forgetNodesInSnapshots, forgetUnreferencedMedia, mediaStillReferenced, purgedContent,
} from "./purgedContent.js";
import type { PurgeItemResult, PurgePreview, PurgeResult } from "@onden/contract";
import { liveNodeSql, notTagNodeSql } from "../spine/nodeSql.js";
import { isTag } from "@onden/markdown/contract";

export class NodeTrashError extends Error {
  /** `code`: a stable reason the app can word (purge refusals). */
  constructor(public status: 404 | 409 | 410, message: string, public code?: string) { super(message); }
}

/** What trashNode takes along with `nodeId`: its live subtree, nearest
 *  first, root excluded. Ids only, no read policy — a preview that shows it
 *  (the tag delete-preview) scopes it itself. Walk before the root is
 *  stamped: a trashed root has no live subtree.
 *
 *  Trashing a note never takes a tag along (audit T12): tags are global, and
 *  a tag left under a note from before the tag and note trees were separated
 *  (services/parentKind.ts) stays, with what is below it. Trashing a tag still
 *  takes its sub-tags and the items filed under it (T7; its delete preview
 *  lists them). */
export async function trashSubtreeIds(workspaceId: string, nodeId: string): Promise<string[]> {
  const root = (await q<{ node_type: string }>(
    `SELECT node_type FROM content_nodes WHERE workspace_id = $1 AND id = $2`, [workspaceId, nodeId],
  )).rows[0];
  return subtreeIds(workspaceId, nodeId, { lifecycle: "live", skipTagDefinitions: !isTag(root) });
}

type TitledNode = { id: string; title: string };

/** What restoreLive brings back with a deleted `nodeId`, read before anything
 *  changes. Ids and titles only, no read policy (a preview scopes titles
 *  itself).
 *   - `ancestors`: the deleted notes above it, top first. Without them it
 *     would come back under a deleted parent.
 *   - `subtree`: the notes deleted together with it — each one's delete
 *     chained to the delete that holds `nodeId` — in delete order. A
 *     descendant deleted on its own before or after stays deleted. */
export async function restorePlan(
  workspaceId: string, nodeId: string,
): Promise<{ ancestors: TitledNode[]; subtree: TitledNode[] }> {
  const above = await ancestorIds(workspaceId, nodeId);
  const deletedAbove = above.length === 0 ? [] : (await q<TitledNode>(
    `SELECT id::text, title FROM content_nodes
      WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NOT NULL`,
    [workspaceId, above],
  )).rows;
  const titleOf = new Map(deletedAbove.map((row) => [row.id, row.title]));
  const ancestors = above.filter((id) => titleOf.has(id)).reverse().map((id) => ({ id, title: titleOf.get(id)! }));
  const subtree = (await q<TitledNode>(
    `SELECT n.id::text, n.title FROM content_nodes root
       JOIN domain_events e ON e.triggered_by_event_id = root.deleted_by_event_id
                           AND e.event_type = 'NODE_DELETED'
       JOIN content_nodes n ON n.deleted_by_event_id = e.id AND n.workspace_id = root.workspace_id
      WHERE root.workspace_id = $1 AND root.id = $2 AND root.deleted_at IS NOT NULL
        AND n.deleted_at IS NOT NULL AND n.id <> root.id
      ORDER BY e.id`,
    [workspaceId, nodeId],
  )).rows;
  return { ancestors, subtree };
}

/** Delete a live note with its live subtree, inside the caller's event
 *  transaction. The caller has emitted `causeEventId` — the event that says
 *  `nodeId` was deleted — and checked delete_node on it (re-checked here);
 *  the note is stamped with it, and each descendant gets its own NODE_DELETED
 *  chained to it (ui_context `<uiContext>.cascade`). Returns the descendants
 *  deleted. Throws ReservedTagError (409) for a reserved tag anywhere in it. */
export async function trashLive(
  actor: ActorCtx, workspaceId: string, nodeId: string, opts: { causeEventId: string; uiContext: string },
): Promise<string[]> {
  // M5: left behind, children kept a parent_id pointing at a trashed node and
  // dropped out of their read-policy ancestor cascade. Walked before the note
  // is stamped: a trashed root has no live subtree.
  const ids = await trashSubtreeIds(workspaceId, nodeId);
  const titles = await q<TitledNode>(
    `SELECT id::text, title FROM content_nodes WHERE id = ANY($1::uuid[])`, [ids]);
  const titleOf = new Map(titles.rows.map((row) => [row.id, row.title]));
  await runCascade({
    actor, workspaceId, authority: { kind: "node", nodeId, op: "delete_node" }, causeEventId: opts.causeEventId,
  }, async () => {
    await markTrashed(workspaceId, nodeId, opts.causeEventId);
    for (const id of ids) {
      await mutate({
        actor, workspaceId,
        authority: { kind: "cascade" },
        event: {
          type: "NODE_DELETED", targetType: "node", targetId: id,
          payload: { title: titleOf.get(id) ?? "", cascaded_from: nodeId },
          txMeta: { inverse_op: "node.undeleted", ui_context: `${opts.uiContext}.cascade` },
        },
        apply: async ({ eventId }) => { await markTrashed(workspaceId, id, eventId); },
      });
    }
  });
  // In the same transaction: modules record their follow-up durably.
  await nodeLifecycleCommitted({ workspaceId, actor, nodeIds: [nodeId, ...ids], change: "trashed" });
  return ids;
}

/** Bring a deleted note back whole, inside the caller's event transaction
 *  (restorePlan says what comes with it). The caller has emitted
 *  `causeEventId` — the event that says `nodeId` came back — and checked
 *  write_node on the retained note (re-checked here). Each deleted ancestor
 *  needs write_node too and gets its own NODE_UNDELETED (ui_context
 *  `<uiContext>.ancestor`); each subtree note gets one under cascade authority
 *  (`<uiContext>.cascade`, as it went with the note); all are chained to
 *  `causeEventId`. Each slug follows its title (markLive, services/nodes.ts
 *  slugForTitle), suffixed when another note took it meanwhile. Returns what
 *  came back. */
export async function restoreLive(
  actor: ActorCtx, workspaceId: string, nodeId: string,
  opts: { causeEventId: string; uiContext: string },
): Promise<{ ancestors: TitledNode[]; subtree: TitledNode[] }> {
  const plan = await restorePlan(workspaceId, nodeId);
  await runCascade({
    actor, workspaceId, authority: { kind: "retained_node", nodeId, op: "write_node" }, causeEventId: opts.causeEventId,
  }, async () => {
    // Top first, so each ancestor returns under a live parent.
    for (const a of plan.ancestors) {
      await mutate({
        actor, workspaceId,
        authority: { kind: "retained_node", nodeId: a.id, op: "write_node" },
        event: {
          type: "NODE_UNDELETED", targetType: "node", targetId: a.id,
          payload: { title: a.title, revived_for: nodeId },
          txMeta: { inverse_op: "node.deleted", ui_context: `${opts.uiContext}.ancestor` },
        },
        apply: async () => { await markLive(workspaceId, a.id); },
      });
    }
    await markLive(workspaceId, nodeId);
    for (const d of plan.subtree) {
      await mutate({
        actor, workspaceId,
        authority: { kind: "cascade" },
        event: {
          type: "NODE_UNDELETED", targetType: "node", targetId: d.id,
          payload: { title: d.title, cascaded_from: nodeId },
          txMeta: { inverse_op: "node.deleted", ui_context: `${opts.uiContext}.cascade` },
        },
        apply: async () => { await markLive(workspaceId, d.id); },
      });
    }
  });
  await nodeLifecycleCommitted({
    workspaceId, actor, change: "restored",
    nodeIds: [...plan.ancestors.map((a) => a.id), nodeId, ...plan.subtree.map((d) => d.id)],
  });
  return plan;
}

/** Delete a live note and its live subtree (trashLive): one NODE_DELETED for
 *  the note (needs delete_node on it) and one per descendant, chained to it.
 *  `uiContext` records where the delete came from. Throws NodeTrashError 404
 *  when the note is not live. */
export async function trashNode(
  actor: ActorCtx, workspaceId: string, nodeId: string, opts: { uiContext?: string; txMeta?: Record<string, unknown> } = {},
): Promise<void> {
  const node = await q<{ title: string }>(
    `SELECT title FROM content_nodes WHERE workspace_id = $1 AND id = $2 AND ${liveNodeSql()}`,
    [workspaceId, nodeId],
  );
  if (!node.rows[0]) throw new NodeTrashError(404, "node not found");
  const uiContext = opts.uiContext ?? "node.delete";
  await mutate({
    actor,
    workspaceId,
    authority: { kind: "node", nodeId, op: "delete_node" },
    event: {
      type: "NODE_DELETED", targetType: "node", targetId: nodeId,
      payload: { title: node.rows[0].title },
      txMeta: { inverse_op: "node.undeleted", ...opts.txMeta, ui_context: uiContext },
    },
    apply: async ({ eventId }) => { await trashLive(actor, workspaceId, nodeId, { causeEventId: eventId, uiContext }); },
  });
}

/** The `tx_meta` of the delete event that holds `nodeId` in the trash now (what the delete recorded about itself, e.g. the
 *  `ui_context` it came from), or null when the node is not deleted. Ids and the delete's own metadata only; nothing is
 *  served. Undo of a delete that took something else along reads it (modules/tasks/deletion.ts). */
export async function deleteEventMeta(workspaceId: string, nodeId: string): Promise<Record<string, unknown> | null> {
  const row = await db.selectFrom("content_nodes as n").innerJoin("domain_events as e", "e.id", "n.deleted_by_event_id")
    .select("e.tx_meta").where("n.workspace_id", "=", workspaceId).where("n.id", "=", nodeId).where("n.deleted_at", "is not", null).executeTakeFirst();
  return row ? (row.tx_meta ?? {}) as Record<string, unknown> : null;
}

/** Bring a deleted note back whole (restoreLive) — the undo toast after a
 *  delete. Needs write_node on the retained note. Throws NodeTrashError 410
 *  when the row is gone and 409 when it is not deleted. */
export async function undeleteNode(
  actor: ActorCtx, workspaceId: string, nodeId: string, opts: { uiContext?: string; txMeta?: Record<string, unknown> } = {},
): Promise<void> {
  const node = await q<{ title: string; deleted_at: string | null }>(
    `SELECT title, deleted_at FROM content_nodes WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, nodeId],
  );
  const row = node.rows[0];
  if (!row) throw new NodeTrashError(410, "node not found or expired");
  if (row.deleted_at === null) throw new NodeTrashError(409, "node is not deleted");
  await retryOnSlugConflict(() => mutate({
    actor,
    workspaceId,
    authority: { kind: "retained_node", nodeId, op: "write_node" },
    event: {
      type: "NODE_UNDELETED", targetType: "node", targetId: nodeId,
      payload: { title: row.title },
      txMeta: { inverse_op: "node.deleted", ...opts.txMeta, ui_context: opts.uiContext ?? "node.undelete" },
    },
    apply: async ({ eventId }) => {
      await restoreLive(actor, workspaceId, nodeId, {
        causeEventId: eventId, uiContext: opts.uiContext ?? "node.undelete",
      });
    },
  }));
}

/** The delete route's delete: `trashNode`, except that a task which is a line of a note takes its line out of the note in
 *  the same transaction (modules/tasks/deletion.ts, through the task seam), so the note's next save cannot bring it back. */
export async function trashNodeWithTaskLine(actor: ActorCtx, workspaceId: string, nodeId: string): Promise<void> {
  if ((await taskSeam()?.deleteTaskLine(actor, nodeId)) !== "done") await trashNode(actor, workspaceId, nodeId);
}

/** The undo route's counterpart: `undeleteNode`, and a task deleted with its line comes back with the line. */
export async function undeleteNodeWithTaskLine(actor: ActorCtx, workspaceId: string, nodeId: string): Promise<void> {
  if ((await taskSeam()?.undeleteTaskLine(actor, nodeId)) !== "done") await undeleteNode(actor, workspaceId, nodeId);
}

/** Load a deleted note for a purge and check who asks, under the event lock.
 *  404 when the note does not exist (already purged) or `actor` cannot read
 *  it; 409 not_deleted for a live note and not_purgeable for a tag
 *  definition; AuthorityError (403) unless `actor` manages its space. */
async function purgeTarget(actor: ActorCtx, workspaceId: string, nodeId: string): Promise<TitledNode & { space_id: string }> {
  const row = (await q<{ id: string; title: string; node_type: string; space_id: string | null; deleted: boolean }>(
    `SELECT id::text, title, node_type, space_id::text, deleted_at IS NOT NULL AS deleted
       FROM content_nodes WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [workspaceId, nodeId],
  )).rows[0];
  if (!row) throw new NodeTrashError(404, "node not found", "not_found");
  try {
    await assertAuthority(actor, { kind: "retained_node", nodeId, op: "read" });
  } catch (error) {
    if (error instanceof AuthorityError) throw new NodeTrashError(404, "node not found", "not_found");
    throw error;
  }
  if (!row.deleted) throw new NodeTrashError(409, "only a deleted note can be deleted for good", "not_deleted");
  if (isTag(row) || !row.space_id) {
    throw new NodeTrashError(409, "a tag definition is not deleted for good from History", "not_purgeable");
  }
  await assertAuthority(actor, { kind: "space", spaceId: row.space_id, need: "manage" });
  return { id: row.id, title: row.title, space_id: row.space_id };
}

/** Everything under `nodeId`, deleted or not (tag definitions stay: they are
 *  global), split into deleted rows and live ones. */
async function purgeSubtree(workspaceId: string, nodeId: string): Promise<{ deleted: TitledNode[]; live: TitledNode[] }> {
  const ids = await subtreeIds(workspaceId, nodeId, { lifecycle: "all", skipTagDefinitions: true });
  if (ids.length === 0) return { deleted: [], live: [] };
  const rows = await q<TitledNode & { deleted: boolean }>(
    `SELECT id::text, title, deleted_at IS NOT NULL AS deleted FROM content_nodes WHERE id = ANY($1::uuid[])`, [ids]);
  const byId = new Map(rows.rows.map((row) => [row.id, row]));
  const ordered = ids.map((id) => byId.get(id)).filter((row): row is TitledNode & { deleted: boolean } => !!row);
  return {
    deleted: ordered.filter((row) => row.deleted).map(({ id, title }) => ({ id, title })),
    live: ordered.filter((row) => !row.deleted).map(({ id, title }) => ({ id, title })),
  };
}

async function buildPurgePreview(actor: ActorCtx, workspaceId: string, nodeId: string): Promise<PurgePreview & { space_id: string }> {
  const target = await purgeTarget(actor, workspaceId, nodeId);
  const under = await purgeSubtree(workspaceId, nodeId);
  const ids = [target.id, ...under.deleted.map((row) => row.id)];
  const tasks = await taskNodeIdsAmong(workspaceId, ids);
  const content = await purgedContent(workspaceId, ids);
  const kept = await mediaStillReferenced(workspaceId, content.mediaFiles, ids, content.hashes);
  const going = content.mediaFiles.filter((file) => !kept.has(file));
  const isImage = (file: string) => MEDIA_TYPES[file.slice(file.lastIndexOf(".")).toLowerCase()]?.kind === "image";
  const attributes = (await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM node_attributes WHERE node_id = ANY($1::uuid[])`, [ids])).rows[0]?.n ?? "0";
  return {
    space_id: target.space_id,
    node: { id: target.id, title: target.title },
    subtree: under.deleted.filter((row) => !tasks.has(row.id)),
    tasks: under.deleted.filter((row) => tasks.has(row.id)).length,
    live_descendants: under.live,
    media: { images: going.filter(isImage).length, files: going.filter((file) => !isImage(file)).length, kept: kept.size },
    versions: content.versions,
    attributes: Number(attributes),
    ids,
  };
}

/** What deleting `nodeId` for good would take (PurgePreview), with the same
 *  checks as purgeDeleted. Changes nothing. */
export async function purgePreview(actor: ActorCtx, workspaceId: string, nodeId: string): Promise<PurgePreview> {
  return withEventTransaction(workspaceId, async () => {
    const { space_id: _space, ...preview } = await buildPurgePreview(await resolveCurrentActor(actor, workspaceId), workspaceId, nodeId);
    return preview;
  });
}

/** Delete a deleted note for good, with everything under it — History's
 *  「永久刪除」. One note per call; there is no bulk form. In one
 *  transaction: one NODES_PURGED event on the note's space (ids and a count,
 *  no title), the rows hard-deleted (attributes, tags, edges, block nodes,
 *  positions and the rest cascade), their earlier events erased to
 *  {"purged": true}, the blobs and uploaded files only they used deleted,
 *  queued work about them dropped, and every stored publish snapshot rid of
 *  them. A client learns it from the sync delta (NODES_PURGED). Not
 *  reversible from History; an external git/GitHub backup is not touched.
 *
 *  Needs to manage the note's space (the owner in a shared space, the person
 *  in their personal one). Throws
 *  NodeTrashError 404 not_found (no such note — a second purge of the same
 *  id — or not readable), 409 not_deleted / not_purgeable /
 *  live_descendant, and 409 plan_changed when `expected` (PurgePreview.ids)
 *  is not exactly what would go now. */
export async function purgeDeleted(
  actor: ActorCtx, workspaceId: string, nodeId: string, opts: { expected?: readonly string[] } = {},
): Promise<PurgeResult> {
  assertUndoableBy(actor); // delete for good cannot be undone
  return withEventTransaction(workspaceId, async () => {
    const current = await resolveCurrentActor(actor, workspaceId);
    const plan = await buildPurgePreview(current, workspaceId, nodeId);
    if (plan.live_descendants.length > 0) {
      throw new NodeTrashError(409, "a note under it is not deleted; delete or move it first", "live_descendant");
    }
    if (opts.expected && !sameIds(opts.expected, plan.ids)) {
      throw new NodeTrashError(409, "what would be deleted changed since the confirmation; check again", "plan_changed");
    }
    return purgeRows(current, workspaceId, plan.space_id, plan.ids, "history.purge");
  });
}

/** History's 「全部永久刪除」: purgeDeleted for each item in turn, each in its
 *  own transaction with its own authority check and `expected` ids — a refused
 *  or changed note is reported and the rest go on. Anything that is not a
 *  refusal (a database error) stops the batch and propagates. */
export async function purgeDeletedEach(
  actor: ActorCtx, workspaceId: string, items: ReadonlyArray<{ nodeId: string; expected: readonly string[] }>,
): Promise<PurgeItemResult[]> {
  assertUndoableBy(actor); // delete for good cannot be undone: refused as a whole, not item by item
  const results: PurgeItemResult[] = [];
  for (const item of items) {
    try {
      const done = await purgeDeleted(actor, workspaceId, item.nodeId, { expected: item.expected });
      results.push({ node_id: item.nodeId, purged: true, media_removed: done.media_removed });
    } catch (error) {
      if (error instanceof NodeTrashError) results.push({ node_id: item.nodeId, purged: false, code: error.code ?? "refused" });
      else if (error instanceof AuthorityError) results.push({ node_id: item.nodeId, purged: false, code: error.reason });
      else throw error;
    }
  }
  return results;
}

/** Delete for good every note in `spaceId` — all of them deleted — inside
 *  the caller's event transaction (services/spaces.ts deleteSpace, 「一起永久刪
 *  除」). Same erasure and event as purgeDeleted; needs to manage the space. Throws
 *  NodeTrashError 409 live_descendant if a live note is still in the space. */
export async function purgeSpaceDeleted(actor: ActorCtx, workspaceId: string, spaceId: string): Promise<PurgeResult> {
  await assertAuthority(actor, { kind: "irreversible", of: { kind: "space", spaceId, need: "manage" } });
  const rows = await q<{ id: string; deleted: boolean }>(
    `SELECT id::text, deleted_at IS NOT NULL AS deleted FROM content_nodes
      WHERE workspace_id = $1 AND space_id = $2 AND ${notTagNodeSql()} FOR UPDATE`,
    [workspaceId, spaceId],
  );
  if (rows.rows.some((row) => !row.deleted)) {
    throw new NodeTrashError(409, "the space still has notes that are not deleted", "live_descendant");
  }
  return purgeRows(actor, workspaceId, spaceId, rows.rows.map((row) => row.id), "space.delete.purge");
}

/** The purge itself, over rows the caller planned and checked, inside its
 *  event transaction. */
async function purgeRows(
  actor: ActorCtx, workspaceId: string, spaceId: string, ids: string[], uiContext: string,
): Promise<PurgeResult> {
  if (ids.length === 0) return { purged: 0, media_removed: 0 };
  const tasks = await taskNodeIdsAmong(workspaceId, ids);
  return mutate({
    actor, workspaceId,
    authority: { kind: "irreversible", of: { kind: "space", spaceId, need: "manage" } },
    // The rows leave every reader's set; clients reconcile on the epoch too.
    affectsMembership: true,
    event: {
      type: "NODES_PURGED", targetType: "space", targetId: spaceId,
      // Ids and a count only: the event that outlives the notes names nothing
      // of them. task_ids: a client keeps checklist items in its tasks store.
      payload: {
        count: ids.length,
        node_ids: ids.filter((id) => !tasks.has(id)),
        task_ids: ids.filter((id) => tasks.has(id)),
      },
      txMeta: { ui_context: uiContext },
    },
    apply: async () => {
      // Read what they hold elsewhere before anything goes.
      const content = await purgedContent(workspaceId, ids);
      await eraseEventsAbout(workspaceId, ids);
      await dropQueuedWorkAbout(workspaceId, ids);
      // node_positions has no foreign key on `surface` / `sub_canvas_id`: a purged board's placements and
      // the sub-board links other boards hold to it go here.
      await db.deleteFrom("node_positions").where("workspace_id", "=", workspaceId).where("surface", "in", ids).execute();
      await db.updateTable("node_positions").set({ sub_canvas_id: null }).where("workspace_id", "=", workspaceId).where("sub_canvas_id", "in", ids).execute();
      const deleted = await q(`DELETE FROM content_nodes WHERE workspace_id = $1 AND id = ANY($2::uuid[])`, [workspaceId, ids]);
      const goneHashes = await deleteUnreferencedBlobs(content.hashes);
      const mediaRemoved = await forgetUnreferencedMedia(workspaceId, content.mediaFiles, ids, goneHashes);
      await forgetNodesInSnapshots(workspaceId, ids);
      return { purged: deleted.rowCount ?? ids.length, media_removed: mediaRemoved };
    },
  });
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** Stamp one row as trashed by `eventId`, inside the caller's event
 *  transaction. No cascade and no hook: the caller owns both (trashNode, or an
 *  event-history undo whose cascade group restores descendants separately).
 *  Throws ReservedTagError (409, rolling the caller back) for a reserved tag
 *  (services/reservedTags.ts) — whichever path asked: note delete, a cascade
 *  under a parent tag, collection delete, tag merge or an undo. A trashed
 *  tag's notes' value types are retyped here, so every one of those does. */
export async function markTrashed(workspaceId: string, nodeId: string, eventId: string): Promise<void> {
  await assertTagDefinitionChange(nodeId, "delete");
  const trashed = await q<{ node_type: string }>(
    `UPDATE content_nodes SET deleted_at = now(), deleted_by_event_id = $3, updated_at = now()
      WHERE workspace_id = $1 AND id = $2
      RETURNING node_type`,
    [workspaceId, nodeId, eventId],
  );
  // A trashed tag's fields govern nothing any more (D94).
  if (isTag(trashed.rows[0])) await retypeGoverned(workspaceId, { tagIds: [nodeId] });
}

/** Bring one row back inside the caller's event transaction. Its slug
 *  re-enters the live unique index as its title gives it (services/nodes.ts
 *  slugForTitle: a tag keeps `tag-`, a task `task-<uuid>`), suffixed when
 *  another note took it meanwhile. The undo toast, a History restore and a
 *  tag-merge undo all come back this way. Then its wikilink edges, both
 *  ways, follow what was written while it was in the trash — after the slug,
 *  since incoming links match by title or slug. No cascade and no hook, like
 *  markTrashed (and, like it, a tag's notes' value types are retyped). */
export async function markLive(workspaceId: string, nodeId: string): Promise<void> {
  const current = (await q<{ id: string; title: string; node_type: string; slug: string; reserved_key: string | null; markdown: string | null }>(
    `SELECT id, title, node_type, slug, reserved_key, markdown FROM content_nodes WHERE workspace_id = $1 AND id = $2`, [workspaceId, nodeId],
  )).rows[0];
  if (!current) return;
  const slug = await slugForTitle(workspaceId, current, current.title);
  const restored = await q<{ node_type: string }>(
    `UPDATE content_nodes SET deleted_at = NULL, deleted_by_event_id = NULL, slug = $3, updated_at = now()
      WHERE workspace_id = $1 AND id = $2
      RETURNING node_type`,
    [workspaceId, nodeId, slug],
  );
  // A tag back from the trash governs its notes' values again (D94).
  if (isTag(restored.rows[0])) await retypeGoverned(workspaceId, { tagIds: [nodeId] });
  await syncWikilinkEdges(workspaceId, nodeId, current.markdown ?? "");
  await relinkTarget(workspaceId, [nodeId]);
}
