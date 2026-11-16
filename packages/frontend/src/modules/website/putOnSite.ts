import { propertyWriter, writeErrors } from "../../lib/data";
import { addToast } from "../../lib/appStore";
import type { ContentNode } from "../../lib/api";
import { PUBLISHED_ATTR, PUBLISHED_FLAG } from "./publishBlocker";

/** Bring a note the site leaves out back on: a note kept off (「不發布」) goes back to its space's
 *  rule, a blank note or a saved article is published anyway. The palette command and the note's
 *  site row both end here; loaded on the click, so it stays out of the boot JS.
 *  Resolves true once the write was accepted (or queued offline); on failure it reports it and
 *  resolves false. A caller that goes on with the result (the preview re-asks the server what is
 *  left out) must wait for this, or it reads the state from before the write. */
export async function putOnSite(node: Pick<ContentNode, "id" | "attrs">): Promise<boolean> {
  try {
    await (node.attrs?.[PUBLISHED_ATTR] === "false"
      ? propertyWriter.remove(node.id, PUBLISHED_ATTR)
      : propertyWriter.set(node.id, PUBLISHED_ATTR, "true", PUBLISHED_FLAG));
    return true;
  } catch (error) {
    writeErrors.report(error, addToast);
    return false;
  }
}
