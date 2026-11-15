// Multi-note structure operations (card extraction) are several server writes
// that only make sense together. They run online with an empty write queue (a
// queued draft replayed later would overwrite the rewritten body), and these
// helpers keep a failure from leaving silent half-results.
//
// Not atomic: each step is its own server transaction. Creation is made
// retry-safe with client-minted ids used as idempotency keys, and a failed
// run removes the children it created.

import { randomUUID } from "../uuid";
import { addToast, getAppState, getNode } from "../appStore";
import type { ContentNode } from "../api";
import { planSiblingOrder, sortChildren } from "../childOrder";
import { t } from "../i18n";
import type { OnlineSubmit } from "./onlineWrite";
import { noteWriter, onlineOperation } from "./domainWriters";
import { classifyWriteFailure } from "./writeErrors";
import { isTag } from "@onden/markdown/contract";

export type ChildNoteInput = { title: string; markdown: string; sort_order: number };

/** Run `work` as one online operation (onlineWrite.ts: online, nothing
 *  queued, a key per intent reused on retry, a failure reported once). Each
 *  step writes through the `submit` it is given. Resolves null on failure, so
 *  callers never leave an unhandled rejection or a silent stop. */
export async function runStructureOperation<T>(work: (submit: OnlineSubmit) => Promise<T>, resource = "note-structure"): Promise<T | null> {
  try {
    return await onlineOperation(resource, t("Connect to change note structure."), work);
  } catch {
    return null; // reported by the operation
  }
}

/** Create child notes under `parentId` in order. Each body carries its own
 *  client id, so a resent request is the same intent with the same key and
 *  cannot duplicate it. `tagIds` are applied in each child's own creation
 *  request (it never exists untagged). If a create is refused, the children created so far
 *  are deleted again and the error is rethrown: the caller sees all or none.
 *  When the outcome is unknown (a lost response) nothing is deleted: the
 *  request may have been applied. */
export async function createChildNotes(submit: OnlineSubmit, parentId: string, children: ChildNoteInput[], options: { tagIds?: string[] } = {}): Promise<string[]> {
  const created: string[] = [];
  try {
    for (const child of children) {
      const id = randomUUID();
      await submit("/api/nodes", JSON.stringify({ id, parent_id: parentId, ...child, ...(options.tagIds?.length ? { tag_ids: options.tagIds } : {}) }));
      created.push(id);
    }
    return created;
  } catch (error) {
    if (classifyWriteFailure(error) === "rejected") await removeCreatedChildren(submit, created);
    throw error;
  }
}

/** Undo children made by an operation that then failed. A child that cannot be
 *  removed is named in a notice instead of being left unexplained. */
export async function removeCreatedChildren(submit: OnlineSubmit, ids: string[]): Promise<void> {
  const { failed } = await deleteNotes(submit, ids);
  if (failed.length) {
    addToast(t("{n} new child notes could not be removed after the failure. Check this note's children.", { n: failed.length }), "error");
  }
}

/** Soft-delete notes one by one, continuing past failures; returns the ids
 *  that could not be deleted so the caller can say so. */
export async function deleteNotes(submit: OnlineSubmit, ids: string[]): Promise<{ failed: string[] }> {
  const failed: string[] = [];
  for (const id of ids) {
    try { await submit(`/api/nodes/${id}`, undefined, "DELETE"); }
    catch { failed.push(id); }
  }
  return { failed };
}

// ── Sibling order (depth audit D64) ──
// The one writer of sort_order for a reorder. It renumbers only one parent's
// children, and only the rows whose value has to change (planSiblingOrder),
// so a drag in a long list is a PATCH or two, not one per note. Each row goes
// through the note writer: shown at once, queued offline, rolled back alone
// if refused. A sort_order-only PATCH leaves the note's updated_at alone on
// the server (services/nodeUpdate.ts).

const childRows = (parentId: string | null) =>
  getAppState().data.nodes.filter((n) => (n.parent_id ?? null) === parentId && !isTag(n));

/** A parent's children (tags excluded: they are listed apart), in display order. */
export function childrenOf(parentId: string | null): ContentNode[] {
  return sortChildren(childRows(parentId));
}

/** Put `parentId`'s children in `orderedIds` order. An id that is not yet a
 *  child of `parentId` moves under it in the same write. `moved` is the note
 *  the person dragged (it is the one renumbered when there is a choice).
 *  Resolves with the number of notes written. */
export async function reorderChildren(parentId: string | null, orderedIds: readonly string[], moved?: string): Promise<number> {
  const nodes = getAppState().data.nodes;
  const ids = new Set(orderedIds);
  const incoming = nodes.filter((n) => ids.has(n.id) && (n.parent_id ?? null) !== parentId);
  const changes = planSiblingOrder(childRows(parentId), orderedIds, moved, incoming);
  const writes: Promise<unknown>[] = [];
  for (const [id, sortOrder] of changes) {
    const node = getNode(id);
    if (!node) continue;
    const reparent = (node.parent_id ?? null) !== parentId;
    writes.push(noteWriter.patch(id, { sort_order: sortOrder, ...(reparent ? { parent_id: parentId } : {}) }).catch(() => null));
  }
  await Promise.all(writes);
  return writes.length;
}

/** Move a note under `parentId` as its last child. */
export async function appendChild(parentId: string, id: string): Promise<void> {
  const last = childrenOf(parentId).filter((n) => n.id !== id).at(-1);
  await noteWriter.patch(id, { parent_id: parentId, sort_order: last ? (last.sort_order ?? 0) + 1 : 0 }).catch(() => null);
}
