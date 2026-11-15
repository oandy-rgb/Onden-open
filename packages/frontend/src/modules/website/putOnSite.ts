import { propertyWriter, runBackgroundWrite } from "../../lib/data";
import type { ContentNode } from "../../lib/api";
import { PUBLISHED_ATTR, PUBLISHED_FLAG } from "./publishBlocker";

/** Bring a note the site leaves out back on: a note kept off (「不發布」) goes back to its space's
 *  rule, a blank note or a saved article is published anyway. The palette command and the note's
 *  site row both end here; loaded on the click, so it stays out of the boot JS. */
export function putOnSite(node: Pick<ContentNode, "id" | "attrs">) {
  return runBackgroundWrite(node.attrs?.[PUBLISHED_ATTR] === "false"
    ? propertyWriter.remove(node.id, PUBLISHED_ATTR)
    : propertyWriter.set(node.id, PUBLISHED_ATTR, "true", PUBLISHED_FLAG));
}
