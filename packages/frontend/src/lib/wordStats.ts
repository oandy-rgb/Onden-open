import { countWords, readingMinutes } from "@onden/markdown";

// The editor's word-count readout. Both numbers are @onden/markdown's rules
// (`countWords`, `readingMinutes`), the ones the published pages use.

export type WordStats = {
  words: number;
  /** Reading time in minutes (≥1 for any text), 0 for an empty page. */
  minutes: number;
};

export function wordStats(markdown: string): WordStats {
  const words = countWords(markdown);
  return { words, minutes: words === 0 ? 0 : readingMinutes(markdown) };
}
