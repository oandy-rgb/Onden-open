import { useEffect } from "react";
import { useAppSelector } from "../lib/appStore";
import { shellFeatureOnIn } from "../lib/shellFeatures";
import { useImportedFeatures } from "./useImportedFeatures";
import { arrangeNavigation, type NavActions, type NavLocation, type ShellNavigation } from "./shellNavigation";
import {
  moveDestination, pinDestination, placeDestination, sameNavLayout, swapPinned, unpinDestination,
  type NavSurface, type PinResult,
} from "../lib/navLayout";
import { useNavLayout } from "../lib/navLayoutStore";

/** What a nav surface can do to the layout. Every change is saved at once
 *  (lib/navLayoutStore: this device first, then the server). */
export type NavPinning = {
  /** Pin `id`; on a full phone bar nothing changes and the result names the
   *  entries to offer for a swap (then call `swap`). */
  pin: (id: string, surface: NavSurface) => PinResult;
  unpin: (id: string, surface: NavSurface) => void;
  /** The phone's swap: `id` takes `out`'s place in the bar. */
  swap: (id: string, out: string) => void;
  move: (id: string, delta: -1 | 1, surface?: NavSurface) => void;
  /** Drag-to-reorder (lib/navLayout placeDestination). */
  place: (id: string, index: number) => void;
  /** 「恢復預設」: back to the layout from before pins. */
  reset: () => void;
  /** Never edited (or reset): the default layout. */
  isDefault: boolean;
};

const NO_ACTIONS: NavActions = { setMode: () => {}, onOpenModule: () => {}, onOpenFeature: () => {} };

/** The nav as the person arranged it, for the top bar, the phone's bar and
 *  更多, and Settings › 導覽列 alike. Also the one place a stored layout loses
 *  the destinations that are gone: once the workspace's modules are known
 *  and the layout has been compared with the server, a removed module's pin
 *  is dropped, so turning it on again does not bring the pin back. Every
 *  function that is on is a destination; the default layout bars only the
 *  ones in use (lib/moduleUse). */
export function useShellNavigation(at: NavLocation = { mode: "notes" }, actions: NavActions = NO_ACTIONS): ShellNavigation & NavPinning {
  const features = useImportedFeatures();
  const modulesKnown = useAppSelector((s) => Array.isArray(s.data.workspace?.modules));
  const { value: stored, settled, save } = useNavLayout();
  const modules = useAppSelector((s) => s.data.workspace?.modules);
  const nav = arrangeNavigation(at, actions, features, stored, (feature) => shellFeatureOnIn(modules, feature));
  const { layout } = nav;

  const pruned = stored && !sameNavLayout(stored, layout) ? layout : null;
  useEffect(() => {
    if (pruned && settled && modulesKnown) save(pruned);
  }, [pruned?.order.join("|"), pruned?.phone, settled, modulesKnown]); // eslint-disable-line react-hooks/exhaustive-deps -- keyed by the pruned layout's content

  return {
    ...nav,
    pin: (id, surface) => {
      const result = pinDestination(layout, id, surface);
      if ("layout" in result && result.layout !== layout) save(result.layout);
      return result;
    },
    unpin: (id, surface) => { const next = unpinDestination(layout, id, surface); if (next !== layout) save(next); },
    swap: (id, out) => { const next = swapPinned(layout, id, out); if (next !== layout) save(next); },
    move: (id, delta, surface) => { const next = moveDestination(layout, id, delta, surface); if (next !== layout) save(next); },
    place: (id, index) => { const next = placeDestination(layout, id, index); if (!sameNavLayout(next, layout)) save(next); },
    reset: () => save(null),
    isDefault: stored === null,
  };
}
