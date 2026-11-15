import type { ElementContent } from "hast";
import { grammarFor, hasAllGrammars, withEmbedded } from "./highlight.js";
import { enhancersFor, loadEnhancers } from "./lazy.js";
import type { MarkdownNeeds } from "./needs.js";

// Kept out of lazy.ts so the app's start-up bundle doesn't carry it: only the editor's
// code colouring (frontend lib/editorCodeHighlight) imports it.

/** Colours code for the editor, which draws the fence itself and only needs the
 *  tokens: the one grammar `lang` names, from the same loader and the same
 *  lowlight as the preview. undefined while that grammar is still loading
 *  (`onLoaded` then fires once) or when `lang` has none (mermaid: stays plain). */
export function codeHighlighter(lang: string, onLoaded: () => void): ((text: string) => ElementContent[]) | undefined {
  const grammar = grammarFor(lang);
  if (!grammar && hasAllGrammars()) return undefined;
  // A name the start-up table doesn't know may be in the rest of it: loading resolves it.
  const needs: MarkdownNeeds = grammar
    ? { math: false, grammars: withEmbedded([grammar]), detect: false }
    : { math: false, grammars: [], detect: false, unresolved: [lang.toLowerCase()] };
  const { enhancers, ready } = enhancersFor(needs);
  const ll = enhancers.highlight?.lowlight;
  if (grammar && ready && ll) return (text) => ll.highlight(grammar, text, { prefix: "hljs-" }).children as ElementContent[];
  void loadEnhancers(needs).then(onLoaded);
  return undefined;
}
