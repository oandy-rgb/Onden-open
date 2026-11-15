// What a note needs beyond the core pipeline, read from its source before it
// renders: KaTeX for math, and which code grammars. The app loads exactly
// that (lazy.ts) instead of shipping KaTeX and every grammar up front.
//
// Generous on purpose: a `$` loads KaTeX even when it is a price, since
// loading too much only costs bytes. What this misses (an indented code
// block, a <pre> written as HTML) the highlighter reports while it renders
// (HighlightScope.onMissing) and the app loads it then.

import { isQueryBlockLang } from "./queryBlocks.js";
import { fenceInfoWord, fenceScanner, openingFenceInfo } from "./fences.js";
import { grammarFor, hasAllGrammars, withEmbedded, type GrammarName } from "./highlight.js";

export type MarkdownNeeds = {
  math: boolean;
  /** Grammars for the tagged code blocks, with the ones they embed. */
  grammars: GrammarName[];
  /** An untagged code block: guessing its language needs the common grammars. */
  detect: boolean;
  /** Fence languages the start-up table can't place: they may name a grammar
   *  in the part of the table that loads on demand (lazy.ts resolves them).
   *  Absent when there are none. */
  unresolved?: string[];
};

export function markdownNeeds(markdown: string, { math = true }: { math?: boolean } = {}): MarkdownNeeds {
  const grammars = new Set<GrammarName>();
  const unresolved = new Set<string>();
  let detect = false;
  if (markdown.includes("```") || markdown.includes("~~~")) {
    // A fence may sit in a quote or list item; its language is the info's first word.
    const fence = fenceScanner({ container: true });
    for (const line of markdown.split("\n")) {
      if (fence(line) !== "open") continue;
      const lang = fenceInfoWord(openingFenceInfo(line, { container: true }) ?? "");
      if (lang === "") detect = true;
      else {
        const grammar = grammarFor(lang);
        if (grammar) grammars.add(grammar);
        else if (!hasAllGrammars() && !isQueryBlockLang(lang)) unresolved.add(lang.toLowerCase());
      }
    }
  }
  return { math: math && markdown.includes("$"), grammars: withEmbedded(grammars), detect, ...(unresolved.size ? { unresolved: [...unresolved].sort() } : {}) };
}
