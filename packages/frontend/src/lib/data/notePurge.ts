// Deleting a deleted note for good — History's 「永久刪除」 (backend
// services/nodeTrash.ts purgeDeleted). Online only: it is never queued, since
// nothing about it can be undone and a queued purge could run long after the
// person looked at what it takes. The confirmation shows the preview; the
// purge sends back the ids it showed, so the server refuses (409
// plan_changed) rather than take more than was confirmed.

import { randomUUID } from "../uuid";
import { sendWrite } from "./onlineWrite";
import { reads } from "./reads";
import type { PurgeItemResult, PurgePreview, PurgeResult } from "@onden/contract";

/** The server takes this many notes per request. */
export const PURGE_BATCH_MAX = 200;

// One key per confirmed plan: a retry after a lost response is the same
// request (the server answers 200 deduped, or 404 once it is gone).
const keys = new Map<string, string>();
const batchKeys = new Map<string, string>();

export const notePurge = {
  preview: (nodeId: string) => reads.notes.purgePreview<PurgePreview>(nodeId),
  async purge(preview: PurgePreview): Promise<PurgeResult | { deduped: true }> {
    const fingerprint = preview.ids.join(",");
    const key = keys.get(fingerprint) ?? randomUUID();
    keys.set(fingerprint, key);
    const result = await sendWrite<PurgeResult | { deduped: true }>(
      "POST", `/api/nodes/${encodeURIComponent(preview.node.id)}/purge`, { expected_ids: preview.ids }, key);
    keys.delete(fingerprint);
    return result;
  },
  /** Delete several deleted notes for good, each judged on its own like a single
   *  purge: `expectedIds` is what the person confirmed would go with that note
   *  (for a blank note, just itself). A refused note is reported in the result,
   *  the rest still go. At most PURGE_BATCH_MAX per call. null: a retry the
   *  server had already taken (per-note results are not repeated); read the list again. */
  async purgeMany(items: ReadonlyArray<{ nodeId: string; expectedIds: readonly string[] }>): Promise<PurgeItemResult[] | null> {
    const body = { items: items.map((item) => ({ node_id: item.nodeId, expected_ids: item.expectedIds })) };
    const fingerprint = JSON.stringify(body);
    const key = batchKeys.get(fingerprint) ?? randomUUID();
    batchKeys.set(fingerprint, key);
    const result = await sendWrite<{ results: PurgeItemResult[] } | { deduped: true }>("POST", "/api/history/deleted/purge", body, key);
    batchKeys.delete(fingerprint);
    return "results" in result ? result.results : null;
  },
};
