// The editor's side of 「被引用 N 次」 (lib/blockCitations):
//   - a small number at the right edge of a paragraph other notes cite; a tap
//     asks the host to list them (`onOpen`, a Popover);
//   - deleting such a paragraph says so in the undo toast ("這段有 N 處引用 ·
//     復原") — no confirmation box; the editor's undo brings it back.
// The numbers arrive after the note opens (the host dispatches `setCitations`),
// so typing and opening never wait for them.

import { StateEffect, StateField, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { addToast } from "../appStore";
import { t, tn } from "../i18n";
import { carriedInUpdate, editorAnchorsField, editorAnchorsOf } from "../editorAnchors";
import { citationCount, groupCitations, NO_CITATIONS, type BlockCitationRow, type BlockCitations } from "./citations";

export const setCitations = StateEffect.define<readonly BlockCitationRow[]>();

const citationsField = StateField.define<BlockCitations>({
  create: () => NO_CITATIONS,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setCitations)) return e.value.length ? groupCitations(e.value) : NO_CITATIONS;
    return value;
  },
});

/** Where the host hears a tap on a number: the paragraph's anchor id and the number's element. */
export const citationOpener = StateField.define<((blockId: string, anchor: HTMLElement) => void) | null>({
  create: () => null,
  update: (value) => value,
});

class Badge extends WidgetType {
  constructor(readonly blockId: string, readonly count: number) { super(); }
  eq(other: Badge) { return other.blockId === this.blockId && other.count === this.count; }
  toDOM(view: EditorView) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "cm-block-cited";
    el.textContent = String(this.count);
    el.setAttribute("aria-label", t("Cited {n} times", { n: this.count }));
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      view.state.field(citationOpener)?.(this.blockId, el);
    });
    return el;
  }
  ignoreEvent() { return true; }
}

function build(state: EditorView["state"]): DecorationSet {
  const cited = state.field(citationsField);
  if (cited.size === 0) return Decoration.none;
  const doc = state.doc;
  const ranges: Range<Decoration>[] = [];
  const seen = new Set<string>();
  for (const anchor of editorAnchorsOf(state)) {
    const rows = cited.get(anchor.id);
    if (!rows || seen.has(anchor.id) || anchor.from > doc.length) continue;
    seen.add(anchor.id);
    const line = doc.lineAt(anchor.from);
    ranges.push(Decoration.line({ class: "cm-block-cited-line" }).range(line.from));
    ranges.push(Decoration.widget({ widget: new Badge(anchor.id, citationCount(rows)), side: 1 }).range(line.to));
  }
  return Decoration.set(ranges, true);
}

const badges = StateField.define<DecorationSet>({
  create: build,
  update(deco, tr) {
    // The anchors move with the text, and the server's answer replaces them (lib/editorAnchors).
    if (tr.docChanged || tr.effects.some((e) => e.is(setCitations)) || tr.state.field(editorAnchorsField) !== tr.startState.field(editorAnchorsField)) return build(tr.state);
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** How many places cite the paragraphs this update deleted for good (not undone, not moved elsewhere in the note by a
 *  cut and paste): the count, per paragraph. A paragraph is deleted when all of its text is gone. */
export function removedCitedCounts(update: ViewUpdate): number[] {
  const cited = update.startState.field(citationsField);
  if (cited.size === 0 || !update.docChanged) return [];
  if (update.transactions.some((tr) => tr.isUserEvent("undo") || tr.isUserEvent("redo"))) return [];
  const carried = new Set(carriedInUpdate(update).map((a) => a.id));
  const gone: number[] = [];
  for (const anchor of editorAnchorsOf(update.startState)) {
    const rows = cited.get(anchor.id);
    if (!rows || carried.has(anchor.id)) continue;
    if (update.changes.mapPos(anchor.to, 1) <= update.changes.mapPos(anchor.from, -1)) gone.push(citationCount(rows));
  }
  return gone;
}

/** The undo toast after a paragraph others point to was deleted. No confirmation box: the editor's undo brings it back. */
function warnDeleted(view: EditorView, doc: EditorView["state"]["doc"], message: string): void {
  addToast(message, "info", {
    label: t("Undo"),
    onClick: () => {
      // Only while nothing was typed since; otherwise undo would take back something else.
      if (!view.dom.isConnected || !view.state.doc.eq(doc)) {
        addToast(t("The note was edited since, so use the editor's undo"), "info");
        return;
      }
      undo(view);
      view.focus();
    },
  });
}

const warnOnDelete = ViewPlugin.fromClass(class {
  constructor(readonly view: EditorView) {}
  update(update: ViewUpdate) {
    const counts = removedCitedCounts(update);
    if (counts.length === 0) return;
    const n = counts.reduce((a, b) => a + b, 0);
    warnDeleted(this.view, update.state.doc, tn("This paragraph has 1 citation", "This paragraph has {n} citations", n));
  }
});

/** A paragraph that part links `[[筆記/段落]]` point to: where the server says it is, the words it had there, and how many links. */
export type LinkedParagraph = { from: number; to: number; quote: string; links: number };

/** Deleting a paragraph that part links point to says so in the same undo toast as a cited one (「有 N 處連到這段 · 復原」).
 *  Positions are the server's; a paragraph whose words are not where the server said (the note changed since) is not judged. */
export function editorLinkedParagraphs(linked: () => readonly LinkedParagraph[]) {
  return ViewPlugin.fromClass(class {
    constructor(readonly view: EditorView) {}
    update(update: ViewUpdate) {
      if (!update.docChanged || update.transactions.some((tr) => tr.isUserEvent("undo") || tr.isUserEvent("redo"))) return;
      const before = update.startState.doc;
      let n = 0;
      for (const p of linked()) {
        if (p.links < 1 || p.to > before.length || p.from >= p.to) continue;
        const here = before.sliceString(p.from, Math.min(p.to, p.from + p.quote.length));
        if (!p.quote || here !== p.quote.slice(0, here.length)) continue;
        if (update.changes.mapPos(p.to, -1) <= update.changes.mapPos(p.from, 1)) n += p.links;
      }
      if (n > 0) warnDeleted(this.view, update.state.doc, tn("{n} link points to this paragraph", "{n} links point to this paragraph", n));
    }
  });
}

const citationTheme = EditorView.baseTheme({
  ".cm-block-cited-line": { position: "relative" },
  ".cm-block-cited": {
    position: "absolute", right: "-4px", top: "0.15em", minWidth: "1.5em", height: "1.5em", padding: "0 4px",
    border: "1px solid var(--ac-line)", borderRadius: "999px", background: "var(--ac-surface)", color: "var(--ac-muted)",
    fontSize: "0.75em", lineHeight: "1.4", cursor: "pointer",
  },
  // The tap target is wider than the number (44px), without making the line taller.
  ".cm-block-cited::after": { content: '""', position: "absolute", inset: "-12px -8px" },
  ".cm-block-cited:hover, .cm-block-cited:focus-visible": { color: "var(--ac-accent)", borderColor: "var(--ac-accent)" },
});

/** Put into the editor's extensions. `onOpen` is the host's list of the citing notes. */
export function editorCitations(onOpen: (blockId: string, anchor: HTMLElement) => void) {
  return [citationsField, citationOpener.init(() => onOpen), badges, warnOnDelete, citationTheme];
}
