import { useCallback, useSyncExternalStore } from "react";
import { drawingRestoreSerial, onDrawingRestored } from "../lib/drawingChanges";

/** A number that changes whenever a version of `nodeId`'s drawing is put back from History: a surface that loads the
 *  drawing lists it among the things it loads for, so it shows (and saves from) what was restored. */
export function useDrawingRestoreSerial(nodeId: string | undefined): number {
  const subscribe = useCallback((listener: () => void) => (nodeId ? onDrawingRestored(nodeId, listener) : () => {}), [nodeId]);
  return useSyncExternalStore(subscribe, () => (nodeId ? drawingRestoreSerial(nodeId) : 0));
}
