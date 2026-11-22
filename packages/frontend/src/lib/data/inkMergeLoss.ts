// Did a merge drop something the saved value holds? Then that version exists nowhere else (the other side of the
// conflict is another device's own save, in the history), so the app does not send its own merge: it sends the value as
// it is and the server keeps it with the conflict record (attributeWrites `submitted_value_ref`).
// The same judgement the server makes when it decides to keep the sent version (services/attributeWrites.ts sentVersionLost).
import { inkConflictLosers, type InkMergeResult } from "@onden/markdown/ink";

export function mergeDropsSent(merge: InkMergeResult, sent: string): boolean {
  return merge.value !== sent && merge.conflicts.some((c) => inkConflictLosers(merge.value, [sent], c).length > 0);
}
