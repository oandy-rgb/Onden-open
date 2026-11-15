import { EditorView, keymap, type Panel } from "@codemirror/view";
import { Prec, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";
import {
  SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery,
  openSearchPanel, search, searchPanelOpen, setSearchQuery,
} from "@codemirror/search";
import { t } from "./i18n";
import { isImeComposing } from "./keys";
import { lastFindQuery, rememberFindText } from "./findInNote";
import { revealFolded } from "./editorFold";

// 「在本篇找字」: Ctrl/Cmd+F inside the note editor (edit or read-only view).
// The match engine, highlighting and next/previous are @codemirror/search's;
// only the panel is ours so it speaks the app's wording and tokens
// (editorFind.css). Matching is literal and case-insensitive, so Chinese and
// English both work with no tokenizer.

/** Counting stops here so a one-letter search in a huge note stays cheap. */
export const FIND_COUNT_CAP = 2000;

export type FindTally = { total: number; current: number; capped: boolean };

/** How many matches `needle` has in the document and which one the selection
 *  is on (1-based; 0 = the selection is not on a match). */
export function tallyMatches(state: EditorState, needle: string): FindTally {
  if (!needle) return { total: 0, current: 0, capped: false };
  const cursor = new SearchQuery({ search: needle }).getCursor(state);
  const { from, to } = state.selection.main;
  let total = 0;
  let current = 0;
  for (let step = cursor.next(); !step.done; step = cursor.next()) {
    total++;
    if (step.value.from === from && step.value.to === to) current = total;
    if (total >= FIND_COUNT_CAP) return { total, current, capped: true };
  }
  return { total, current, capped: false };
}

export function findStatusText(tally: FindTally, hasQuery: boolean): string {
  if (!hasQuery) return "";
  if (tally.total === 0) return t("No results");
  const total = tally.capped ? `${tally.total}+` : String(tally.total);
  return tally.current > 0
    ? t("Match {current} of {total}", { current: tally.current, total })
    : t("{total} matches", { total });
}

// ── Brief highlight after opening a note from search ────────────────────────

const setFlash = StateEffect.define<{ from: number; to: number } | null>();
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setFlash)) {
        return e.value ? Decoration.set([Decoration.mark({ class: "cm-findFlash" }).range(e.value.from, e.value.to)]) : Decoration.none;
      }
    }
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** The first place the words appear: the whole phrase, else its longest word
 *  (the search box also finds notes by separate words). */
export function firstMatchFor(state: EditorState, words: string): { from: number; to: number } | null {
  const candidates = [words.trim(), ...words.split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const step = new SearchQuery({ search: candidate }).getCursor(state).next();
    if (!step.done) return { from: step.value.from, to: step.value.to };
  }
  return null;
}

const FLASH_MS = 1800;
const flashTimers = new WeakMap<EditorView, number>();

/** Scroll to the first match of `words` and mark it for a moment. Leaves the
 *  caret and focus alone. Returns whether anything matched. */
export function revealFirstMatch(view: EditorView, words: string): boolean {
  const hit = firstMatchFor(view.state, words);
  if (!hit) return false;
  revealRange(view, hit);
  return true;
}

/** Scroll `range` into the middle and mark it for a moment (the same flash as a
 *  search hit). Leaves the caret and focus alone. */
export function revealRange(view: EditorView, range: { from: number; to: number }): void {
  const hit = { from: Math.min(range.from, range.to), to: Math.max(range.from, range.to) };
  revealFolded(view, hit.from);
  view.dispatch({ effects: [EditorView.scrollIntoView(hit.from, { y: "center" }), setFlash.of(hit)] });
  const previous = flashTimers.get(view);
  if (previous) window.clearTimeout(previous);
  flashTimers.set(view, window.setTimeout(() => {
    flashTimers.delete(view);
    if (view.dom.isConnected) view.dispatch({ effects: setFlash.of(null) });
  }, FLASH_MS));
}

// ── The panel ───────────────────────────────────────────────────────────────

function createFindPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "note-find";
  dom.setAttribute("role", "search");
  dom.setAttribute("aria-label", t("Find in this note"));

  const input = document.createElement("input");
  input.type = "search";
  input.className = "note-find-input";
  input.setAttribute("main-field", "true"); // @codemirror/search focuses this one
  input.placeholder = t("Find in this note");
  input.setAttribute("aria-label", t("Find in this note"));
  input.autocomplete = "off";
  input.spellcheck = false;
  input.enterKeyHint = "search";

  const status = document.createElement("span");
  status.className = "note-find-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const button = (label: string, glyph: string, onClick: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "note-find-btn tap-target";
    b.title = label;
    b.setAttribute("aria-label", label);
    b.textContent = glyph;
    // Keep the input focused so Enter keeps stepping after a tap.
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", onClick);
    return b;
  };
  const prev = button(t("Previous match"), "↑", () => { findPrevious(view); });
  const next = button(t("Next match"), "↓", () => { findNext(view); });
  const close = button(t("Close find"), "✕", () => closeFind(view));

  const applyQuery = () => {
    rememberFindText(input.value);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: input.value })) });
    // Land on the first match at or after the caret as the person types.
    if (input.value) findNext(view);
  };
  input.addEventListener("input", applyQuery);
  input.addEventListener("keydown", (e) => {
    if (isImeComposing(e)) return;
    if (e.key === "Enter") { e.preventDefault(); (e.shiftKey ? findPrevious : findNext)(view); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFind(view); }
  });

  dom.append(input, status, prev, next, close);

  const refresh = () => {
    const needle = getSearchQuery(view.state).search;
    if (input.value !== needle && document.activeElement !== input) input.value = needle;
    const tally = tallyMatches(view.state, needle);
    status.textContent = findStatusText(tally, needle.length > 0);
    prev.disabled = next.disabled = tally.total === 0;
  };

  return {
    dom,
    top: true,
    mount() { input.value = getSearchQuery(view.state).search; input.select(); refresh(); },
    update() { refresh(); },
  };
}

/** Close the panel and put the caret on the current match, so typing resumes
 *  there. */
export function closeFind(view: EditorView): void {
  closeSearchPanel(view);
  view.focus();
}

/** Open the panel pre-filled with `initial` (else the last searched words, else
 *  what is selected). Returns true so it can be a keymap command. */
export function openFind(view: EditorView, initial?: string): boolean {
  const { from, to } = view.state.selection.main;
  const selected = from !== to && to - from <= 200 ? view.state.sliceDoc(from, to) : "";
  const text = (initial ?? selected) || getSearchQuery(view.state).search || lastFindQuery();
  if (text !== getSearchQuery(view.state).search) {
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: text })) });
  }
  if (searchPanelOpen(view.state)) {
    view.dom.querySelector<HTMLInputElement>(".note-find-input")?.select();
    view.dom.querySelector<HTMLInputElement>(".note-find-input")?.focus();
  } else {
    openSearchPanel(view);
  }
  return true;
}

export const editorFind: Extension = [
  search({ top: true, createPanel: createFindPanel }),
  flashField,
  Prec.high(keymap.of([{ key: "Mod-f", run: (view) => openFind(view), preventDefault: true }])),
];
