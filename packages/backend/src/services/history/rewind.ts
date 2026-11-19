// 「還原到這時」: put the workspace's notes back to how they were at T, in one
// transaction, and take that back as a whole (docs/architecture/history-api.md).
//
// What a rewind does, per note, from noteStatesAt (services/history/pointInTime.ts):
//   restore   (changed)        a NEW version with T's title and text — updateNode,
//                              so write policy, slug, derived state and the event are
//                              the ones an edit gets. No old event is touched.
//   undelete  (deleted_since)  the usual undeleteNode, then, if its last text is not
//                              T's, a new version with T's.
//   delete    (created_since)  the usual trashNode (soft delete into 最近刪除, never
//                              a hard delete). A note whose live subtree holds a note
//                              that is not itself created since T is left alone: that
//                              would pull an older note into the trash with it.
//             (revived)      a note born after T that sits in 最近刪除 gets no step of its own
//                              unless an undelete above brought it back live; then it is
//                              trashed again, as a `delete` step after that undelete.
// Position (parent) and tags are not touched (pointInTime.ts says why).
//
// Every event it writes carries tx_meta { rewind_id, rewind_to, rewind_kind }; the
// History feed and the undo find a rewind by rewind_id. The browser sends the ids
// it showed, the server re-derives each group and skips what no longer fits
// (`stale`) or what the caller may not write (`unwritable`), so a stale list or a
// forged one cannot reach further than the caller's own rights.
//
// Undo (undoRewind) is a new operation under the caller's current rights, never an
// edit of history:
//   restore    three-way merge, base = the rewound text, theirs = the text before the
//              rewind, ours = now (the agent-run undo's merge): what a person wrote
//              since stays, a line both changed keeps `now` and the other side goes to
//              the inbox as BODY_CONFLICT.
//   undelete   deleted again, unless the note (or a note under it) was edited since:
//              then it is kept (`kept`), because deleting would hide new work.
//   delete     brought back from 最近刪除.
// Events of an undo carry tx_meta.undoes_rewind = the rewind id, which is how a
// note is known to be undone and how a second request becomes a no-op.

import { randomUUID } from "node:crypto";
import { q, withSavepoint } from "../../db.js";
import { shownAuthorKind, shownAuthorName } from "../authorName.js";
import { withEventTransaction } from "../../spine/eventTransaction.js";
import { withIdempotencyClaim } from "../../spine/idempotency.js";
import { AuthorityError } from "../../spine/authority.js";
import type { ActorCtx } from "../../types.js";
import { resolveCurrentActor } from "../../spine/currentActor.js";
import { NodeTrashError, trashNode, trashSubtreeIds, undeleteNode } from "../nodeTrash.js";
import { NodeUpdateError, updateNode } from "../nodeUpdate.js";
import { ScopeError } from "../../spine/toolScope.js";
import { bodiesByHash, bodyEventSql } from "./bodyEvents.js";
import { REWIND_MAX_NOTES, isUuid } from "@onden/markdown";
import { readableNotesSql } from "./readableNotes.js";
import { ancestorIds } from "../nodeTree.js";
import { noteStatesAt, type NoteAtState, type SpaceScope } from "./pointInTime.js";
import type { DayRewind, RewindResult, RewindUndoResult } from "@onden/contract";
import { liveNodeSql } from "../../spine/nodeSql.js";

export class RewindError extends Error {
  constructor(public readonly code: "rewind_too_many" | "rewind_not_found", public readonly status: 400 | 404) {
    super(code);
    this.name = "RewindError";
  }
}

type RewindKind = "restore" | "undelete" | "undelete_content" | "delete";

export type RewindInput = { at: Date; restoreIds: string[]; undeleteIds: string[]; deleteIds: string[] };
const isWriteRefusal = (error: unknown): boolean => error instanceof AuthorityError || error instanceof ScopeError;

export async function rewindWorkspace(
  workspaceId: string, input: RewindInput, { actor: authenticated, spaceId }: { actor: ActorCtx } & SpaceScope,
): Promise<RewindResult> {
  const total = input.restoreIds.length + input.undeleteIds.length + input.deleteIds.length;
  if (total > REWIND_MAX_NOTES) throw new RewindError("rewind_too_many", 400);
  return withIdempotencyClaim(workspaceId, (claim) => withEventTransaction(workspaceId, async () => {
    await claim();
    const actor = await resolveCurrentActor(authenticated, workspaceId);
    // Under the event lock: the groups are derived from the state of this moment.
    const states = new Map((await noteStatesAt(actor, workspaceId, input.at, { spaceId }, undefined, { includeTrashedNewborn: true, includeTrashedThen: true })).map((s) => [s.id, s]));
    const result: RewindResult = { rewind_id: null, restored: [], undeleted: [], deleted: [], stale: [], unwritable: [], skipped: [] };
    const rewindId = randomUUID();
    const meta = (kind: RewindKind) => ({ rewind_id: rewindId, rewind_to: input.at.toISOString(), rewind_kind: kind });
    const bodies = await bodiesByHash([...states.values()].flatMap((s) => (s.body_hash_then ? [s.body_hash_then] : [])));

    const attempt = async (id: string, work: () => Promise<void>, done: string[]): Promise<void> => {
      try {
        await withSavepoint(work);
        done.push(id);
      } catch (error) {
        if (isWriteRefusal(error)) result.unwritable.push(id);
        else if (error instanceof NodeUpdateError || error instanceof NodeTrashError) result.skipped.push(id);
        else throw error;
      }
    };
    const putBack = (id: string, then: NoteAtState, kind: "restore" | "undelete_content") => async () => {
      const markdown = then.body_hash_then ? bodies.get(then.body_hash_then) : undefined;
      if (markdown === undefined) throw new NodeUpdateError("version not found", 404);
      const current = (await q<{ title: string; markdown: string }>(
        `SELECT title, markdown FROM content_nodes WHERE workspace_id = $1 AND id = $2`, [workspaceId, id],
      )).rows[0];
      if (current && current.markdown === markdown && current.title === then.title_then) return;
      await updateNode(workspaceId, id, { markdown, ...(current?.title === then.title_then ? {} : { title: then.title_then }) }, {
        actor,
        event: { uiContext: "history.rewind.restore", txMeta: meta(kind), cascadeLabel: "history.rewind.cascade", backupPrefix: "NODE_UPDATED" },
      });
    };

    for (const id of new Set(input.restoreIds)) {
      const then = states.get(id);
      if (then?.status !== "changed") { result.stale.push(id); continue; }
      await attempt(id, putBack(id, then, "restore"), result.restored);
    }
    // Parents first: undeleting a child on its own would bring its deleted parents back as ancestors, with
    // no step of this rewind to undo them by.
    const undeleteDepth = new Map<string, number>();
    for (const id of new Set(input.undeleteIds)) undeleteDepth.set(id, (await ancestorIds(workspaceId, id)).length);
    for (const id of [...undeleteDepth.keys()].sort((a, b) => undeleteDepth.get(a)! - undeleteDepth.get(b)!)) {
      const then = states.get(id);
      if (then?.status !== "deleted_since") { result.stale.push(id); continue; }
      // A parent brought back earlier in this loop may have brought this one with it.
      const live = (await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND id = $2 AND ${liveNodeSql()}`, [workspaceId, id])).rows[0];
      // Its text still goes back to T's: it was edited after T, before the parent was deleted.
      if (live) { await attempt(id, putBack(id, then, "undelete_content"), result.undeleted); continue; }
      await attempt(id, async () => {
        await undeleteNode(actor, workspaceId, id, { uiContext: "history.rewind.undelete", txMeta: meta("undelete") });
        await putBack(id, then, "undelete_content")();
      }, result.undeleted);
    }
    // A note born after T that was deleted with an older note came back with it (undeleteNode restores the
    // subtree deleted together): it did not exist at T, so it goes back to 最近刪除 as its own step, after
    // its parent's undelete — which is the order the undo walks back, so it is live again before the parent
    // is deleted.
    const revivedNewborn: string[] = [];
    for (const [id, state] of states) {
      if (!state.trashed_now) continue;
      const live = (await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND id = $2 AND ${liveNodeSql()}`, [workspaceId, id])).rows[0];
      if (live) revivedNewborn.push(id);
    }
    const deleteDepth = new Map<string, number>();
    for (const id of new Set([...input.deleteIds, ...revivedNewborn])) deleteDepth.set(id, (await ancestorIds(workspaceId, id)).length);
    // Parents first, so a child that goes with its parent is not deleted twice.
    for (const id of [...deleteDepth.keys()].sort((a, b) => deleteDepth.get(a)! - deleteDepth.get(b)!)) {
      const then = states.get(id);
      if (then?.status !== "created_since" || (then.trashed_now && !revivedNewborn.includes(id))) { result.stale.push(id); continue; }
      const gone = (await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NOT NULL`, [workspaceId, id])).rows[0];
      if (gone) { result.deleted.push(id); continue; } // went with a parent deleted earlier in this loop
      const below = await trashSubtreeIds(workspaceId, id);
      if (below.some((child) => states.get(child)?.status !== "created_since")) { result.skipped.push(id); continue; }
      await attempt(id, () => trashNode(actor, workspaceId, id, { uiContext: "history.rewind.delete", txMeta: meta("delete") }), result.deleted);
    }
    // Likewise a note that was already in 最近刪除 at T and came back with an older parent's subtree: it was
    // deleted at T, so it goes back too, still under the parent it has (soft delete keeps parent_id, so a
    // later restore on its own returns it to the same place). Same step kind as above, so the undo is the same.
    const revivedOld = new Set<string>();
    for (const [id, state] of states) {
      if (!state.trashed_then || !state.trashed_now) continue;
      const live = (await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND id = $2 AND ${liveNodeSql()}`, [workspaceId, id])).rows[0];
      if (live) revivedOld.add(id);
    }
    const oldDepth = new Map<string, number>();
    for (const id of revivedOld) oldDepth.set(id, (await ancestorIds(workspaceId, id)).length);
    for (const id of [...oldDepth.keys()].sort((a, b) => oldDepth.get(a)! - oldDepth.get(b)!)) {
      const gone = (await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NOT NULL`, [workspaceId, id])).rows[0];
      if (gone) { result.deleted.push(id); continue; }
      const below = await trashSubtreeIds(workspaceId, id);
      if (below.some((child) => !revivedOld.has(child) && states.get(child)?.status !== "created_since")) { result.skipped.push(id); continue; }
      await attempt(id, () => trashNode(actor, workspaceId, id, { uiContext: "history.rewind.delete", txMeta: meta("delete") }), result.deleted);
    }
    if (result.restored.length + result.undeleted.length + result.deleted.length > 0) result.rewind_id = rewindId;
    return result;
  }));
}

/* ------------------------------------------------------------------ */
/* Reading rewinds back: History's cards and the undo                   */
/* ------------------------------------------------------------------ */


type RewindEvent = {
  id: string; rewind_id: string; rewind_to: string; kind: RewindKind; target_id: string; event_type: string;
  created_at: Date; actor_id: string; actor_type: string; body_hash: string | null; title: string | null;
};

/** The rewind events in a time window, or of one rewind (`rewindId`). */
type RewindEventsWhere = { from: Date; to: Date } | { rewindId: string };

async function rewindEvents(workspaceId: string, which: RewindEventsWhere): Promise<RewindEvent[]> {
  const where = "rewindId" in which
    ? `e.tx_meta->>'rewind_id' = $2`
    : `e.created_at >= $2 AND e.created_at < $3 AND e.tx_meta->>'rewind_kind' IN ('restore','undelete','delete')`;
  const params = "rewindId" in which ? [which.rewindId] : [which.from, which.to];
  return (await q<RewindEvent>(
    `SELECT e.id::text, e.tx_meta->>'rewind_id' AS rewind_id, e.tx_meta->>'rewind_to' AS rewind_to, e.tx_meta->>'rewind_kind' AS kind,
            e.target_id, e.event_type, e.created_at, e.actor_id, e.actor_type, e.payload->>'body_hash' AS body_hash, e.payload->>'title' AS title
       FROM domain_events e
      WHERE e.workspace_id = $1 AND e.tx_meta ? 'rewind_id' AND ${where}
      ORDER BY e.id`,
    [workspaceId, ...params],
  )).rows;
}

/** Notes (by id) of `ids` that `actor` can read, live or in the trash, inside `spaceId` when given. */
async function readableNotes(actor: ActorCtx, workspaceId: string, ids: string[], spaceId?: string): Promise<Map<string, { title: string; space_id: string | null }>> {
  if (ids.length === 0) return new Map();
  const params: unknown[] = [workspaceId, ids.filter(isUuid)];
  const readable = await readableNotesSql(actor, workspaceId, "n", params, { spaceId, includeTrashed: true });
  const rows = await q<{ id: string; title: string; space_id: string | null }>(
    `SELECT n.id::text AS id, n.title, n.space_id::text AS space_id FROM content_nodes n
      WHERE n.workspace_id = $1 AND n.id = ANY($2::uuid[]) AND ${readable}`,
    params,
  );
  return new Map(rows.rows.map((r) => [r.id, { title: r.title, space_id: r.space_id }]));
}

/** Who did a rewind: a person or an AI by name; a session as the kind 'session' (services/authorName.ts). One this node holds no row for (a removed
 *  member or AI) has the name "" and the kind its event recorded (`eventActorType`: domain_events.actor_type), as every other history reader does. */
function rewindAuthor(row: { name: string; type: string } | undefined, eventActorType: string): Pick<DayRewind, "actor_name" | "actor_kind"> {
  const kind = (row ? row.type === "agent" : eventActorType === "ai_agent") ? "agent" as const : "human" as const;
  return { actor_name: shownAuthorName(row?.type, row?.name) ?? "", actor_kind: shownAuthorKind(row?.type, kind) };
}

/** Rewinds done in [from, to), by the notes `actor` can read there. A rewind with none of them is absent. */
export async function rewindsBetween(actor: ActorCtx, workspaceId: string, from: Date, to: Date, { spaceId }: SpaceScope = {}): Promise<DayRewind[]> {
  const events = (await rewindEvents(workspaceId, { from, to }));
  if (events.length === 0) return [];
  const readable = await readableNotes(actor, workspaceId, [...new Set(events.map((e) => e.target_id))], spaceId);
  const markers = await undoneNodes(workspaceId, [...new Set(events.map((e) => e.rewind_id))]);
  const names = (await q<{ id: string; name: string; type: string }>(
    `SELECT id::text, name, type FROM actors WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
    [workspaceId, [...new Set(events.map((e) => e.actor_id).filter(isUuid))]],
  )).rows;
  const rowOf = new Map(names.map((n) => [n.id, n]));
  const byRewind = new Map<string, RewindEvent[]>();
  for (const e of events) if (readable.has(e.target_id)) (byRewind.get(e.rewind_id) ?? byRewind.set(e.rewind_id, []).get(e.rewind_id)!).push(e);
  const cards: DayRewind[] = [];
  for (const [rewindId, rows] of byRewind) {
    const undone = markers.get(rewindId) ?? new Set<string>();
    cards.push({
      rewind_id: rewindId, to: rows[0]!.rewind_to, at: rows[0]!.created_at.toISOString(), ...rewindAuthor(rowOf.get(rows[0]!.actor_id), rows[0]!.actor_type),
      notes: rows.map((e) => ({ id: e.target_id, ...readable.get(e.target_id)!, kind: e.kind as DayRewind["notes"][number]["kind"] })),
      undone: rows.every((e) => undone.has(e.target_id)),
    });
  }
  return cards.sort((a, b) => b.at.localeCompare(a.at));
}

/** Per rewind, the notes already undone. */
async function undoneNodes(workspaceId: string, rewindIds: string[]): Promise<Map<string, Set<string>>> {
  const r = await q<{ rewind_id: string; target_id: string }>(
    `SELECT DISTINCT e.tx_meta->>'undoes_rewind' AS rewind_id, e.target_id FROM domain_events e
      WHERE e.workspace_id = $1 AND e.tx_meta ? 'undoes_rewind' AND e.tx_meta->>'undoes_rewind' = ANY($2::text[])`,
    [workspaceId, rewindIds],
  );
  const out = new Map<string, Set<string>>();
  for (const row of r.rows) (out.get(row.rewind_id) ?? out.set(row.rewind_id, new Set()).get(row.rewind_id)!).add(row.target_id);
  return out;
}

export async function undoRewind(
  workspaceId: string, rewindId: string, nodeIds: string[], { actor: authenticated }: { actor: ActorCtx },
): Promise<RewindUndoResult> {
  return withIdempotencyClaim(workspaceId, (claim) => withEventTransaction(workspaceId, async () => {
    await claim();
    const actor = await resolveCurrentActor(authenticated, workspaceId);
    const events = await rewindEvents(workspaceId, { rewindId });
    const readable = await readableNotes(actor, workspaceId, [...new Set(events.map((e) => e.target_id))]);
    if (![...readable.keys()].length) throw new RewindError("rewind_not_found", 404);
    const done = (await undoneNodes(workspaceId, [rewindId])).get(rewindId) ?? new Set<string>();
    const byNode = new Map<string, RewindEvent[]>();
    for (const e of events) (byNode.get(e.target_id) ?? byNode.set(e.target_id, []).get(e.target_id)!).push(e);
    const result: RewindUndoResult = { undone: [], conflicts: [], kept: [], skipped: [] };
    const undoMeta = { undoes_rewind: rewindId };

    // Last step first, as the rewind took them: a note a parent's undelete brought back got its text step
    // after that undelete, and a child undeleted on its own came after its parent. Its text goes back while
    // it is still live; the parent's undo then deletes the family again, and a deleted note cannot be edited.
    const lastStep = (id: string) => Math.max(-1, ...(byNode.get(id) ?? []).map((e) => Number(e.id)));
    const ordered = [...new Set(nodeIds)].sort((a, b) => lastStep(b) - lastStep(a));
    for (const id of ordered) {
      const mine = byNode.get(id);
      if (!mine || !readable.has(id)) { result.skipped.push(id); continue; }
      if (done.has(id)) { result.undone.push(id); continue; }
      const last = mine[mine.length - 1]!;
      try {
        await withSavepoint(async () => {
          const rootKind = mine.find((e) => e.kind !== "undelete_content")?.kind ?? "restore";
          if (rootKind === "delete") {
            await undeleteNode(actor, workspaceId, id, { uiContext: "history.rewind.undo", txMeta: undoMeta });
            result.undone.push(id);
            return;
          }
          if (rootKind === "undelete") {
            // New work after the rewind (here or under it) must not be hidden by deleting again; the rewind's own
            // text steps (a child brought back with this note) and their undo are not new work.
            const family = [id, ...await trashSubtreeIds(workspaceId, id)];
            const edited = await q(
              `SELECT 1 FROM domain_events e WHERE e.workspace_id = $1 AND e.target_id = ANY($2::text[]) AND e.id > $3::bigint
                  AND ${bodyEventSql("e")}
                  AND e.tx_meta->>'rewind_id' IS DISTINCT FROM $4 AND e.tx_meta->>'undoes_rewind' IS DISTINCT FROM $4 LIMIT 1`,
              [workspaceId, family, last.id, rewindId],
            );
            if (edited.rows.length > 0) { result.kept.push(id); return; }
          }
          // restore, or the text step of an undelete: go back to the text before the rewind.
          const step = mine.find((e) => e.kind === "restore" || e.kind === "undelete_content");
          if (step) {
            const conflicted = await revertStep(workspaceId, actor, id, step, rewindId);
            if (conflicted === "missing") { result.skipped.push(id); return; }
            if (conflicted) result.conflicts.push(id);
          }
          if (rootKind === "undelete") await trashNode(actor, workspaceId, id, { uiContext: "history.rewind.undo", txMeta: undoMeta });
          result.undone.push(id);
        });
      } catch (error) {
        if (isWriteRefusal(error) || error instanceof NodeUpdateError || error instanceof NodeTrashError) result.skipped.push(id);
        else throw error;
      }
    }
    return result;
  }));
}

/** Put back the text a rewind step replaced. true = lines went to the inbox, "missing" = nothing to go back to. */
async function revertStep(workspaceId: string, actor: ActorCtx, id: string, step: RewindEvent, rewindId: string): Promise<boolean | "missing"> {
  const before = (await q<{ body_hash: string; title: string | null }>(
    `SELECT e.payload->>'body_hash' AS body_hash, e.payload->>'title' AS title FROM domain_events e
      WHERE e.workspace_id = $1 AND e.target_id = $2 AND e.id < $3::bigint
        AND ${bodyEventSql("e")}
      ORDER BY e.id DESC LIMIT 1`,
    [workspaceId, id, step.id],
  )).rows[0];
  if (!before || !step.body_hash) return "missing";
  const bodies = await bodiesByHash([before.body_hash, step.body_hash]);
  const previous = bodies.get(before.body_hash);
  const rewound = bodies.get(step.body_hash);
  if (previous === undefined || rewound === undefined) return "missing";
  const now = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE workspace_id = $1 AND id = $2`, [workspaceId, id])).rows[0];
  if (!now) return "missing";
  const saved = await updateNode(workspaceId, id, {
    markdown: previous,
    // A title changed after the rewind stays.
    ...(before.title && now.title === step.title && before.title !== now.title ? { title: before.title } : {}),
  }, {
    actor, baseMarkdown: rewound, keepOnConflict: "current",
    event: { uiContext: "history.rewind.undo", txMeta: { undoes_rewind: rewindId }, cascadeLabel: "history.rewind.undo.cascade", backupPrefix: "NODE_UPDATED" },
  });
  return saved.bodyConflicts.length > 0;
}

