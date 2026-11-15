// Code highlighting for the one pipeline: rehype-highlight's behaviour (same
// classes, same lowlight output, auto-detect for untagged blocks) with the
// grammars handed in, so the app can load only the ones a note uses
// (lazy.ts) while the server exports register all of them (full.ts).
//
// Every grammar highlight.js has (generated: highlightGrammars.generated.ts).
// A tagged block may use any of them; an untagged block is guessed from the
// `common` set only (COMMON_GRAMMAR_NAMES) — guessing among all ~190 is slow
// and guesses wrong more often. highlight.test.ts compares with lowlight.

import type { Element, ElementContent, Root } from "hast";
import type { createLowlight } from "lowlight";
import type { toText } from "hast-util-to-text";
import { visit } from "unist-util-visit";
import { BOOT_ALIASES, BOOT_GRAMMARS, COMMON_GRAMMAR_NAMES, type GrammarName } from "./highlightGrammars.generated.js";
import type { MORE_ALIASES, MORE_GRAMMARS } from "./grammarTableMore.generated.js";

export { COMMON_GRAMMAR_NAMES, type GrammarName };

// The table starts as the start-up part (common grammars and what they embed)
// and is completed by registerMoreGrammars once grammarTableMore has loaded
// (lazy.ts on the first fence naming another grammar; full.ts at once).
const deps = new Map<string, readonly string[]>(Object.entries(BOOT_GRAMMARS));
const byName = new Map<string, GrammarName>();
let complete = false;

function index(grammars: Readonly<Record<string, readonly string[]>>, aliases: Readonly<Record<string, readonly string[]>>) {
  for (const [name, embedded] of Object.entries(grammars)) {
    deps.set(name, embedded);
    byName.set(name, name as GrammarName);
  }
  for (const [name, list] of Object.entries(aliases)) for (const alias of list) byName.set(alias, name as GrammarName);
}
index(BOOT_GRAMMARS, BOOT_ALIASES);

/** Adds the grammars outside the start-up table. Idempotent. */
export function registerMoreGrammars(more: { MORE_GRAMMARS: typeof MORE_GRAMMARS; MORE_ALIASES: typeof MORE_ALIASES }): void {
  if (complete) return;
  complete = true;
  index(more.MORE_GRAMMARS, more.MORE_ALIASES);
}
/** Whether every grammar highlight.js has is in the table (else a name it lacks may just not have loaded yet). */
export const hasAllGrammars = () => complete;
/** Every grammar in the table now. */
export const grammarNames = () => [...deps.keys()] as GrammarName[];

/** The grammar a fence's language names (`js` → javascript), case-insensitive
 *  like highlight.js; undefined for one it has no grammar for (mermaid), or
 *  one in the part of the table that has not loaded (hasAllGrammars). */
export function grammarFor(lang: string): GrammarName | undefined {
  return byName.get(lang.toLowerCase());
}

/** The grammars plus every grammar they embed, sorted. */
export function withEmbedded(names: Iterable<GrammarName>): GrammarName[] {
  const out = new Set<GrammarName>();
  const add = (name: GrammarName) => {
    if (out.has(name)) return;
    out.add(name);
    for (const dep of deps.get(name) ?? []) add(dep as GrammarName);
  };
  for (const name of names) add(name);
  return [...out].sort();
}

export type Lowlight = ReturnType<typeof createLowlight> & { textOf: (node: Parameters<typeof toText>[0]) => string };

export type HighlightScope = {
  /** Holds at least `grammars`; absent while nothing has loaded. */
  lowlight?: Lowlight;
  /** The grammars this render may use. Only these, even when the lowlight
   *  instance holds more: the output then depends on the note alone, so a
   *  server render and the browser's hydration agree. */
  grammars: ReadonlySet<string>;
  /** Guess the language of an untagged block (needs the `common` grammars). */
  detect: boolean;
  /** Called for a block this scope could not colour: its grammar, or
   *  "detect" for an untagged block. */
  onMissing?: (need: GrammarName | "detect") => void;
};

const PREFIX = "hljs-";

/** rehype-highlight with `detect` and the grammars of `scope`. */
export function rehypeHighlightCode(scope: HighlightScope) {
  return (tree: Root) => {
    visit(tree, "element", (node: Element, _index, parent) => {
      if (node.tagName !== "code" || !parent || parent.type !== "element" || parent.tagName !== "pre") return;
      const lang = language(node);
      if (lang === false) return;
      const grammar = lang ? grammarFor(lang) : undefined;
      const usable = lang ? !!grammar && scope.grammars.has(grammar) : scope.detect;
      if (!usable) {
        if (lang ? grammar : true) scope.onMissing?.(grammar ?? "detect");
        // An untagged block stays as it is until it can be guessed.
        if (!lang) return;
      }
      if (!Array.isArray(node.properties.className)) node.properties.className = [];
      if (!node.properties.className.includes("hljs")) node.properties.className.unshift("hljs");
      if (!usable || !scope.lowlight) return;
      const text = scope.lowlight.textOf(node);
      const result = grammar
        ? scope.lowlight.highlight(grammar, text, { prefix: PREFIX })
        : scope.lowlight.highlightAuto(text, { prefix: PREFIX, subset: [...COMMON_GRAMMAR_NAMES] });
      if (!grammar && result.data?.language) node.properties.className.push("language-" + result.data.language);
      if (result.children.length > 0) node.children = result.children as ElementContent[];
    });
  };
}

/** The block's language class (`language-x` or `lang-x`); false for an
 *  explicit `no-highlight`. */
function language(node: Element): string | false | undefined {
  const list = node.properties.className;
  if (!Array.isArray(list)) return undefined;
  let name: string | undefined;
  for (const item of list) {
    const value = String(item);
    if (value === "no-highlight" || value === "nohighlight") return false;
    if (!name && value.startsWith("lang-")) name = value.slice(5);
    if (!name && value.startsWith("language-")) name = value.slice(9);
  }
  return name;
}
