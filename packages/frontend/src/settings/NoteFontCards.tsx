import { ChoiceCards, type ChoiceOption } from "../components/ui";
import { useT } from "../lib/i18n";
import { NOTE_FONT_STACKS, NOTE_FONTS, type NoteFont } from "../lib/fontStacks";
import { isMissingHere } from "../lib/fontApply";
import { useNoteFont, type NoteFontChoice } from "./useNoteFont";

// The font choice, drawn: a square per face with 「永 Ag」 written in it. Shared by
// Settings › Notes and the note's 「文字樣式」 sheet, so both read and write the same preference.

/** The names of the built-in faces (i18n keys). */
export const NOTE_FONT_LABELS: Record<NoteFont, string> = { sans: "Sans", serif: "Serif", kai: "Kai (brush)", mono: "Mono" };

/** The note font's name as a row's value (the settings list, 外觀's 「筆記字體」). */
export function noteFontName(font: NoteFontChoice, t: (key: string) => string): string {
  if (font.value === "custom") return font.customName ?? "";
  return t(font.value === "system" ? "Same as the system" : NOTE_FONT_LABELS[font.value]);
}

export default function NoteFontCards() {
  const t = useT();
  const font = useNoteFont();
  const options: ChoiceOption<NoteFont | "custom" | "system">[] = NOTE_FONTS.map((f) => ({
    value: f,
    label: t(NOTE_FONT_LABELS[f]),
    sample: "永 Ag",
    sampleFont: NOTE_FONT_STACKS[f],
  }));
  if (font.value === "system") {
    options.push({ value: "system", label: t("Same as the system"), sample: "永 Ag", sampleFont: "system-ui, -apple-system, \"Segoe UI\", \"PingFang TC\", \"Microsoft JhengHei\"" });
  }
  if (font.customName) {
    options.push({
      value: "custom",
      label: isMissingHere({ mode: "custom", name: font.customName }) ? t("{font} (not on this device)", { font: font.customName }) : font.customName,
      sample: "永 Ag",
      sampleFont: `"${font.customName}", var(--ac-font-serif)`,
    });
  }
  return (
    <ChoiceCards label={t("Font")} value={font.value} options={options}
      onChange={(v) => { if (v !== "custom" && v !== "system") font.pick(v); }} />
  );
}
