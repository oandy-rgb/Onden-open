// The reading hub (閱讀) reopens on the section last read, per device.

import { PREFS, getPref, setPref } from "./prefs";

export function rememberReadingSection(id: string): void {
  setPref(PREFS.readingLastSection, id);
}

/** The section the hub opens on: the last one read while it is still
 *  available, else the first. Null when the hub has no sections. */
export function readingEntrySection(available: readonly { id: string }[]): string | null {
  const last = getPref(PREFS.readingLastSection);
  return available.find((s) => s.id === last)?.id ?? available[0]?.id ?? null;
}
