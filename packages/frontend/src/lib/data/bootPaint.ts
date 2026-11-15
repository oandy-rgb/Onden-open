// Cold boot: paint the downloaded bootstrap before the worker has written it
// to the mirror. The worker's persistBootstrap returns the payload with the
// durable queue's note text applied (pendingNoteProjection, batches 17/24);
// the first paint applies the same projection on the main thread from the
// queue read once, so the user's own pending edits are never shown reverted,
// not even for the frames before the worker answers.
import type { Bootstrap, ContentNode } from "../api";
import type { PendingWrite } from "../localDb";
import { missingPendingNoteCreations, projectPendingNoteText } from "../pendingNoteProjection";

/** `next` with `pending` (active rows, replay order) applied, as persistBootstrap
 *  would return it. An empty queue returns `next` itself. */
export function projectBootstrapForPaint(next: Bootstrap, pending: PendingWrite[]): Bootstrap {
  if (next.nodes_omitted === true || pending.length === 0) return next;
  return { ...next, nodes: [...projectPendingNoteText(next.nodes, pending), ...missingPendingNoteCreations(next.nodes, pending)] };
}

const sameText = (a: ContentNode, b: ContentNode) =>
  a.title === b.title && a.markdown === b.markdown && a.body_len === b.body_len;

/** The store after the worker's answer arrived. `painted` is what was shown,
 *  `applied` what the worker persisted. Normally they match (the queue did not
 *  change in between) and the store is returned untouched. A note whose queued
 *  text differs is updated only while the store still holds the painted text:
 *  anything the user typed since is newer than either and is kept. */
export function reconcilePersistedBootstrap(current: Bootstrap, painted: Bootstrap, applied: Bootstrap): Bootstrap {
  const paintedById = new Map(painted.nodes.map(n => [n.id, n]));
  const currentById = new Map(current.nodes.map(n => [n.id, n]));
  const patched = new Map<string, ContentNode>();
  const added: ContentNode[] = [];
  for (const node of applied.nodes) {
    const shown = paintedById.get(node.id);
    const now = currentById.get(node.id);
    if (!shown) { if (!now) added.push(node); continue; }
    if (sameText(shown, node) || !now || !sameText(shown, now)) continue;
    patched.set(node.id, { ...now, title: node.title, markdown: node.markdown, ...(node.body_len !== undefined ? { body_len: node.body_len } : {}) });
  }
  if (patched.size === 0 && added.length === 0) return current;
  return { ...current, nodes: [...current.nodes.map(n => patched.get(n.id) ?? n), ...added] };
}
