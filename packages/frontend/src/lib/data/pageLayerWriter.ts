import { announceDrawingChange } from "../drawingChanges";
import { upsertAttribute } from "../localDb";
import { domainContext } from "./domainWriters";
import { makeWriteLifecycle } from "./writeLifecycle";
import { runBackgroundWrite } from "./backgroundWrite";
import type { NodeAttribute } from "../api";

// The layers of a page that are saved as their own attribute — the text boxes
// (`page_text`) and the pictures (`page_images`) — share this one write; each
// has a thin entry (pageTextWriter, pageImagesWriter) naming its key. So does a note's list of
// pages (`note_pages`, notePagesWriter, written by the 「手寫」 tab when a page is added): a small value saved from a base the server merges into.

const commit = makeWriteLifecycle(domainContext);

/** Save one page layer of a note as one attribute write: one save, one
 *  ATTRIBUTE_SET event holding the value before it. Call it with a settled
 *  value (the layer's controller waits for the editing to pause); offline it is
 *  mirrored and queued, like a drawing.
 *
 *  `base` is the value this one was made from (null when the note had none):
 *  it rides with the write, also in the offline queue, so the server merges the
 *  save into what another device stored meanwhile, item by item, instead of
 *  overwriting it. Rejections and storage errors follow the shared write policy. */
export function savePageLayer(nodeId: string, key: string, value: string, base: string | null): void {
  const attribute = { value, value_type: "text", is_inheritable: false };
  const body = JSON.stringify({ ...attribute, base_value: base ?? "" });
  // The local copy holds what the server stored once it answers: the merge
  // may have added another device's items.
  let mirrored = value;
  const write = commit<NodeAttribute>(`node:${nodeId}`, {
    method: "PUT", path: `/api/nodes/${nodeId}/attributes/${key}`, body,
  }, {
    mirror: () => upsertAttribute(nodeId, key, mirrored, "text", false, "ui"),
    accepted: (result) => {
      if (result.status === "synced" && typeof result.value?.value === "string") mirrored = result.value.value;
    },
  });
  runBackgroundWrite(write);
  // Pictures of this page that other notes quote (lib/drawingChanges) read it again once the save has settled.
  const settled = () => announceDrawingChange(nodeId);
  write.then(settled, settled);
}
