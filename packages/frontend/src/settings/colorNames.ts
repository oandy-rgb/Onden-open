import { APP_COLOR_PRESETS, DEFAULT_APP_SEED } from "@onden/site/palette";
import { readStoredColors } from "../lib/appColors";

/** The names of the colour presets (i18n keys), by preset id. */
export const PRESET_LABELS: Record<string, string> = {
  ochre: "Ochre ink",
  green: "Ink green",
  indigo: "Indigo ink",
  amber: "Amber",
  wisteria: "Wisteria",
  graphite: "Graphite",
};

/** The i18n key naming the colours in use: a preset's name, or "Custom". */
export function colorNameKey(): string {
  const stored = readStoredColors() ?? DEFAULT_APP_SEED;
  const preset = APP_COLOR_PRESETS.find((p) => p.accent === stored.accent && p.paper === stored.paper);
  return preset ? PRESET_LABELS[preset.id] ?? preset.id : "Custom";
}
