import { PAGE_IMAGES_ATTRIBUTE } from "@onden/markdown/page-images";
import { savePageLayer } from "./pageLayerWriter";

/** Save the pictures on a note's pages (`page_images`, @onden/markdown/page-images)
 *  as one attribute write (savePageLayer). */
export function savePageImages(nodeId: string, value: string, base: string | null): void {
  savePageLayer(nodeId, PAGE_IMAGES_ATTRIBUTE, value, base);
}
