// The words `{word}` that make a checkbox line a task (and a paragraph a review card) are decided by the server
// (backend services/lineWords.ts) and arrive on `workspace.line_words` with the bootstrap and every sync delta.
// The editor reads them here; nothing in the app works them out from tags.

import type { LineWords } from "@onden/contract";

export const NO_WORDS: readonly string[] = Object.freeze([]);

/** The words that make a line count right now: none while the module is off, as on the server. */
export function activeWords(words: LineWords | null): readonly string[] {
  return words?.on ? words.words : NO_WORDS;
}

/** Whether `tag` (as written in a `{…}`) is one of `words`. */
export function isLineWord(tag: string, words: readonly string[]): boolean {
  const lower = tag.toLowerCase();
  return words.some((word) => word === lower);
}
