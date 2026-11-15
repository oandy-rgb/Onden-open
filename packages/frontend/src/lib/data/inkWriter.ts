import { isInkReadOnly, INK_DATA_ATTR } from "@onden/markdown/ink";
import { upsertAttribute } from "../localDb";
import { announceDrawingChange } from "../drawingChanges";
import { domainContext } from "./domainWriters";
import { makeWriteLifecycle } from "./writeLifecycle";
import { runBackgroundWrite } from "./backgroundWrite";
import { encodeInk, type InkPageAttr } from "../ink/store";
import type { InkDocument } from "../ink/types";
import type { InkMultiPageDoc } from "../pdf";
import type { NodeAttribute } from "../api";

const commit = makeWriteLifecycle(domainContext);

export type InkSaveDoc = InkDocument | InkMultiPageDoc;

export type InkSaveOptions = {
  /** Which attribute holds the page: the note's own handwriting (`ink_data`, the default) or its
   *  whiteboard's pen layer (`board_ink`). The write, the merge and the offline queue are the same. */
  attr?: InkPageAttr;
  /** The page is going away (pagehide, the app switched away): the save is
   *  remembered before anything is awaited and sent so that it outlives the
   *  page; one the page's own limit cannot carry is recovered on the next start. */
  keepalive?: boolean;
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
 *  would read its strokes as deleted by the other side). It never rejects.
 *
 *  A drawing that needs a newer version to edit (isInkReadOnly) is never
 *  saved: this is a no-op for it, whichever host asks. */
export function saveInk(nodeId: string, doc: InkSaveDoc, base?: InkSaveDoc | null, options: InkSaveOptions = {}): Promise<boolean> {
  if (isInkReadOnly(doc)) return Promise.resolve(false);
  const attr = options.attr ?? INK_DATA_ATTR;
  const value = encodeInk(doc);
  const attribute = { value, value_type: "text", is_inheritable: false };
  // The whole value and its base are kept (also in the offline queue); what
  // goes over the wire is decided when it is sent (patchedBody.ts).
  const body = JSON.stringify(base === undefined ? attribute : { ...attribute, base_value: base === null ? "" : encodeInk(base) });
  // The local copy holds what the server stored once it answers: the merge
  // may have added another device's strokes.
  let mirrored = value;
  const write = commit<NodeAttribute>(`node:${nodeId}`, {
    method: "PUT", path: `/api/nodes/${nodeId}/attributes/${attr}`, body,
    ...(options.keepalive ? { init: { keepalive: true } } : {}),
  }, {
    mirror: () => upsertAttribute(nodeId, attr, mirrored, "text", false, "ui"),
    accepted: (result) => {
      if (result.status === "synced" && typeof result.value?.value === "string") mirrored = result.value.value;
    },
  });
  runBackgroundWrite(write);
  // Once, when the save has settled (the server has it, or it is queued and the local copy answers): pictures of this
  // drawing elsewhere read it again.
  const settled = () => { if (attr === INK_DATA_ATTR) announceDrawingChange(nodeId); };
  return write.then(() => { settled(); return true; }, () => { settled(); return false; });
}
