import { splitParagraphs } from "@onden/markdown";
import { wordStats, type WordStats } from "./wordStats";

/** What the note's ⋯ menu says about the note's text: its length (wordStats) and how many paragraphs
 *  it has. Headings and front matter are not paragraphs. Its tasks are the store's (NoteStatsBlock). */
export type NoteMenuStats = WordStats & { paragraphs: number };

export function noteMenuStats(markdown: string): NoteMenuStats {
  return {
    ...wordStats(markdown),
    paragraphs: splitParagraphs(markdown).filter((p) => p.kind !== "heading" && p.kind !== "frontmatter").length,
  };
}
