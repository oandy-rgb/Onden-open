import { NOTE_PAGES_ATTR } from "@onden/markdown/contract";
import { savePageLayer } from "./pageLayerWriter";

/** Save the list of a note's pages (`note_pages`, @onden/markdown/note-pages) as one attribute write (savePageLayer):
 *  `base` is the list it was made from, which the server merges the save into (mergeNotePages). */
export function saveNotePages(nodeId: string, value: string, base: string | null): void {
  savePageLayer(nodeId, NOTE_PAGES_ATTR, value, base);
}
