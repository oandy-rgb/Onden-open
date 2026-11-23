// The one sentence for a ChangeSummary — "新增 1 段、改了 2 段，在「待辦」" — shared by one
// note's version list (NoteHistory) and the workspace feed's rows, which get the same
// counts from the same backend function (summarizeChange).
import type { useT } from "../i18n";
import type { ChangeSummary } from "@onden/markdown";
import type { InkKind } from "@onden/markdown/ink";
import { displayTitle } from "../noteLabel";

export function changeSummaryText(t: ReturnType<typeof useT>, s: ChangeSummary): string {
  const parts = [
    s.added > 0 && t("Added {n}", { n: s.added }),
    s.changed > 0 && t("Changed {n}", { n: s.changed }),
    s.removed > 0 && t("Removed {n}", { n: s.removed }),
  ].filter(Boolean) as string[];
  if (parts.length === 0) return t("No change to the text");
  const joined = parts.join(t(", "));
  return s.sections.length === 0 ? joined : t("{parts}, in {sections}", { parts: joined, sections: s.sections.slice(0, 2).map((name) => t("“{name}”", { name })).join(t(", ")) });
}

/** One line for a point on the timeline: what the text did, and a rename when the title moved.
 *  A rename with no text change reads as a rename, not "no change". */
export function pointChangeText(t: ReturnType<typeof useT>, p: { summary: ChangeSummary; title: string; previousTitle: string | null }): string {
  const renamed = p.previousTitle !== null && p.previousTitle !== p.title;
  const textMoved = p.summary.added + p.summary.changed + p.summary.removed > 0;
  if (!renamed) return changeSummaryText(t, p.summary);
  const rename = t("Renamed from “{title}”", { title: displayTitle(p.previousTitle) });
  return textMoved ? `${changeSummaryText(t, p.summary)}${t(", ")}${rename}` : rename;
}

/** "手寫：加了 12 筆、擦掉 3 筆" / "白板筆跡：…" — what a change did to a drawing (shapes count as strokes). */
export function inkChangeText(t: ReturnType<typeof useT>, kind: InkKind, s: { added: number; erased: number }): string {
  const parts = [
    s.added > 0 && t("drew {n}", { n: s.added }),
    s.erased > 0 && t("erased {n}", { n: s.erased }),
  ].filter(Boolean) as string[];
  const text = kind === "board" ? "Whiteboard drawing: {parts}" : kind === "note" ? "Handwriting tab: {parts}" : "Handwriting: {parts}";
  return t(text, { parts: parts.join(t(", ")) });
}

/** The heading of a note's history section for one kind of drawing. */
export function inkKindHeading(t: ReturnType<typeof useT>, kind: InkKind): string {
  return t(kind === "board" ? "Whiteboard drawing changes" : kind === "note" ? "Handwriting tab changes" : "Handwriting changes");
}
