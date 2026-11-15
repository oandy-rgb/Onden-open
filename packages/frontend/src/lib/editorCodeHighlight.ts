import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, type Range, Prec, StateEffect } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { codeHighlighter } from "@onden/markdown";
import type { ElementContent } from "hast";

// Colours the code inside ``` fences while writing, from the same grammars and
// the same classes as the preview (@onden/markdown codeHighlighter → highlight.js
// via lowlight; colours in styles/syntax-highlight.css). The text is never changed.
//
//   - only fences in or near the visible range are looked at;
//   - typing keeps the existing colours (mapped through the edit) and recolours
//     after a pause, and only a block whose language or text changed is
//     tokenized again — the rest come from a small cache;
//   - a block over MAX_CHARS / MAX_LINES, or an unknown language, stays plain;
//   - while a grammar is still loading the block stays plain, then is coloured;
//   - nothing is dispatched during an IME composition: recolouring waits for it.
//
// MarkdownEditor loads this file when the note first has a fence, so the
// highlighter costs nothing at start-up.

export const MAX_CHARS = 20_000;
export const MAX_LINES = 2000;
const DEBOUNCE_MS = 200;
const BUFFER_CHARS = 2000;
const CACHE_LIMIT = 60;

type Token = { from: number; to: number; className: string };
type Highlighter = typeof codeHighlighter;

const refresh = StateEffect.define<null>();

export type FencedBlock = { lang: string; from: number; text: string };

/** The fences touching [from, to] that can be coloured: a language word, a body
 *  without a container prefix (`> `, `- `), and not too large. */
export function fencedBlocks(state: EditorState, from: number, to: number): FencedBlock[] {
  const out: FencedBlock[] = [];
  const doc = state.doc;
  syntaxTree(state).iterate({
    from, to,
    enter: (node) => {
      if (node.name !== "FencedCode") return;
      const info = node.node.getChild("CodeInfo");
      const first = node.node.getChild("CodeText");
      if (!info || !first) return false;
      if (doc.sliceString(doc.lineAt(node.from).from, node.from).trim() !== "") return false;
      let last = first;
      for (let c = first.nextSibling; c; c = c.nextSibling) if (c.name === "CodeText") last = c;
      if (last.to - first.from > MAX_CHARS || doc.lineAt(last.to).number - doc.lineAt(first.from).number >= MAX_LINES) return false;
      const lang = doc.sliceString(info.from, info.to).trim().split(/\s+/)[0] ?? "";
      if (lang) out.push({ lang, from: first.from, text: doc.sliceString(first.from, last.to) });
      return false;
    },
  });
  return out;
}

/** Token ranges (relative to the block) of lowlight's output: one range per span, nested spans overlap. */
function tokens(nodes: ElementContent[]): Token[] {
  const out: Token[] = [];
  let pos = 0;
  const walk = (list: typeof nodes) => {
    for (const node of list) {
      if (node.type === "text") pos += node.value.length;
      else if (node.type === "element") {
        const from = pos;
        walk(node.children);
        const names = node.properties.className;
        if (pos > from && Array.isArray(names) && names.length) out.push({ from, to: pos, className: names.join(" ") });
      }
    }
  };
  walk(nodes);
  return out;
}

/** `highlighter` is a seam for tests; the editor uses the preview's loader. */
export function codeHighlight(highlighter: Highlighter = codeHighlighter): Extension {
  return Prec.lowest(ViewPlugin.fromClass(class {
    decorations: DecorationSet = Decoration.none;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private cache = new Map<string, Token[]>();
    private requested = new Set<string>();
    private destroyed = false;

    constructor(private view: EditorView) {
      this.decorations = this.build(view.state, view);
    }

    update(u: ViewUpdate) {
      if (u.docChanged) {
        this.decorations = this.decorations.map(u.changes);
        this.later(DEBOUNCE_MS);
      } else if (u.viewportChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(refresh)))) {
        this.decorations = this.build(u.state, u.view);
      }
    }

    destroy() {
      this.destroyed = true;
      clearTimeout(this.timer);
    }

    /** Ask for a recolour after `ms`; waits out an IME composition. */
    private later(ms: number) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        if (this.destroyed) return;
        if (this.view.composing) this.later(300);
        else this.view.dispatch({ effects: refresh.of(null) });
      }, ms);
    }

    private build(state: EditorState, view: EditorView): DecorationSet {
      const ranges: Range<Decoration>[] = [];
      const seen = new Set<string>();
      const spans = view.visibleRanges.length ? view.visibleRanges : [view.viewport];
      const blocks = new Map<number, FencedBlock>();
      for (const r of spans) {
        for (const b of fencedBlocks(state, Math.max(0, r.from - BUFFER_CHARS), Math.min(state.doc.length, r.to + BUFFER_CHARS))) blocks.set(b.from, b);
      }
      for (const b of blocks.values()) {
        const key = b.lang.toLowerCase() + "\0" + b.text;
        seen.add(key);
        let list = this.cache.get(key);
        if (!list) {
          // Ask to be told of a load once per language: a load that fails must not loop back here.
          const lang = b.lang.toLowerCase();
          const highlight = highlighter(b.lang, this.requested.has(lang) ? () => undefined : () => this.grammarLoaded());
          this.requested.add(lang);
          if (!highlight) continue;
          list = tokens(highlight(b.text));
          this.cache.set(key, list);
        }
        for (const t of list) ranges.push(Decoration.mark({ class: t.className }).range(b.from + t.from, b.from + t.to));
      }
      // Keep what is on screen, drop the rest once the cache grows.
      if (this.cache.size > CACHE_LIMIT) for (const k of this.cache.keys()) if (!seen.has(k)) this.cache.delete(k);
      return Decoration.set(ranges, true);
    }

    private grammarLoaded() {
      if (!this.destroyed) this.later(0);
    }
  }, { decorations: (v) => v.decorations }));
}
