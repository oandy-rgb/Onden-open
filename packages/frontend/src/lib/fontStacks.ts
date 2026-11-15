// The two font variables of the page, set from the font choices this device last resolved
// (Settings › Appearance › Fonts; the choice itself is the account's, lib/fontPrefs). Boot calls
// this before sign-in, so it holds only the cache read and the CSS write; the choosing UI, the
// list of installed fonts and the sync load on use.
//
//   --onden-ui-font-family-ui      the interface; always the default (it follows the system)
//   --onden-ui-font-family-editor  note text; the old 「編輯器字型」 setting when the body font is the default

import { PREFS, getPref, getPrefJson, settingPref } from "./prefs";
import { setRootStyle } from "./documentAccess";

/** The built-in note faces (Settings › Notes › 字體), in the order the cards show them. */
export const NOTE_FONTS = ["sans", "serif", "kai", "mono"] as const;
export type NoteFont = (typeof NOTE_FONTS)[number];

/** The note faces, by token. Kai and monospace also list a Chinese face behind them, so a glyph
 *  the face lacks is never a box. */
export const NOTE_FONT_STACKS: Record<NoteFont, string> = {
  serif: "var(--ac-font-serif)",
  sans: "var(--ac-font-sans)",
  kai: "var(--ac-font-kai), var(--ac-font-serif)",
  mono: "var(--ac-font-mono), var(--ac-font-sans)",
};

/** The chosen built-in note face: `note.font`, else the older 「編輯器字體」, else serif. */
export function readNoteFont(): NoteFont {
  for (const key of ["note.font", "theme.editor_font"]) {
    const raw = getPref(settingPref(key));
    if ((NOTE_FONTS as readonly string[]).includes(raw ?? "")) return raw as NoteFont;
  }
  return "serif";
}

export type FontStacks = { ui: string | null; body: string | null };

/** The cached stacks; a damaged copy reads as the built-in faces. */
export function readFontStacks(): FontStacks {
  const raw = getPrefJson(PREFS.fontStacks) as Partial<Record<keyof FontStacks, unknown>> | null;
  const text = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length < 400 ? v : null);
  return { ui: text(raw?.ui), body: text(raw?.body) };
}

/** Put the fonts on the page: the cached stacks, else the built-in faces. */
export function applyFontVars(): void {
  const { body } = readFontStacks();
  // The interface follows the system face: the older 「介面字型」 choice is no longer applied.
  setRootStyle("--onden-ui-font-family-ui", null);
  setRootStyle("--onden-ui-font-family-editor", body ?? NOTE_FONT_STACKS[readNoteFont()]);
}
