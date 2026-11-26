import { isInkReadOnly, INK_DATA_ATTR, encodeInk, mergeInk, type InkMergeConflict } from "@onden/markdown/ink";
import { upsertAttribute } from "../localDb";
import { announceDrawingChange } from "../drawingChanges";
import { domainContext } from "./domainWriters";
import { makeWriteLifecycle } from "./writeLifecycle";
import { keepUnsentWrite, type KeptWrite } from "./writeQueue";
import { runBackgroundWrite } from "./backgroundWrite";
import { classifyWriteFailure } from "./writeErrors";
import { notifyInkVersionNotKept, type InkPageAttr } from "../ink/store";
import { mergeDropsSent } from "./inkMergeLoss";
import type { InkDocument } from "../ink/types";
import type { InkMultiPageDoc } from "../pdf";
import type { NodeAttribute } from "../api";

const commit = makeWriteLifecycle(domainContext);

export type InkSaveDoc = InkDocument | InkMultiPageDoc;

/** What a save was made from, or is: a drawing, or the encoded text (the saver sends the value it merged, and names the
 *  text the server answered with as the base: lib/ink/surfaceSaver). */
export type InkSaveBase = InkSaveDoc | string;

export type InkSaveOptions = {
  /** Which attribute holds the page: the note's own handwriting (`ink_data`, the default) or its
   *  whiteboard's pen layer (`board_ink`). The write, the merge and the offline queue are the same. */
  attr?: InkPageAttr;
  /** The page is going away (pagehide, the app switched away): the save is
   *  remembered before anything is awaited and sent so that it outlives the
   *  page; one the page's own limit cannot carry is recovered on the next start. */
  keepalive?: boolean;
  /** Called with what the server stored and the text this save sent as its value, when the server answered (not when only
   *  the offline queue holds the save): a merge may have added another device's strokes to what it stored. */
  onServerAnswer?: (stored: string, sent: string) => void;
  /** The change's kept row (keepUnsentInk): the save is made under its key, its row now holding this request, so a copy
   *  the page left behind and this save are one write to the server. */
  kept?: KeptWrite;
};

/** Save a note's drawing — a handwriting/canvas page or a PDF's envelope
 *  (strokes and highlights together) — as its one `ink_data` attribute (`options.attr`: or `board_ink`): one
 *  write, one event. Call it with a settled document (the ink engine already
 *  debounced); offline it is mirrored and queued. Ink engines retain the
 *  user's strokes on rejection so they can be exported or retried; submission
 *  and storage errors follow the shared write policy.
 *
 *  `base` is the drawing this one was made from: what the surface loaded
 *  (null when the note had none) or, after that, what it saved last. It rides
 *  with the write, also in the offline queue, so the server merges the save
 *  into what another device stored meanwhile instead of overwriting it
 *  (@onden/markdown/ink mergeInk). Without a base the value is stored as sent.
 *  Sending only what changed against that base is writeQueue's job.
 *
 *  The result says whether the server accepted this save or the offline queue
 *  holds it (true), not whether it was refused, dropped or failed (false).
 *  The next save's base moves forward only on true: a refused save never
 *  reached the server, so a later save must not be made "from" it (the merge
 *  would read its strokes as deleted by the other side; lib/ink/surfaceSaver
 *  sends the surface's drawing again when that happened). It never rejects.
 *
 *  `doc` may be the encoded text itself (the saver sends the value it merged: lib/ink/surfaceSaver).
 *  A drawing that needs a newer version to edit (isInkReadOnly) is never
 *  saved: this is a no-op for it, whichever host asks. */
export function saveInk(nodeId: string, doc: InkSaveBase, base?: InkSaveBase | null, options: InkSaveOptions = {}): Promise<boolean> {
  if (typeof doc !== "string" && isInkReadOnly(doc)) return Promise.resolve(false);
  const { attr, value, request } = inkRequest(nodeId, doc, base, options.attr);
  // Before this write's own record (same chain): the kept row becomes this request, under the key it is sent with.
  if (options.kept) void options.kept.rewrite(request, { asSave: true });
  // The local copy holds what the server stored once it answers: the merge
  // may have added another device's strokes.
  let mirrored = value;
  const write = commit<NodeAttribute>(`node:${nodeId}`, {
    ...request,
    ...(options.kept ? { idemKey: options.kept.idemKey } : {}),
    ...(options.keepalive ? { init: { keepalive: true } } : {}),
  }, {
    mirror: () => upsertAttribute(nodeId, attr, mirrored, "text", false, "ui"),
    accepted: (result) => {
      if (result.status === "synced" && typeof result.value?.value === "string") {
        mirrored = result.value.value;
        options.onServerAnswer?.(mirrored, value);
        // The merge kept another device's version of something this save changed: say so once; the drawing on screen is
        // not swapped (the version sent is in the conflict record, and Revert in the inbox brings it back).
        const conflicts = (result.value as { conflict?: { ink_conflicts?: InkMergeConflict[] } }).conflict?.ink_conflicts;
        if (conflicts?.length && mergeDropsSent({ value: mirrored, conflicts }, value)) notifyInkVersionNotKept();
      }
    },
  });
  runBackgroundWrite(write);
  // The write took its own share of the key's lock: the kept one goes once it has an outcome.
  // Its answer (accepted, or queued: its row is durable; or refused) leaves nothing for the copy taken at pen-up to keep.
  if (options.kept) {
    const kept = options.kept;
    void write.then(() => { kept.answered(); kept.release(); }, (error: unknown) => {
      if (classifyWriteFailure(error) === "rejected") kept.answered();
      kept.release();
    });
  }
  // Once, when the save has settled (the server has it, or it is queued and the local copy answers): pictures of this
  // drawing elsewhere read it again.
  const settled = () => { if (attr === INK_DATA_ATTR) announceDrawingChange(nodeId); };
  return write.then(() => { settled(); return true; }, () => { settled(); return false; });
}

/** Strokes the person added and that are not saved yet, kept on this device from now on (writeQueue.keepUnsentWrite):
 *  `doc` holds only them (lib/ink/additions) and goes as a save made from nothing (`base` null: the server adds them to
 *  what it holds and removes nothing), as a queue row under the key the save will use (`into`: the row kept since the last
 *  save, written again with everything added since). Hand the row to the save (`saveInk`'s `kept`), or `drop()` it when no
 *  save follows. The local copy is not touched: it holds whole drawings, and a read lays what is queued over it
 *  (lib/data/reads attributeValues). `written` is false when storage could not take it. */
export function keepUnsentInk(nodeId: string, doc: InkSaveBase, base: InkSaveBase | null | undefined, options: { attr?: InkPageAttr; into?: KeptWrite; holdOnly?: boolean } = {}): { kept: KeptWrite | null; written: Promise<boolean> } {
  if (typeof doc !== "string" && isInkReadOnly(doc)) return { kept: options.into ?? null, written: Promise.resolve(false) };
  const { request } = inkRequest(nodeId, doc, base, options.attr);
  // `holdOnly`: a write into the row is on its way; only the synchronous copy now (KeptWrite.hold), the row after it.
  if (options.into && options.holdOnly) { options.into.hold(request); return { kept: options.into, written: Promise.resolve(true) }; }
  const kept = options.into ?? keepUnsentWrite(request);
  const written = options.into ? options.into.rewrite(request) : kept.recorded;
  return { kept, written };
}

/** The one request a drawing's save is: the whole value and its base (also in the queue); what goes over the wire is
 *  decided when it is sent (patchedBody.ts). */
function inkRequest(nodeId: string, doc: InkSaveBase, base: InkSaveBase | null | undefined, attrOption: InkPageAttr | undefined) {
  const attr = attrOption ?? INK_DATA_ATTR;
  const value = typeof doc === "string" ? doc : encodeInk(doc);
  const attribute = { value, value_type: "text", is_inheritable: false };
  const body = JSON.stringify(base === undefined ? attribute : { ...attribute, base_value: base === null ? "" : typeof base === "string" ? base : encodeInk(base) });
  return { attr, value, request: { method: "PUT" as const, path: `/api/nodes/${nodeId}/attributes/${attr}`, body } };
}

/** A drawing as this device will have it once its queued saves are sent: `value` (the local copy) with each queued save
 *  of `attr` on this note laid over it, in queue order, merged the way the server merges a save (mergeInk with its base;
 *  a save made from nothing — strokes kept at pen-up — adds them). What a page opened after a kill shows, so strokes that
 *  only the queue holds are on screen and not drawn again. A row that is not this writer's request is skipped. */
export function withQueuedInk(nodeId: string, attr: string, value: string | null, rows: ReadonlyArray<{ method: string; path: string; body: string | null }>): string | null {
  const path = `/api/nodes/${nodeId}/attributes/${attr}`;
  let current = value;
  for (const row of rows) {
    if (row.method !== "PUT" || row.path !== path || !row.body) continue;
    let fields: { value?: unknown; base_value?: unknown };
    try { fields = JSON.parse(row.body) as typeof fields; } catch { continue; }
    if (typeof fields.value !== "string") continue;
    current = typeof fields.base_value === "string" ? mergeInk(fields.base_value, current, fields.value).value : fields.value;
  }
  return current;
}
