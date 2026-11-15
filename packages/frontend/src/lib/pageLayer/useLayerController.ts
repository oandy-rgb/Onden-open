import { useEffect, useSyncExternalStore } from "react";
import type { LayerSelection } from "./store";
import { onPageHide } from "../pageHide";

/** What a layer's controller offers the hook: the store's reading side, and the
 *  two ways to save what is pending. */
type LayerController<Doc, Sel> = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => Doc;
  getSelection: () => Sel | null;
  commit: () => void;
  dispose: () => void;
};

const NO_SUBSCRIBE = () => () => {};
const NO_VALUE = () => null;

/** One open surface's use of a layer controller (lib/pageText, lib/pageImages):
 *  what is pending is saved when the page is hidden or closed (pagehide, a
 *  hidden tab) and when the surface goes away, and the document and selection
 *  re-render the surface when they change. `controller` is null when the surface
 *  has no such layer. */
export function useLayerController<Doc, Sel extends LayerSelection, C extends LayerController<Doc, Sel>>(
  controller: C | null,
): { controller: C | null; doc: Doc | null; selection: Sel | null } {
  useEffect(() => {
    if (!controller) return;
    const stop = onPageHide(() => controller.commit());
    return () => {
      stop();
      controller.dispose();
    };
  }, [controller]);
  const doc = useSyncExternalStore(controller?.subscribe ?? NO_SUBSCRIBE, controller?.getSnapshot ?? (NO_VALUE as () => Doc | null));
  const selection = useSyncExternalStore(controller?.subscribe ?? NO_SUBSCRIBE, controller?.getSelection ?? (NO_VALUE as () => Sel | null));
  return { controller, doc: controller ? doc : null, selection };
}
