import { useEffect, useState } from "react";
import { scheduleOfflineWarmup } from "../../lib/offlineWarmup";

/** Load the workspace's heavy lazy chunks up front, so the first mode switch
 *  is instant; true once they have loaded (or failed — they retry on use). */
export function useWorkspaceChunks() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    Promise.all([
      import("../KnowledgeWorkspace"),
      import("../BoardController"),
      import("../OverviewEditorHost"),
      import("../NodeInspector"),
    ]).finally(() => setReady(true));
  }, []);
  return ready;
}

/** Once the workspace is up and checked, fetch the other main screens' code on
 *  idle so the service worker can keep them for offline use (lib/offlineWarmup). */
export function useOfflineWarmup(settled: boolean) {
  useEffect(() => {
    if (settled) scheduleOfflineWarmup();
  }, [settled]);
}
