import { useSyncExternalStore } from "react";
import { COARSE_POINTER_QUERY, matchesMedia, mediaQueryList } from "../lib/mediaQuery";
import { kbdHint, subscribeShortcuts } from "../lib/shortcuts";

/** Whether this device has a physical keyboard to press shortcuts on. A phone or tablet whose
 *  primary input is a finger does not, so it is shown no key hints (a touch screen has no Esc).
 *  The ONE test behind every visible keyboard hint; follows the device changing (a keyboard
 *  attached, a laptop folded into a tablet). */
export function useHasKeyboard(): boolean {
  return useSyncExternalStore(
    (listener) => {
      const list = mediaQueryList(COARSE_POINTER_QUERY);
      list?.addEventListener("change", listener);
      return () => list?.removeEventListener("change", listener);
    },
    () => !matchesMedia(COARSE_POINTER_QUERY),
    () => true,
  );
}

/** The keys of shortcut `id` as this device shows them ("⌘K" / "Ctrl+K"),
 *  following a change in Settings or in another tab; "" on a device without a
 *  keyboard. For titles, placeholders and <kbd> hints; never write the keys out
 *  by hand, and write the sentence so it reads right with no keys. */
export function useKbdHint(id: string): string {
  const hasKeyboard = useHasKeyboard();
  const keys = useSyncExternalStore(subscribeShortcuts, () => kbdHint(id), () => kbdHint(id));
  return hasKeyboard ? keys : "";
}
