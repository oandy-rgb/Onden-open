// Resolve the font choices against this device and put them on the page. Loads on use (after
// the first paint, and with the settings widget): lib/fontPrefs is the boot-resident part.
import { applyFontVars, type FontStacks } from "./fontStacks";
import { DEFAULT_FONT_CHOICES, type FontChoices, type FontPick, type FontRole } from "./fontPrefs";
import { hasFont } from "./localFonts";
import { PREFS, setPrefJson } from "./prefs";

/** The device's own faces, then the app's. The tail is a font that has Chinese, so a missing glyph is never a box. */
const SYSTEM_STACK = 'system-ui, -apple-system, "Segoe UI", "PingFang TC", "Microsoft JhengHei"';
const TAIL: Record<FontRole, string> = { ui: "var(--ac-font-sans)", body: "var(--ac-font-serif)" };

/** The CSS font list for one choice, or null for the built-in face (also a custom family this
 *  device lacks, and a custom choice with no name yet). `installed` is for tests. */
export function fontStack(role: FontRole, pick: FontPick, installed: (name: string) => boolean = hasFont): string | null {
  if (pick.mode === "system") return `${SYSTEM_STACK}, ${TAIL[role]}`;
  if (pick.mode !== "custom" || !pick.name || !installed(pick.name)) return null;
  return `"${pick.name}", ${TAIL[role]}`;
}

export const fontStacks = (choices: FontChoices, installed?: (name: string) => boolean): FontStacks => ({
  ui: null, // 介面字型 is gone: the interface follows the system
  body: fontStack("body", choices.body, installed),
});

/** Whether a custom choice names a family this device does not have. */
export const isMissingHere = (pick: FontPick, installed: (name: string) => boolean = hasFont): boolean =>
  pick.mode === "custom" && !!pick.name && !installed(pick.name);


/** Resolve the choices against this device and put them on the page. */
export function applyFontChoices(choices: FontChoices | null): void {
  setPrefJson(PREFS.fontStacks, fontStacks(choices ?? DEFAULT_FONT_CHOICES));
  applyFontVars();
}
