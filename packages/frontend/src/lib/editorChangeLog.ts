// The editor's own edits as one CodeMirror ChangeSet per note, so a save can tell the server
// exactly what changed (PATCH body_change.changes) and block anchors move with the same mapPos the
// editor uses. Best effort: the server applies the set to its copy of the old body and only trusts it
// when the result equals the new body (services/blockAnchors/changes.ts), so a stale or mismatched
// log costs nothing but a derived diff on the server.

import type { ChangeDesc, ChangeSet } from "@codemirror/state";
import { randomUUID } from "./uuid";

/** Tells this browser profile's edits apart from another device's in anchor history. */
const DEVICE = `web-${randomUUID()}`;

type Carried = { id: string; from: number; to: number };
type Log = { composed: ChangeSet; carried: Carried[] };
const logs = new Map<string, Log>();

/** A user edit of the editor showing `noteId` (recordEditorUpdate decides what is one). `carried`: paragraphs whose anchors a cut and paste moved
 *  to a new place in this change (lib/editorAnchors carriedInUpdate), at their places after it. */
function recordEditorChange(noteId: string, changes: ChangeSet, carried: readonly Carried[] = []): void {
  let log = logs.get(noteId);
  // A log that does not end where this change begins (a text swapped under the editor without a reset) can no
  // longer describe the edits: compose would throw. Start over from this change.
  if (log && log.composed.newLength !== changes.length) log = undefined;
  const moved = (log?.carried ?? [])
    .map((c) => ({ id: c.id, from: changes.mapPos(c.from, -1), to: changes.mapPos(c.to, 1) }))
    .filter((c) => c.from < c.to);
  logs.set(noteId, { composed: log ? log.composed.compose(changes) : changes, carried: [...moved.filter((c) => !carried.some((n) => n.id === c.id)), ...carried] });
}

/** One document change of the editor showing `noteId`. `external`: the text was replaced from outside (another note
 *  opened, a remote edit, a restore). That is not the person's edit and the text it started from is gone, so what was
 *  logged no longer fits: the log starts over rather than recording it. */
export function recordEditorUpdate(noteId: string, changes: ChangeSet, opts: { external: boolean; carried?: readonly Carried[] }): void {
  if (opts.external) logs.delete(noteId);
  else recordEditorChange(noteId, changes, opts.carried);
}

/** The body is now known to be `length` long on both sides (opened, adopted from the server, reset). */
export function resetEditorChanges(noteId: string): void { logs.delete(noteId); }

/** `carried_anchors`: the anchors of paragraphs the person cut and pasted within the note, at their places in the new text: a
 *  hint for the server to keep those paragraphs' identity (it checks the words there; it never trusts the place). */
export type EditorBodyChange = { changes: unknown; device: string; carried_anchors?: Carried[] };

/**
 * Takes the edits made since the last take for a save that turns a `baseLength` text into a
 * `draftLength` one. Null when the log does not fit those lengths (then nothing is sent and the server
 * derives the change). Give the result back with `restoreEditorChanges` if the save did not go out.
 */
export function takeEditorChanges(noteId: string, baseLength: number, draftLength: number): { body: EditorBodyChange; taken: ChangeSet } | null {
  const log = logs.get(noteId);
  if (!log) return null;
  logs.delete(noteId);
  const c: ChangeDesc = log.composed;
  if (c.length !== baseLength || c.newLength !== draftLength) return null;
  return { body: { changes: log.composed.toJSON(), device: DEVICE, ...(log.carried.length > 0 ? { carried_anchors: log.carried } : {}) }, taken: log.composed };
}

/** A save that was taken but failed before the server saw it: later edits continue from it. */
export function restoreEditorChanges(noteId: string, taken: ChangeSet, carried: readonly Carried[] = []): void {
  const later = logs.get(noteId);
  // The taken places are at the end of `taken`; the edits since moved them.
  const earlier = later ? carried.map((c) => ({ id: c.id, from: later.composed.mapPos(c.from, -1), to: later.composed.mapPos(c.to, 1) })).filter((c) => c.from < c.to) : [...carried];
  const newer = later?.carried ?? [];
  logs.set(noteId, { composed: later ? taken.compose(later.composed) : taken, carried: [...earlier.filter((c) => !newer.some((n) => n.id === c.id)), ...newer] });
}
