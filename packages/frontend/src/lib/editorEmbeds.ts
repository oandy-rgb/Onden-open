import { type EditorState, type Line, type Text, type Extension, type Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { embedLine, fenceScanner, frontmatterEndLine, isHttpUrl, mediaSrc } from "@onden/markdown";
import { embedSourceVersion, resolveEmbed, taskVersion } from "./embeds";
import { setEmbeddedTaskDone } from "./embedTasks";
import { mountEmbed, type EditableEmbed } from "./embedDom";
import type { WikilinkNode, WikilinkSource } from "./wikilinks";
import { createLongPress } from "./touchHold";

// `![[…]]` embeds in the editor, the way Obsidian's live preview shows them:
// a line that is just an embed shows the embed itself (a drawing as its
// picture, a block / section / note as its text, lib/embedDom — the preview's renderer) while the cursor is
// elsewhere, and its text again as soon as the cursor or a selection is on
// that line, so it stays editable as text. The text is never changed.
//
// A line of plain markdown images, `![alt](url)`, is shown the same way: the
// pictures while the cursor is elsewhere, the text on the cursor (same reveal,
// same strip, same long press; a tap on a picture does nothing).
//
// Showing `![[…]]` is always deliberate: the arrow keys into the line, a tap on
// the thin strip after the embed (the end of its line), or a long press on a
// phone. A plain tap never does — on a block / section / note it opens the
// source in an editor (EmbedContext.onEdit), on a drawing it opens the drawing —
// so which line of a tall embed the finger lands on decides nothing.
//
//   - only whole-line embeds of a note that exists become widgets; an embed
//     in the middle of a sentence, in a code block, or naming no note stays
//     text;
//   - the widget draws lazily (lib/embedDom: on approaching the viewport) and
//     reads drawings through one cache, so typing never waits on it;
//   - the 「開啟手寫頁」 button, or a tap on the picture, opens the drawing.

/** What the widgets need from the editor's host, read when a widget draws. */
export type EmbedContext = {
  nodes: readonly WikilinkNode[];
  /** The note being edited: its links resolve within its space. */
  from: WikilinkSource | null;
  onOpen?: (nodeId: string, blockId?: string) => void;
  /** A tap on a block / section / note embed: edit its source in place. */
  onEdit?: (edit: EmbedEditRequest) => void;
  /** May the reader change this note? A deleted paragraph's embed then offers 「救回」. */
  canRestoreBlock?: (node: WikilinkNode) => boolean;
};

export type EmbedEditRequest = {
  embed: EditableEmbed;
  /** Show this embed's `![[…]]` text with the caret on it (the sheet's
   *  「編輯嵌入語法」). */
  revealSource: () => void;
};


/** Put the caret at the end of the embed's line: the line becomes text. */
function revealEmbedSource(view: EditorView, el: HTMLElement) {
  let pos: number;
  try { pos = view.posAtDOM(el); } catch { return; }
  const line = view.state.doc.lineAt(Math.min(pos, view.state.doc.length));
  view.dispatch({ selection: { anchor: line.to }, effects: embedEditorFocus.of(true) });
  view.focus();
}

class EmbedWidget extends WidgetType {
  private cleanup: (() => void) | null = null;
  /** `version`: the embedded note's text (embedSourceVersion), so a sync or
   *  local edit of the source redraws the widget and nothing else does. */
  constructor(readonly body: string, readonly version: string, readonly context: () => EmbedContext) { super(); }
  eq(other: EmbedWidget) { return other.body === this.body && other.version === this.version; }
  get estimatedHeight() { return 160; }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "cm-embed";
    const { nodes, from, onOpen, onEdit, canRestoreBlock } = this.context();
    const content = document.createElement("div");
    content.className = "cm-embed-content";
    this.cleanup = mountEmbed(content, resolveEmbed(this.body, from, nodes), {
      onOpen, nodes, from, canRestoreBlock, setTaskDone: setEmbeddedTaskDone,
      onEdit: onEdit && ((embed) => onEdit({ embed, revealSource: () => revealEmbedSource(view, el) })),
    });
    // The strip after the embed is its line's end: a tap there shows the text.
    const end = document.createElement("div");
    end.className = "cm-embed-end";
    end.addEventListener("click", () => revealEmbedSource(view, el));
    el.append(content, end);
    this.cleanup = chain(this.cleanup, watchLongPress(el, () => revealEmbedSource(view, el)));
    return el;
  }
  destroy() { this.cleanup?.(); this.cleanup = null; }
  // The widget acts on its own taps; the editor never moves the caret onto the
  // line because of one.
  ignoreEvent() { return true; }
}

function chain(a: () => void, b: () => void): () => void {
  return () => { a(); b(); };
}

/** A touch held still on `el` calls `reveal`, and the click that follows the
 *  release is swallowed so it does not also open the editor. */
function watchLongPress(el: HTMLElement, reveal: () => void): () => void {
  const press = createLongPress(reveal, { mouse: false });
  const swallow = (e: Event) => { press.consumeClick(e); };
  el.addEventListener("pointerdown", press.down);
  el.addEventListener("pointermove", press.move);
  el.addEventListener("pointerup", press.cancel);
  el.addEventListener("pointercancel", press.cancel);
  el.addEventListener("click", swallow, true);
  el.addEventListener("contextmenu", swallow, true);
  return press.cancel;
}

/** The editor has focus. Until it does, the selection is only the default
 *  caret at the start, which must not turn a note's first line back into
 *  text: a note that is just `![[drawing]]` would never show its picture. */
export const embedEditorFocus = StateEffect.define<boolean>();
const focusField = StateField.define<boolean>({
  create: () => false,
  update(focused, tr) {
    for (const effect of tr.effects) if (effect.is(embedEditorFocus)) focused = effect.value;
    return focused;
  },
});

/** Whether the editor has focus, as the widgets read it (a state without the field counts as focused). */
export function editorFocused(state: EditorState): boolean {
  return state.field(focusField, false) !== false;
}

/** Lines a widget may replace: not under the cursor or a selection (while the
 *  editor has focus) and not inside a code fence. The one place both kinds of
 *  line widget (embeds, images) decide that. */
function* widgetLines(state: EditorState): Generator<Line> {
  const doc = state.doc;
  const touched = new Set<number>();
  // A state without the field (a bare test state) counts as focused.
  if (state.field(focusField, false) !== false) for (const r of state.selection.ranges) {
    const first = doc.lineAt(r.from).number, last = doc.lineAt(r.to).number;
    for (let n = first; n <= last; n++) touched.add(n);
  }
  // Read from the text itself, so a line inside a code block never becomes a
  // widget even before the syntax tree has been parsed that far.
  const fence = fenceScanner();
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (fence(line.text) === "outside" && !touched.has(n)) yield line;
  }
}

/** Lines shown as embeds: whole-line `![[…]]` naming a note, without the
 *  cursor or a selection on them while the editor has focus. Pure over the
 *  state (tests read it). */
export function embedLineRanges(state: EditorState, context: () => EmbedContext): Array<{ from: number; to: number; body: string; version: string }> {
  const out: Array<{ from: number; to: number; body: string; version: string }> = [];
  let nodes: readonly WikilinkNode[] | null = null;
  let from: WikilinkSource | null = null;
  for (const line of widgetLines(state)) {
    if (!line.text.includes("![[")) continue;
    const ref = embedLine(line.text);
    if (!ref) continue;
    if (nodes === null) ({ nodes, from } = context());
    const embed = resolveEmbed(ref.body, from, nodes);
    if (embed.kind === "missing") continue;
    out.push({ from: line.from, to: line.to, body: ref.body, version: embed.kind === "task" ? (embed.task ? taskVersion(embed.task) : "task:none") : embedSourceVersion(embed.node) });
  }
  return out;
}

export type EditorImage = { alt: string; src: string };

/** The address a markdown image may load from in the editor: this origin's
 *  `/api/media/…` or an http(s) URL, written as the reading view loads it
 *  (a bare `javascript:`, `data:` or `//host` value is "" there, so text here). */
export function editorImageSrc(raw: string): string | null {
  const src = mediaSrc(raw);
  return isHttpUrl(src) || src.startsWith("/api/media/") ? src : null;
}

/** Whether `lineNo` is inside the frontmatter block (fences included). A
 *  `---` rule with no closing fence is not frontmatter, as in the reading view. */
function inFrontmatter(doc: Text, lineNo: number): boolean {
  const end = frontmatterEndLine(doc.lines, (n) => doc.line(n).text);
  return end !== null && lineNo <= end;
}

/** The images of a line that is only `![alt](url)` images (the syntax tree's
 *  `Image` nodes, spaces between), or null: a mid-sentence image, one in a
 *  link, or one with an address the editor won't load stays text. */
function imagesOfLine(state: EditorState, line: Line): EditorImage[] | null {
  ensureSyntaxTree(state, line.to, 50); // a bounded parse: an unparsed tail just stays text
  const images: EditorImage[] = [];
  let rest = line.text, bad = false;
  syntaxTree(state).iterate({
    from: line.from, to: line.to,
    enter: (node) => {
      if (node.name !== "Image") return;
      const url = node.node.getChild("URL");
      const src = url && node.from >= line.from && node.to <= line.to ? editorImageSrc(state.doc.sliceString(url.from, url.to).replace(/^<|>$/g, "")) : null;
      if (src === null) bad = true;
      else {
        const marks = node.node.getChildren("LinkMark"); // `![`, `]`, `(`, `)`
        const alt = marks.length > 1 ? state.doc.sliceString(marks[0]!.to, marks[1]!.from) : "";
        images.push({ alt, src });
        rest = rest.replace(state.doc.sliceString(node.from, node.to), "");
      }
      return false;
    },
  });
  return !bad && images.length > 0 && rest.trim() === "" ? images : null;
}

/** Lines shown as pictures: whole-line markdown images, under the same
 *  cursor / fence rules as embeds. */
export function imageLineRanges(state: EditorState): Array<{ from: number; to: number; images: EditorImage[] }> {
  const out: Array<{ from: number; to: number; images: EditorImage[] }> = [];
  for (const line of widgetLines(state)) {
    if (!line.text.includes("![") || line.text.includes("![[") || inFrontmatter(state.doc, line.number)) continue;
    const images = imagesOfLine(state, line);
    if (images) out.push({ from: line.from, to: line.to, images });
  }
  return out;
}

/** Natural size of each picture the editor has loaded, by address. CodeMirror
 *  draws a line widget only near the viewport and builds a fresh <img> each
 *  time, so without this a redrawn picture is a few pixels tall until it
 *  decodes and then jumps to its real height (the page twitches while the person
 *  scrolls). With it, the new <img> gets its box at once and the line's height
 *  estimate is the real one. Only a picture never loaded yet is estimated blind. */
const imageSizes = new Map<string, { width: number; height: number }>();
const UNKNOWN_IMAGE_HEIGHT = 120;
/** Padding (4+4) and the strip after the picture, as in `theme` below. */
const IMAGE_LINE_EXTRA_PX = 28;
let lastContentWidth = 0;

export function rememberImageSize(src: string, width: number, height: number) {
  if (width > 0 && height > 0) imageSizes.set(src, { width, height });
}
export function forgetImageSizes() { imageSizes.clear(); lastContentWidth = 0; }

/** The size a picture of natural size `size` is drawn at: scaled down to the
 *  content width and capped in height as the stylesheet does, shape kept. */
function fittedImageSize(size: { width: number; height: number }, contentWidth: number, maxImageHeight: number) {
  const scale = Math.min(1, contentWidth / size.width, maxImageHeight / size.height);
  return { width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
}

/** The height a line of pictures is drawn at: the tallest of the row. */
export function estimateImageLineHeight(images: readonly EditorImage[], contentWidth: number, maxImageHeight: number): number {
  let tallest = 0, unknown = false;
  for (const { src } of images) {
    const size = imageSizes.get(src);
    if (!size || contentWidth <= 0) { unknown = true; continue; }
    tallest = Math.max(tallest, fittedImageSize(size, contentWidth, maxImageHeight).height);
  }
  return (unknown && tallest === 0 ? UNKNOWN_IMAGE_HEIGHT : tallest) + IMAGE_LINE_EXTRA_PX;
}

/** A markdown image line: the pictures, each quietly replaced by its alt text
 *  if it fails to load (never a broken-image icon). */
class ImageWidget extends WidgetType {
  constructor(readonly images: readonly EditorImage[]) { super(); }
  eq(other: ImageWidget) {
    return other.images.length === this.images.length && other.images.every((p, i) => p.src === this.images[i]!.src && p.alt === this.images[i]!.alt);
  }
  get estimatedHeight() {
    return estimateImageLineHeight(this.images, lastContentWidth, Math.min(window.innerHeight * 0.6, 520));
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "cm-embed";
    const content = document.createElement("div");
    content.className = "cm-md-images";
    lastContentWidth = view.contentDOM.clientWidth || lastContentWidth;
    const maxHeight = Math.min(window.innerHeight * 0.6, 520);
    for (const { alt, src } of this.images) {
      const img = document.createElement("img");
      img.className = "cm-md-image";
      img.alt = alt;
      // CodeMirror draws a widget only near the viewport, so "lazy" would just
      // add a second wait inside the scroll container.
      img.loading = "eager";
      img.decoding = "async";
      const known = imageSizes.get(src);
      if (known && lastContentWidth > 0) { // the box it will have, before the pixels arrive
        const fitted = fittedImageSize(known, lastContentWidth, maxHeight);
        img.style.width = `${fitted.width}px`;
        img.style.height = `${fitted.height}px`;
      }
      img.addEventListener("load", () => {
        img.style.width = img.style.height = "";
        const first = !imageSizes.has(src);
        rememberImageSize(src, img.naturalWidth, img.naturalHeight);
        // The height map corrects itself once, from the estimate to the real height.
        if (first) view.requestMeasure();
      }, { once: true });
      img.addEventListener("error", () => {
        const note = document.createElement("span");
        note.className = "cm-md-image-missing";
        note.textContent = alt;
        img.replaceWith(note);
      }, { once: true });
      img.src = src;
      content.append(img);
    }
    const end = document.createElement("div");
    end.className = "cm-embed-end";
    end.addEventListener("click", () => revealEmbedSource(view, el));
    el.append(content, end);
    this.cleanup = watchLongPress(el, () => revealEmbedSource(view, el));
    return el;
  }
  private cleanup: (() => void) | null = null;
  destroy() { this.cleanup?.(); this.cleanup = null; }
  ignoreEvent() { return true; }
}

/** Whether some line looks like an image line but is not a picture yet: the
 *  only thing a larger syntax tree can change. Cheap text checks first, so a
 *  parse step on a note without images costs one pass over its lines. */
function unparsedImageLine(state: EditorState, shown: DecorationSet): boolean {
  let pictures = 0;
  shown.between(0, state.doc.length, (_from, _to, deco) => { if (deco.spec.widget instanceof ImageWidget) pictures++; });
  let candidates = 0;
  for (const line of widgetLines(state)) {
    if (line.text.trimStart().startsWith("![") && !line.text.includes("![[") && !inFrontmatter(state.doc, line.number)) candidates++;
  }
  return candidates > pictures;
}

function build(state: EditorState, context: () => EmbedContext): DecorationSet {
  const ranges: Range<Decoration>[] = embedLineRanges(state, context).map((r) =>
    Decoration.replace({ widget: new EmbedWidget(r.body, r.version, context), block: true }).range(r.from, r.to));
  for (const r of imageLineRanges(state)) ranges.push(Decoration.replace({ widget: new ImageWidget(r.images), block: true }).range(r.from, r.to));
  return Decoration.set(ranges, true);
}

/** Dispatch when the host's notes change (a note created, renamed or loaded):
 *  the lines are scanned again, so an embed that now names a note shows. */
export const refreshEmbeds = StateEffect.define<null>();

const theme = EditorView.baseTheme({
  ".cm-embed": { padding: "4px 0", WebkitTouchCallout: "none" },
  ".cm-embed-end": { height: "20px", cursor: "text" },
  ".cm-md-images": { display: "flex", flexWrap: "wrap", gap: "8px" },
  // A phone screenshot at full width would be two screens tall: cap it, keep its shape.
  ".cm-md-image": { maxWidth: "100%", maxHeight: "min(60vh, 520px)", width: "auto", height: "auto", objectFit: "contain", borderRadius: "6px" },
  ".cm-md-image-missing": { color: "var(--ac-muted)", fontSize: "0.9em" },
  ".md-transclusion--editable, .md-drawing-tappable": { cursor: "pointer" },
});

/** The embed display for the note editor. `context` is read whenever the
 *  lines are scanned or a widget draws, so it can return the host's latest
 *  notes without reconfiguring the editor. */
export function editorEmbeds(context: () => EmbedContext): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => build(state, context),
    update(deco, tr) {
      if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(refreshEmbeds) || e.is(embedEditorFocus))) return build(tr.state, context);
      // A line is an image only once the parse covers it (a long note, a slow
      // device, the language still loading), so a growing tree scans again —
      // but only while a candidate line is still text (see unparsedImageLine).
      if (syntaxTree(tr.startState) !== syntaxTree(tr.state) && unparsedImageLine(tr.state, deco)) return build(tr.state, context);
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
  return [focusField, EditorView.focusChangeEffect.of((_state, focusing) => embedEditorFocus.of(focusing)), field, theme];
}
