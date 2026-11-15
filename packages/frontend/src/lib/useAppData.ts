// The app data layer's React surface. State lives in lib/appStore (H4); the
// sync engine and the connection lifecycle — boot, online/offline with the
// reconnect retry, the refresh after a later offline→online flip, the unload
// flush, the access-revoked notice — live in lib/data (syncEngine.ts,
// connectivity.ts, reached through `dataSync`). This hook attaches that
// lifecycle to the window once and returns the store's slice plus the engine
// and node mutations.

import { useEffect } from "react";
import { dataSync, nodeMutations } from "./data";
import { selectCanvases, useAppSelector, useOnline } from "./appStore";

export function useAppData() {
  const data = useAppSelector((s) => s.data);
  const online = useOnline();
  const bootstrapped = useAppSelector((s) => s.bootstrapped);
  const canvases = useAppSelector(selectCanvases);
  const activeCanvas = useAppSelector((s) => s.activeCanvas);

  useEffect(() => dataSync.attachConnectivity(window), []);

  return {
    data,
    online,
    bootstrapped,
    hydrateNode: dataSync.hydrateNode,
    flushPendingWrites: dataSync.flushQueue,
    refresh: dataSync.refresh,
    sync: dataSync.sync,
    canvases,
    activeCanvas,
    ...nodeMutations,
    generatePreview: dataSync.generatePreview,
  };
}
