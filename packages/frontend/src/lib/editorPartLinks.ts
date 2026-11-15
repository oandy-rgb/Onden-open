import { syntaxTree } from "@codemirror/language";
import { type Extension, type Range, StateEffect } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { cutToGraphemes, blockLinkShown, scanWikilinks, splitBlockLink, splitWikilink, type BlockLinkRead } from "@onden/markdown";
import { watchAnchors } from "./blockAnchorStore";
import { legacyBlockWords, partLinkSlash, readPartLink, type PartLinkContext } from "./blockLinks";
import { t } from "./i18n";
import { loadPartLinks } from "./partLinkModule";
import { refreshEmbeds } from "./editorEmbeds";

// `[[筆記/段落開頭]]` in the editor: what stands after the `/` is the paragraph's words as they are NOW, read from the
// anchors and the notes (the same reading as every other place a part link is drawn: lib/blockLinks), not the words the
// link was written with. The written words stay in the text — in the undo history, the file, an export — and are shown
// again only by editing the link's name part; the arrow keys step over the shown words and a Backspace takes them whole.
// The stored words are refreshed only when the person edits this note (docs/architecture/proposals/block-anchors §7.2).
//
// A paragraph that was deleted shows its old words struck through; one that is not found, or that the reader may not
// see, is left as the plain text it is.

/** Redraw the shown words: the notes they were read from changed. */
export const refreshPartLinks = StateEffect.define<null>();

class PartWords extends WidgetType {
  constructor(readonly text: string, readonly lead: boolean, readonly struck: boolean) { super(); }
  eq(other: PartWords) { return other.text === this.text && other.lead === this.lead && other.struck === this.struck; }
  toDOM() {
    const el = document.createElement("span");
    el.className = this.struck ? "cm-part-link cm-part-link--deleted" : "cm-part-link";
    if (this.lead) el.append(" › ");
    if (this.struck) {
      const s = document.createElement("s");
      s.textContent = this.text;
      el.append(s, ` ${t("Deleted paragraph")}`);
    } else el.append(this.text);
    return el;
  }
  ignoreEvent() { return false; }
}

/** What to draw over the words after the `/`, or null to leave them as typed. */
function shownFor(read: BlockLinkRead, self: string | null): { text: string; lead: boolean; struck: boolean } | null {
  if (read.kind === "erased") return read.quote ? { text: cutToGraphemes(read.quote, 40), lead: true, struck: true } : null;
  if (read.kind !== "part" && read.kind !== "maybe") return null;
  const words = blockLinkShown(read, self);
  if (words === null) return null;
  return { text: read.part.excerpt || words, lead: read.part.noteId !== self, struck: false };
}

export function editorPartLinks(context: () => PartLinkContext): Extension {
  const build = (view: EditorView): DecorationSet => {
    const { state } = view;
    const ctx = context();
    const self = ctx.from?.id ?? null;
    const ranges: Range<Decoration>[] = [];
    // The note's own text only when a `[[#^id]]` asks for it.
    let selfText: string | undefined;
    const reading = { ...ctx, get selfMarkdown() { return selfText ??= state.doc.toString(); } };
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to;) {
        const line = state.doc.lineAt(pos);
        pos = line.to + 1;
        if (!line.text.includes("[[") || !(line.text.includes("/") || line.text.includes("#^"))) continue;
        for (const m of scanWikilinks(line.text)) {
          const { target, alias } = splitWikilink(m.body);
          if (alias !== null) continue;
          // The old `[[Note#^id]]`: the `#^id` is never shown; in its place stand the start of the paragraph's words.
          const old = splitBlockLink(m.body);
          if (old) {
            const at = line.from + m.start + 2 + old.target.length;
            if (/Code/.test(syntaxTree(state).resolveInner(at, 1).name)) continue;
            const words = legacyBlockWords(m.body, reading);
            const tail = words !== null && old.target !== "" && words.startsWith(`${old.target} › `) ? words.slice(old.target.length + 3) : null;
            ranges.push(Decoration.replace(tail ? { widget: new PartWords(tail, true, false) } : {}).range(at, at + 2 + old.blockId.length));
            continue;
          }
          if (!target.includes("/")) continue;
          const slash = partLinkSlash(target, ctx);
          if (slash < 0) continue;
          const start = line.from + m.start + 2 + slash;
          const end = line.from + m.start + 2 + target.length;
          if (/Code/.test(syntaxTree(state).resolveInner(start, 1).name)) continue;
          const shown = shownFor(readPartLink(target, ctx), self);
          if (!shown) continue;
          // `[[/words]]` is written in the note itself: its words stand alone, without the arrow.
          ranges.push(Decoration.replace({ widget: new PartWords(shown.text, shown.lead && slash > 0, shown.struck) }).range(start, end));
        }
      }
    }
    return Decoration.set(ranges, true);
  };

  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    stop: () => void;
    constructor(readonly view: EditorView) {
      this.decorations = build(view);
      // An anchor or binding arrived: redraw (outside the update cycle).
      this.stop = watchAnchors(() => queueMicrotask(() => { view.dispatch({ effects: refreshPartLinks.of(null) }); }));
      // `![[筆記/段落]]` lines read through the same module (lib/embeds): once it is here they are drawn again.
      void loadPartLinks().then(() => { if (view.dom.isConnected) view.dispatch({ effects: refreshEmbeds.of(null) }); });
    }
    update(update: ViewUpdate) {
      // An IME composing: nothing is redrawn until it ends (the text moves under the candidate).
      if (update.view.composing && update.docChanged) { this.decorations = this.decorations.map(update.changes); return; }
      if (update.docChanged || update.viewportChanged || update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshPartLinks)))) {
        this.decorations = build(update.view);
      }
    }
    destroy() { this.stop(); }
  }, {
    decorations: (v) => v.decorations,
    provide: (p) => EditorView.atomicRanges.of((view) => view.plugin(p)?.decorations ?? Decoration.none),
  });

  const theme = EditorView.baseTheme({
    ".cm-part-link": { color: "var(--ac-accent-hover)" },
    ".cm-part-link--deleted": { color: "var(--ac-muted)" },
  });
  return [plugin, theme];
}
