import type { TagMergeResult } from "../api";
import { sendWrite } from "./onlineWrite";

/** Merge one tag into another (owner only). Read the preview first:
 *  fetchTagMergePreview in lib/api. */
export function mergeTag(sourceId: string, targetId: string): Promise<TagMergeResult> {
  return sendWrite<TagMergeResult>("POST", `/api/tags/${sourceId}/merge`, { target_id: targetId });
}
