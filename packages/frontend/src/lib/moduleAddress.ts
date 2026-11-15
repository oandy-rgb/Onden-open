import { useSyncExternalStore } from "react";

// The part of a module page's address after `view` (`?view=review&m=tag.<id>`): where inside the page the
// person is, so a reload and Back keep it. The page (a lazy chunk) owns what the text means and sets it
// with `setModuleAddress`; hooks/useUrlLocation writes it into the URL and reads it back on Back/forward,
// the same way the graph page's focus travels (hooks/useUrlLocation, 「The graph page's focus」).

const listeners = new Set<() => void>();
// Starts as the address the app was opened with: hooks/useUrlLocation sets it at load, where the URL is read.
let address: string | null = null;

export const getModuleAddress = () => address;

/** `next` is where the open page now is (null: its first page). A new history entry is made by the caller's
 *  `navigate(..., { history: "push" })` (lib/historyIntent), the same as any other location change. */
export function setModuleAddress(next: string | null): void {
  if (next === address) return;
  address = next;
  for (const listener of listeners) listener();
}

export function useModuleAddress(): string | null {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, getModuleAddress, () => null);
}
