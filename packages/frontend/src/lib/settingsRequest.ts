// Open Settings at a tab from anywhere (a module dialog, the Ask panel) — the
// shell owns the Settings modal (BuilderApp), so this is a request it hears.
import type { MovedTabId, SettingsTab } from "./settingsTab";

const EVENT = "onden:open-settings";

/** `tab` may be a page that moved (「writing」): the settings screen resolves it (resolveSettingsTab). */
export function openSettings(tab: SettingsTab | MovedTabId): void {
  window.dispatchEvent(new CustomEvent<SettingsTab | MovedTabId>(EVENT, { detail: tab }));
}

/** The shell's listener; returns the unsubscribe. */
export function onSettingsRequest(open: (tab: SettingsTab | MovedTabId) => void): () => void {
  const handler = (event: Event) => open((event as CustomEvent<SettingsTab | MovedTabId>).detail);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}

// 「空間與成員」 is one screen. Shortcuts that lead to it (a note's space chip, a
// move that some member or AI helper could not see) open the same screen
// filtered to one space, so there is no second place to change who is in a space.
let spaceFilter: string | null = null;
const filterListeners = new Set<() => void>();
const setSpaceFilter = (id: string | null) => {
  if (spaceFilter === id) return;
  spaceFilter = id;
  for (const l of filterListeners) l();
};

/** Open Settings › 空間與成員, showing only `spaceId` when given. */
export function openSpacesAndMembers(spaceId?: string): void {
  setSpaceFilter(spaceId ?? null);
  openSettings("spaces");
}

export const spaceFilterStore = {
  subscribe: (listener: () => void) => { filterListeners.add(listener); return () => { filterListeners.delete(listener); }; },
  get: () => spaceFilter,
  clear: () => setSpaceFilter(null),
};
