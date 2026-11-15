import { blocksParsable, blockTagSlot, mayHaveBlocks, parseBlocks, taskBoxEdit, type ParsedBlock, type Span } from "@onden/markdown";
import { EditorState, Facet, StateEffect, StateField, Transaction, type Extension, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, showPanel, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { t } from "./i18n";
import { composingField, trackComposing } from "./editorComposing";

// Block nodes in the editor (docs/architecture/block-nodes.md, B2).
//
// A block's trailing `{…}` shows as tag chips; it stays in the text (and in exports). The rules come from the same
// parser the server uses on save (@onden/markdown parseBlocks), so the editor and the server agree on which blocks
// are block nodes. A paragraph's identity is not in the text at all (it is a row in block_anchors, lib/editorAnchors),
// so there is nothing here to hide or protect: what the person types is what is saved.
//
//   - chips: the `{…}` is replaced by chips, except while the cursor is on
//     that line, where the text shows (styled) so it can be edited as text;
//   - the tasks module's tag (`{task}` on a checkbox line) is not a text chip:
//     the checkbox already says it is a task, so it shows as a faint icon at
//     the line end. Its text shows only while the selection touches the `{…}`
//     (not the whole line), and a Backspace/Delete that would take just one
//     brace first selects the whole `{…}`, because removing the tag trashes
//     the task (backend modules/tasks/blockTasks.ts);
//   - range: while the cursor is inside a block node, a line marks how far
//     the block reaches;
//   - a note too long to read (BLOCK_PARSE_MAX) gets a notice when it uses
//     block tags, so a tag that won't take effect doesn't look like it did.
//
// Parsing waits for a pause in typing; until then, positions map through the
// edits.

export type BlockScan = {
  blocks: ParsedBlock[];
  /** Over BLOCK_PARSE_MAX and written with block tags. */
  tooLong: boolean;
};

const PARSE_DELAY_MS = 250;

export function scanBlocks(text: string): BlockScan {
  if (!blocksParsable(text)) return { blocks: [], tooLong: mayHaveBlocks(text) };
  return { blocks: parseBlocks(text), tooLong: false };
}

const rescan = StateEffect.define<BlockScan>();

const mapSpan = (span: Span | null, tr: Transaction): Span | null =>
  span && { from: tr.changes.mapPos(span.from, 1), to: tr.changes.mapPos(span.to, -1) };

export const blockScanField = StateField.define<BlockScan>({
  create: (state) => scanBlocks(state.doc.toString()),
  update(scan, tr) {
    for (const e of tr.effects) if (e.is(rescan)) return e.value;
    if (!tr.docChanged) return scan;
    // Until the next parse: keep the blocks, moved with the text.
    return {
      tooLong: scan.tooLong,
      blocks: scan.blocks.map((b) => ({
        ...b,
        start: tr.changes.mapPos(b.start, 1),
        end: tr.changes.mapPos(b.end, -1),
        marks: { tags: mapSpan(b.marks.tags, tr), ref: null },
      })),
    };
  },
});

const reparseAfterPause = ViewPlugin.fromClass(class {
  timer: ReturnType<typeof setTimeout> | null = null;
  constructor(readonly view: EditorView) {}
  update(update: ViewUpdate) {
    if (!update.docChanged) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.view.dispatch({ effects: rescan.of(scanBlocks(this.view.state.doc.toString())) });
    }, PARSE_DELAY_MS);
  }
  destroy() { if (this.timer) clearTimeout(this.timer); }
});

/** The name of the tasks module's tag in this note's space (OverviewEditor
 *  resolves it from the reserved tag), or null when there is none. */
export const blockTaskTagName = Facet.define<string | null, string | null>({
  combine: (values) => values.find((v) => v) ?? null,
});

const sameTag = (a: string, b: string | null) => !!b && a.toLowerCase() === b.toLowerCase();

const SVG_NS = "http://www.w3.org/2000/svg";

class TagChips extends WidgetType {
  constructor(readonly tags: string[], readonly taskTag: string | null) { super(); }
  eq(other: TagChips) { return other.tags.join("\u0000") === this.tags.join("\u0000") && other.taskTag === this.taskTag; }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-block-tags";
    for (const tag of this.tags) {
      if (sameTag(tag, this.taskTag)) { wrap.append(taskIcon(wrap)); continue; }
      const chip = document.createElement("span");
      chip.className = "cm-block-tag";
      chip.textContent = tag;
      wrap.append(chip);
    }
    return wrap;
  }
  ignoreEvent() { return false; }
}

/** lucide CircleCheck, 14px (a CodeMirror widget is plain DOM, not React). */
function taskIcon(parent: HTMLElement): HTMLElement {
  const label = t("Task");
  const holder = parent.ownerDocument.createElement("span");
  holder.className = "cm-block-task-icon";
  holder.setAttribute("role", "img");
  holder.setAttribute("aria-label", label);
  holder.title = label;
  const svg = parent.ownerDocument.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({ width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  const circle = parent.ownerDocument.createElementNS(SVG_NS, "circle");
  for (const [k, v] of Object.entries({ cx: "12", cy: "12", r: "10" })) circle.setAttribute(k, v);
  const check = parent.ownerDocument.createElementNS(SVG_NS, "path");
  check.setAttribute("d", "m9 12 2 2 4-4");
  svg.append(circle, check);
  holder.append(svg);
  return holder;
}

/** The innermost block node whose scope holds `pos`. */
export function blockAt(blocks: ParsedBlock[], pos: number): ParsedBlock | null {
  let best: ParsedBlock | null = null;
  for (const b of blocks) {
    if (b.start <= pos && pos <= b.end && (!best || b.end - b.start < best.end - best.start)) best = b;
  }
  return best;
}

function buildDecorations(state: EditorState): DecorationSet {
  const { blocks } = state.field(blockScanField);
  const doc = state.doc;
  const sel = state.selection.main;
  const head = sel.head;
  const cursorLine = doc.lineAt(head).number;
  const taskTag = state.facet(blockTaskTagName);
  const ranges: Range<Decoration>[] = [];
  for (const b of blocks) {
    const tags = b.marks.tags;
    if (tags && tags.from < tags.to && tags.to <= doc.length) {
      // A task tag shows its text only while the selection touches the `{…}`;
      // other tags show it on the whole cursor line.
      const isTask = b.tags.some((tag) => sameTag(tag, taskTag));
      const showRaw = isTask ? sel.from <= tags.to && sel.to >= tags.from : doc.lineAt(tags.from).number === cursorLine;
      if (showRaw) ranges.push(Decoration.mark({ class: "cm-block-tags-raw" }).range(tags.from, tags.to));
      else ranges.push(Decoration.replace({ widget: new TagChips(b.tags, taskTag) }).range(tags.from, tags.to));
    }
  }
  const current = blockAt(blocks, head);
  if (current && current.end <= doc.length) {
    const first = doc.lineAt(current.start).number;
    // A scope ending at a line start (a heading's section) stops before it.
    const endPos = current.end > current.start && doc.lineAt(current.end).from === current.end ? current.end - 1 : current.end;
    const last = doc.lineAt(endPos).number;
    for (let n = first; n <= last; n++) {
      const line = doc.line(n);
      ranges.push(Decoration.line({ class: n === first ? "cm-block-range cm-block-range-first" : n === last ? "cm-block-range cm-block-range-last" : "cm-block-range" }).range(line.from));
    }
  }
  return Decoration.set(ranges, true);
}

const blockDecorations = StateField.define<DecorationSet>({
  create: buildDecorations,
  update(deco, tr) {
    if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(rescan))) return buildDecorations(tr.state);
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Backspace right after a task tag's `}` (or Delete right before its `{`)
 *  selects the whole `{…}` instead; the next press deletes it. */
const protectTaskTag = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !(tr.isUserEvent("delete.backward") || tr.isUserEvent("delete.forward"))) return tr;
  const taskTag = tr.startState.facet(blockTaskTagName);
  if (!taskTag) return tr;
  const forward = tr.isUserEvent("delete.forward");
  let single: { from: number; to: number } | null = null;
  let count = 0;
  tr.changes.iterChangedRanges((from, to) => { single = { from, to }; count++; });
  const hit = single as { from: number; to: number } | null;
  if (count !== 1 || !hit || hit.to - hit.from !== 1) return tr;
  const tags = tr.startState.field(blockScanField).blocks
    .map((b) => (b.tags.some((tag) => sameTag(tag, taskTag)) ? b.marks.tags : null))
    .find((m) => m && (forward ? m.from === hit.from : m.to === hit.to));
  if (!tags) return tr;
  return { selection: { anchor: tags.to, head: tags.from }, scrollIntoView: true };
});

/** The task tag gives its line a box (@onden/markdown taskBoxEdit), in the same transaction as the tag, so one undo
 *  takes both back. Every way the tag arrives is one edit that writes the tag's name into a `{…}`: the `{` picker,
 *  the paragraph menu, the phone bar's 「加標籤」, a typed closing `}`. Large edits (paste, drop, a note loaded from
 *  elsewhere) are not "applying the tag". While an IME composes nothing changes; when the composition ends, a tag
 *  closed by it is looked at then. Removing the tag leaves the box (a plain checkbox). */
const boxWithTaskTag = EditorState.transactionFilter.of((tr) => {
  const taskTag = tr.startState.facet(blockTaskTagName);
  if (!taskTag || tr.annotation(Transaction.remote)) return tr;
  if (["undo", "redo", "input.paste", "input.drop", "move", "delete"].some((e) => tr.isUserEvent(e))) return tr;
  const wasComposing = tr.startState.field(composingField, false) === true;
  const composing = tr.state.field(composingField, false) === true;
  if (composing) return tr;
  const spots: number[] = [];
  if (tr.docChanged && !wasComposing) {
    tr.changes.iterChanges((_fa, _ta, _fb, toB, inserted) => {
      const text = inserted.toString();
      if (toB > 0 && (text === "}" || (text.length <= taskTag.length + 4 && sameTag(text.replace(/[\s{},]/g, ""), taskTag)))) spots.push(toB - 1);
    });
  } else if (wasComposing) {
    const head = tr.newSelection.main.head;
    if (head > 0) spots.push(head - 1);
  }
  if (spots.length === 0) return tr;
  const doc = tr.newDoc.toString();
  const seen = new Set<number>();
  const changes: { from: number; insert: string }[] = [];
  for (const pos of spots) {
    const slot = blockTagSlot(doc, pos);
    if (!slot?.braces || pos < slot.braces.from || pos >= slot.braces.to || seen.has(slot.start)) continue;
    seen.add(slot.start);
    if (!slot.tags.some((tag) => sameTag(tag, taskTag))) continue;
    const edit = taskBoxEdit(doc, slot.start);
    if (edit) changes.push({ from: edit.at, insert: edit.insert });
  }
  return changes.length === 0 ? tr : [tr, { changes, sequential: true }];
});

const tooLongPanel = showPanel.compute([blockScanField], (state) => {
  if (!state.field(blockScanField).tooLong) return null;
  return () => {
    const dom = document.createElement("div");
    dom.className = "cm-block-too-long";
    dom.setAttribute("role", "status");
    dom.textContent = t("This note is too long for block tags. Tags written with {…} won't take effect until it is shorter.");
    return { dom, top: true };
  };
});

const blockTheme = EditorView.baseTheme({
  ".cm-block-tags": { display: "inline-flex", gap: "4px", verticalAlign: "baseline", marginLeft: "2px" },
  ".cm-block-tag": {
    fontSize: "0.8em", lineHeight: "1.4", padding: "0 6px", borderRadius: "999px",
    background: "var(--ac-accent-soft)", color: "var(--ac-accent)",
  },
  ".cm-block-task-icon": { display: "inline-flex", verticalAlign: "text-bottom", opacity: "0.45", color: "var(--ac-muted)" },
  ".cm-block-tags-raw": { color: "var(--ac-muted)" },
  ".cm-block-range": { boxShadow: "inset 2px 0 0 rgba(127,127,127,0.35)" },
  ".cm-block-too-long": { padding: "6px 10px", fontSize: "13px", color: "var(--ac-muted)", borderBottom: "1px solid var(--ac-line)" },
});

/** The block-node display for the note editor. */
export const editorBlocks: Extension = [
  blockScanField, composingField, trackComposing, reparseAfterPause, blockDecorations, protectTaskTag, boxWithTaskTag, tooLongPanel, blockTheme,
];
