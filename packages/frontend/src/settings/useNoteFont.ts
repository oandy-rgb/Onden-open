import { useSyncExternalStore } from "react";
import { DEFAULT_FONT_CHOICES, fontsPref, type FontChoices } from "../lib/fontPrefs";
import { applyFontVars, NOTE_FONTS, readNoteFont, type NoteFont } from "../lib/fontStacks";
import { applyFontChoices } from "../lib/fontApply";
import { setPref, settingPref } from "../lib/prefs";

// The note font as one choice (Settings › Notes › 字體, and a note's 「文字樣式」): a built-in
// face (`note.font`) or a family from this computer (the account's `fonts` body pick). Choosing
// one clears the other, so two settings never cover each other.

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export type NoteFontChoice = { /** "system": the older 「內文字型：跟系統一樣」 choice, kept as its own card until another is chosen. */
  value: NoteFont | "custom" | "system"; customName: string | null; pick: (font: NoteFont) => void; pickCustom: (name: string) => void };

export function useNoteFont(): NoteFontChoice {
  const builtIn = useSyncExternalStore(subscribe, readNoteFont, readNoteFont);
  const { value, save } = fontsPref.useValue();
  const choices: FontChoices = value ?? DEFAULT_FONT_CHOICES;
  const customName = choices.body.mode === "custom" && choices.body.name ? choices.body.name : null;
  const saveChoices = (next: FontChoices) => { save(next); applyFontChoices(next); };
  return {
    value: customName ? "custom" : choices.body.mode === "system" ? "system" : builtIn,
    customName,
    pick(font) {
      setPref(settingPref("note.font"), font);
      if (choices.body.mode !== "default") saveChoices({ ...choices, body: { mode: "default" } });
      else applyFontVars();
      for (const listener of listeners) listener();
    },
    pickCustom(name) {
      saveChoices({ ...choices, body: { mode: "custom", name } });
      for (const listener of listeners) listener();
    },
  };
}

export { NOTE_FONTS };
