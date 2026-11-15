// The note as it would read with every pending AI suggestion applied, and where each suggestion
// lands in that text, for the "Compare" view (components/AiSuggestionCompare.tsx). The places are
// the suggestions' own (lib/aiSuggestions.ts layout), not a second diff of the two texts, so one
// place on screen is one thing to decide. A comment changes no text and is not in here.
// This is the preview; what a person accepts is written by the server (routes/aiSuggestions.ts).
// It follows the server's cut: a replace takes the paragraph's place, a delete takes it out with
// the blank line after it, an insert goes after its paragraph with the same blank line.

import { splitParagraphs } from "@onden/markdown";
import type { Decision, Place } from "./aiSuggestions";

type CompareRange = { from: number; to: number };
/** A place as TextCompare takes it (components/compare CompareChange). */
type CompareChange = { before: CompareRange; after: CompareRange };

export type SuggestionCompare = {
  /** The note with the suggestions made. */
  after: string;
  /** One entry per place, in document order; `owners` are the suggestions behind it (more than one only when two touch the same paragraph). */
  places: ReadonlyArray<CompareChange & { owners: readonly Place[] }>;
  /** Places that only change the spacing around a paragraph: no text differs, so they are listed, not drawn as two equal blocks. */
  spacingOnly: readonly Place[];
};

type Edit = { from: number; to: number; insert: string; owner: Place };

export function suggestionCompare(markdown: string, suggested: readonly Place[]): SuggestionCompare {
  const paragraphs = splitParagraphs(markdown);
  const gapAfter = (i: number) => (i < paragraphs.length - 1
    ? markdown.slice(paragraphs[i]!.end, paragraphs[i + 1]!.start)
    : paragraphs[i]!.kind === "listItem" ? "\n" : "\n\n");
  const indexEndingAt = (end: number) => paragraphs.findIndex((p) => p.end === end);
  const insertEnds = new Set(suggested.filter((p) => p.kind === "insert").map((p) => p.to));

  const edits: Edit[] = [];
  const spacingOnly = suggested.filter((place) => place.spacingOnly);
  for (const place of suggested) {
    if (place.kind === "comment" || place.spacingOnly) continue;
    if (place.kind === "replace") { edits.push({ from: place.from, to: place.to, insert: place.newText ?? "", owner: place }); continue; }
    if (place.kind === "delete") {
      const i = indexEndingAt(place.to);
      // The blank line after goes with it, unless an insert after this paragraph needs it.
      const to = i >= 0 && i < paragraphs.length - 1 && !insertEnds.has(place.to) ? paragraphs[i + 1]!.start : place.to;
      edits.push({ from: place.from, to, insert: "", owner: place });
      continue;
    }
    const atStart = place.at === 0 && place.from === 0 && place.to === 0;
    const i = atStart ? 0 : indexEndingAt(place.to);
    const gap = paragraphs.length === 0 ? "\n" : gapAfter(i < 0 ? 0 : i);
    edits.push(atStart
      ? { from: 0, to: 0, insert: `${place.newText ?? ""}${paragraphs.length === 0 ? "" : gap}`, owner: place }
      : { from: place.to, to: place.to, insert: `${gap}${place.newText ?? ""}`, owner: place });
  }
  edits.sort((a, b) => a.from - b.from || a.to - b.to);

  let after = "";
  let cursor = 0;
  let delta = 0;
  const places: Array<CompareChange & { owners: Place[] }> = [];
  for (const edit of edits) {
    const last = places[places.length - 1];
    if (last && edit.from < last.before.to) {
      // Two suggestions on one paragraph: one place, decided together; the first one's text stands.
      last.owners.push(edit.owner);
      continue;
    }
    after += markdown.slice(cursor, edit.from) + edit.insert;
    const at: CompareRange = { from: edit.from + delta, to: edit.from + delta + edit.insert.length };
    places.push({ before: { from: edit.from, to: edit.to }, after: at, owners: [edit.owner] });
    delta += edit.insert.length - (edit.to - edit.from);
    cursor = edit.to;
  }
  after += markdown.slice(cursor);
  return { after, places, spacingOnly };
}

/** Decide the given places (what one spot of the compare view stands for): one request per suggestion, in turn;
 *  the first refusal stops the rest. `decide` is useAiSuggestions'; nothing here says "accepted". */
export async function decidePlaces(
  places: readonly Place[], decision: Decision,
  decide: (suggestionId: string, itemIds: string[], decision: Decision) => Promise<boolean>,
): Promise<void> {
  const bySuggestion = new Map<string, string[]>();
  for (const place of places) bySuggestion.set(place.suggestionId, [...(bySuggestion.get(place.suggestionId) ?? []), place.itemId]);
  for (const [suggestionId, itemIds] of bySuggestion) if (!(await decide(suggestionId, itemIds, decision))) return;
}
