// The deck's theme as what the PPTX master is made from, and the check of what
// the file cannot keep as editable text. Pure.

import { mermaidSources } from "@onden/markdown";
import { STYLE_PRESETS, type DeckStyle } from "@onden/site/look";
import type { Page } from "../pages";
import type { MasterLook } from "./deckSpec";
import type { FontKind } from "./measured";

/** The master's colours, sizes and faces, from the same variables the slides are drawn with (deckVars). */
export function masterLookOf(style: DeckStyle, vars: Readonly<Record<string, string>>): MasterLook {
  const preset = STYLE_PRESETS[style.preset];
  return {
    background: vars["--s-bg"]!,
    text: vars["--s-text"]!,
    headingFont: preset.head,
    bodyFont: preset.body,
    titleSizePx: parseFloat(vars["--s-step2"]!),
    bodySizePx: parseFloat(vars["--s-base"]!),
    titleBold: Number(vars["--s-weight-h"]) >= 600,
  };
}

export const fontKindsOf = (look: Pick<MasterLook, "headingFont" | "bodyFont">): FontKind[] => [look.headingFont, look.bodyFont];

/** What becomes a picture in the PPTX and cannot be edited there (slides are 1-based). Read from the page's own blocks
 *  (a formula block, a mermaid fence); what the export finds beyond that (a formula inside a line, a picture that could
 *  not be read) is told after it, from what was really written. */
export type PictureLoss = { kind: "math" | "diagram"; slides: number[] };

export function pictureLosses(pages: readonly Page[]): PictureLoss[] {
  const found: Record<PictureLoss["kind"], number[]> = { math: [], diagram: [] };
  pages.forEach((page, i) => {
    const blocks = page.parts.body;
    if (blocks.some((block) => block.kind === "math")) found.math.push(i + 1);
    if (blocks.some((block) => block.kind === "code" && mermaidSources(block.markdown).length > 0)) found.diagram.push(i + 1);
  });
  return (["math", "diagram"] as const).filter((kind) => found[kind].length > 0).map((kind) => ({ kind, slides: found[kind] }));
}
