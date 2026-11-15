import { type EditorState, type Extension, Prec, type Range, StateEffect, StateField, type Transaction } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { composingField, trackComposing } from "./editorComposing";
import { editorFocused, type EmbedContext } from "./editorEmbeds";
import { mountNoteText } from "./embedDom";
import { t } from "./i18n";
import "../styles/previewTable.css"; // the preview's table rules, which the drawn table borrows

// GFM pipe tables in the editor: a table the caret is not in is drawn as a
// table (lib/embedDom mountNoteText — the preview's own renderer), and its
// text is never changed. Showing the text again is always deliberate, never a
// side effect of where the caret passes:
//
//   - the arrow keys go over a drawn table (it is one unit to the caret), so
//     moving through a note does not open it;
//   - the 「編輯」 button in its corner, a double click, or a click on it opens
//     the text, with the caret in the cell that was pressed (cellOffset);
//   - a selection strictly inside the table (find, undo) opens it too, and so
//     does typing or deleting with the caret on its edge (a table being
//     written, an IME's text arriving), so what is typed is never hidden;
//   - Backspace right after a drawn table (Delete right before it) shows its
//     text first instead of removing the whole table as one unit;
//   - once the caret leaves the table's text it is drawn again.
//
// The table is much taller as text than drawn (or the reverse), so a switch
// keeps the pressed spot where it was on screen (keepOnScreen) instead of
// letting the page jump. While an IME is composing nothing opens, closes or
// is redrawn (lib/editorComposing). Only a table at the top level of the note
// is drawn; one inside a list or quote stays text.

export type TableRange = { from: number; to: number };

/** The top-level tables of the note. Pure over the state (tests read it). */
export function tableRanges(state: EditorState): TableRange[] {
  const out: TableRange[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === "Table") {
        if (node.node.parent?.name === "Document" && state.doc.lineAt(node.from).from === node.from) out.push({ from: node.from, to: node.to });
        return false;
      }
      return node.name === "Document";
    },
  });
  return out;
}

/** Where the cell numbered `col` (0-based) starts in a table row's text: after its pipe and the spaces that follow, at the row's end if the row has fewer cells. */
export function cellOffset(row: string, col: number): number {
  const pipes: number[] = [];
  for (let i = 0; i < row.length; i++) {
    if (row[i] === "\\") i++;
    else if (row[i] === "|") pipes.push(i);
  }
  // `| a | b |`: the cells begin after pipe 0, 1…; `a | b`: cell 0 begins at 0.
  const leading = row.slice(0, pipes[0] ?? 0).trim() === "" && pipes.length > 0;
  const start = leading ? (pipes[col] ?? row.length) + 1 : col === 0 ? 0 : (pipes[col - 1] ?? row.length) + 1;
  let at = Math.min(start, row.length);
  while (at < row.length && row[at] === " ") at++;
  return at;
}

/** The open table (the start of its text) and where on screen the press that opened it was. */
const openTable = StateEffect.define<{ from: number; pressY?: number }>();

type TableState = { open: number | null; deco: DecorationSet };

const insideStrictly = (state: EditorState, t: TableRange) => state.selection.ranges.some((r) => r.from > t.from && r.to < t.to);
const touches = (state: EditorState, t: TableRange) => state.selection.ranges.some((r) => r.to >= t.from && r.from <= t.to);

function openAfter(tr: Transaction, prev: TableState, tables: TableRange[]): number | null {
  const map = (n: number) => tr.changes.mapPos(n, 1);
  let open = prev.open === null ? null : map(prev.open);
  for (const e of tr.effects) if (e.is(openTable)) open = e.value.from;
  if (open === null && editorFocused(tr.state)) open = tables.find((t) => insideStrictly(tr.state, t))?.from ?? null;
  // Typing or deleting with the caret on a table (the end of one being written, an IME's composed text arriving)
  // shows its text, so what is typed is never hidden inside a drawn table.
  const edited = tr.docChanged || tr.startState.field(composingField, false) === true;
  if (open === null && edited && editorFocused(tr.state)) open = tables.find((t) => touches(tr.state, t))?.from ?? null;
  const table = tables.find((t) => t.from === open);
  // The text stays up while the caret is on it; the caret leaving draws the table again.
  return table && touches(tr.state, table) ? table.from : null;
}

/** Each drawn table's way to end its preview: found by its element, so a reused widget still ends the right one. */
const unmounts = new WeakMap<HTMLElement, () => void>();

class TableWidget extends WidgetType {
  constructor(readonly source: string, readonly context: () => EmbedContext) { super(); }
  eq(other: TableWidget) { return other.source === this.source; }
  get estimatedHeight() { return 40 + 30 * this.source.split("\n").length; }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "cm-table";
    // Until the table is drawn it holds about its height, so the page below does not jump up and back.
    el.style.minHeight = `${Math.max(1, this.source.split("\n").length - 1) * 33}px`;
    const body = document.createElement("div");
    body.className = "cm-table-body obsidian-preview--md"; // the preview's table rules
    const edit = document.createElement("span");
    edit.className = "cm-table-edit";
    edit.setAttribute("role", "button");
    edit.tabIndex = 0;
    edit.textContent = t("Edit table");
    const { nodes, from, onOpen } = this.context();
    const text = mountNoteText(body, { nodes, from, onOpen });
    unmounts.set(el, text.unmount);
    text.render(this.source);
    // Where the table starts now: CodeMirror reuses this widget when only its position changed (eq compares the text),
    // so the place it was made at is not kept.
    const start = () => { try { return view.state.doc.lineAt(view.posAtDOM(el)).from; } catch { return null; } };
    const openAt = (offset: number, y?: number) => {
      const at = start();
      if (at === null || view.state.readOnly || view.composing) return;
      view.dispatch({ selection: { anchor: at + offset }, effects: openTable.of({ from: at, pressY: y }), scrollIntoView: false });
      view.focus();
    };
    edit.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); openAt(cellOffset(this.source.split("\n")[0]!, 0), e.clientY); });
    edit.addEventListener("keydown", (e) => { if (e.isComposing) return; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openAt(cellOffset(this.source.split("\n")[0]!, 0)); } });
    // Neither a press nor the focus it would bring moves the editor's caret; the press itself opens the text.
    el.addEventListener("mousedown", (e) => { if (!(e.target instanceof Element && e.target.closest("a"))) e.preventDefault(); });
    el.addEventListener("click", (e) => {
      if (e.target instanceof Element && e.target.closest("a, .cm-table-edit")) return;
      openAt(this.cellAt(e.target), e.clientY);
    });
    el.append(edit, body);
    return el;
  }
  /** The offset, from the start of the table's text, of the cell that was pressed. */
  private cellAt(target: EventTarget | null): number {
    const cell = target instanceof Element ? target.closest("td, th") : null;
    if (!cell) return 0;
    const rowEl = cell.parentElement as HTMLTableRowElement;
    const sectionBody = rowEl.parentElement?.tagName === "TBODY";
    // Source rows: header, the `---` row, then one per body row.
    const row = sectionBody ? 2 + rowEl.sectionRowIndex : 0;
    const lines = this.source.split("\n");
    let offset = 0;
    for (let i = 0; i < Math.min(row, lines.length); i++) offset += lines[i]!.length + 1;
    return offset + cellOffset(lines[row] ?? "", (cell as HTMLTableCellElement).cellIndex);
  }
  destroy(dom: HTMLElement) { unmounts.get(dom)?.(); unmounts.delete(dom); }
  ignoreEvent() { return true; }
}

function drawn(state: EditorState, tables: TableRange[], open: number | null, context: () => EmbedContext): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const tb of tables) {
    if (tb.from === open) continue;
    ranges.push(Decoration.replace({ widget: new TableWidget(state.doc.sliceString(tb.from, tb.to), context), block: true }).range(tb.from, tb.to));
  }
  return Decoration.set(ranges, true);
}

function tableField(context: () => EmbedContext) {
  return StateField.define<TableState>({
    create: (state) => ({ open: null, deco: drawn(state, tableRanges(state), null, context) }),
    update(prev, tr) {
      const changed = tr.docChanged || tr.selection || tr.effects.some((e) => e.is(openTable)) || syntaxTree(tr.startState) !== syntaxTree(tr.state)
        || tr.startState.field(composingField, false) !== tr.state.field(composingField, false);
      if (!changed) return prev;
      if (tr.state.field(composingField, false)) {
        // Held back: positions follow the edit, nothing opens, closes or is redrawn.
        return tr.docChanged
          ? { open: prev.open === null ? null : tr.changes.mapPos(prev.open, 1), deco: prev.deco.map(tr.changes) }
          : prev;
      }
      const tables = tableRanges(tr.state);
      const open = openAfter(tr, prev, tables);
      return { open, deco: drawn(tr.state, tables, open, context) };
    },
    provide: (f) => [EditorView.decorations.from(f, (v) => v.deco), EditorView.atomicRanges.of((view) => view.state.field(f).deco)],
  });
}

/** Keeps the spot that was pressed (or where the caret was) where it was on screen when a table switches between
 *  drawn and text. The editor's layout may not be read during an update, so the caret's last place is noted after
 *  each one, and the pointer's as it goes down. */
const keepOnScreen = ViewPlugin.fromClass(class {
  caretTop: number | null = null;
  pointerY: { y: number; at: number } | null = null;
  constructor(readonly view: EditorView) {}
  update(u: ViewUpdate) {
    const field = tableStates.get(u.view);
    if (!field) return;
    let anchor: number | null = null;
    if (!u.docChanged && u.startState.field(field).open !== u.state.field(field).open) {
      let pressed: number | undefined;
      for (const tr of u.transactions) for (const e of tr.effects) if (e.is(openTable)) pressed = e.value.pressY;
      const pointer = this.pointerY && Date.now() - this.pointerY.at < 1000 ? this.pointerY.y : null;
      anchor = pressed ?? pointer ?? this.caretTop;
    }
    if (!u.selectionSet && !u.docChanged && anchor === null) return;
    const head = u.state.selection.main.head;
    u.view.requestMeasure({
      key: this,
      read: (view) => view.coordsAtPos(head)?.top ?? null,
      write: (top, view) => {
        if (top !== null && anchor !== null) scrollParent(view.dom).scrollTop += top - anchor;
        this.caretTop = top === null ? null : anchor ?? top;
      },
    });
  }
}, { eventHandlers: { pointerdown(e) { this.pointerY = { y: e.clientY, at: Date.now() }; } } });

function scrollParent(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === "auto" || o === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

const tableStates = new WeakMap<EditorView, StateField<TableState>>();

const theme = EditorView.baseTheme({
  ".cm-table": { position: "relative", padding: "4px 0", cursor: "pointer", overflowX: "auto" },
  ".cm-table-body": { whiteSpace: "normal", fontFamily: "var(--ac-font-prose)", fontSize: "var(--ac-fs-prose)" },
  ".cm-table-body table": { margin: "0" },
  ".cm-table-edit": {
    display: "block", width: "fit-content", margin: "0 0 4px auto", padding: "2px 8px", fontSize: "0.8em", fontFamily: "var(--ac-font-ui)",
    color: "var(--ac-muted)", background: "var(--ac-elevated)", border: "1px solid var(--ac-line)", borderRadius: "6px", cursor: "pointer",
  },
  ".cm-table-edit:hover, .cm-table-edit:focus-visible": { color: "var(--ac-ink)" },
});

/** The drawn tables for the note editor. `context` is read when a table draws (as for embeds). */
export function editorTables(context: () => EmbedContext): Extension {
  const field = tableField(context);
  // The caret is just after (Backspace) or before (Delete) a drawn table, which the caret treats as one unit:
  // the first press shows the text, the next one deletes a character of it.
  const reveal = (forward: boolean) => (view: EditorView) => {
    const sel = view.state.selection.main;
    if (!sel.empty || view.composing || view.state.readOnly) return false;
    const table = tableRanges(view.state).find((t) => (forward ? t.from : t.to) === sel.head);
    if (!table || view.state.field(field).open === table.from) return false;
    view.dispatch({ effects: openTable.of({ from: table.from }), selection: { anchor: forward ? table.from : table.to } });
    return true;
  };
  const register = ViewPlugin.fromClass(class { constructor(view: EditorView) { tableStates.set(view, field); } });
  return [composingField, trackComposing, field, register, keepOnScreen, Prec.high(keymap.of([{ key: "Backspace", run: reveal(false) }, { key: "Delete", run: reveal(true) }])), theme];
}
