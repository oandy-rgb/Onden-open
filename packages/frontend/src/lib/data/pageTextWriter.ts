import { PAGE_TEXT_ATTRIBUTE } from "@onden/markdown/page-text";
import { savePageLayer } from "./pageLayerWriter";

/** Save the text boxes of a note's pages (`page_text`, @onden/markdown/page-text)
 *  as one attribute write (savePageLayer). */
export function savePageText(nodeId: string, value: string, base: string | null): void {
  savePageLayer(nodeId, PAGE_TEXT_ATTRIBUTE, value, base);
}
