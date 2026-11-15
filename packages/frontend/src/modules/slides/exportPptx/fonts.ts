// The fonts a PPTX is written in. A run in a PPTX has one font name, and the
// computer that opens the file may not have Noto, so the export offers three
// sets (docs/architecture/proposals/slides-2026-10-31.md §6.4). The names of
// Onden's own faces come from the site's FONT_STACKS, not a copy here.

import { FONT_STACKS } from "@onden/site/look";
import type { FontKind } from "./measured";

export type FontChoice = "common" | "noto" | "keep";
export const FONT_CHOICES: readonly FontChoice[] = ["common", "noto", "keep"];

/** The mono face for code in every set (Windows and Mac Office both have it). */
export const CODE_FONT = "Consolas";

/** Windows / Office names: what the file says and what the panel shows (the panel puts each name through `t`, so a
 *  zh-TW reader sees 微軟正黑體 for "Microsoft JhengHei"; i18n.zh-TW.ts has them). */
const COMMON: Record<FontKind, string> = { sans: "Microsoft JhengHei", serif: "PMingLiU", kai: "DFKai-SB" };
const NOTO: Record<FontKind, string> = { sans: "Noto Sans TC", serif: "Noto Serif TC", kai: COMMON.kai }; // Noto has no 楷書

/** The first family of a CSS stack, without the variable-font suffix: "Noto Sans TC Variable" → "Noto Sans TC". */
export const onFontName = (kind: FontKind): string =>
  (FONT_STACKS[kind].split(",")[0] ?? "").trim().replace(/^"|"$/g, "").replace(/ Variable$/, "");

/** The font name written in the file for a face of the deck. */
export function fontFile(kind: FontKind, choice: FontChoice): string {
  return choice === "common" ? COMMON[kind] : choice === "noto" ? NOTO[kind] : onFontName(kind);
}

/** The names for 「A → B」 lines for the faces the deck uses; empty when nothing is replaced. */
export function substitutions(kinds: Iterable<FontKind>, choice: FontChoice): { from: string; to: string }[] {
  if (choice === "keep") return [];
  const table = choice === "common" ? COMMON : NOTO;
  const out: { from: string; to: string }[] = [];
  for (const kind of new Set(kinds)) {
    const from = onFontName(kind);
    if (from !== table[kind]) out.push({ from, to: table[kind] });
  }
  return out;
}
