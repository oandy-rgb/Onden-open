import { editorAnchorsOf } from "./editorAnchors";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState, type Extension, StateEffect, StateField } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { hasSafeLinkScheme, normalizeText, splitWikilink, scanWikilinks, wikilinkTarget, stripLineMarker } from "@onden/markdown";
import { isCoarsePointer } from "./mediaQuery";
import { setPendingCursor } from "./cursorHandoff";

// Following a link from the editor, so reading a note never needs the Preview
// switch. The gestures (decided with Obsidian's Live Preview complaints in
// mind: a link followed by accident while editing or scrolling):
//
//   touch, editor NOT focused (reading)  a tap follows
//   touch, editor focused (writing)      a tap places the caret; an "Open ↗"
//                                        chip (components/EditorLinkChip)
//                                        follows the link the caret is in
//   mouse                                Ctrl/Cmd+click follows, a plain click
//                                        places the caret
//   read-only note                       a plain tap / click follows (there is
//                                        no caret to place)
//
// Scrolling and long-presses never follow (a tap is a short press that did not
// move), nothing happens while an IME composes, and a `![[…]]` embed is not a
// link here. What a link opens is Preview's route: a `[[wikilink]]` through
// the app's openWikilink (an unresolved one creates the note), a URL in a new
// tab. A `#heading` / `#^block` target in THIS note scrolls the editor to it;
// in another note Preview only opens the note, and so does this.

// ── What is a link ──────────────────────────────────────────────────────────

/** A link in the text, as its span and where it leads. */
export type EditorLink =
  | { kind: "wikilink"; from: number; to: number; label: string; heading?: string; blockId?: string }
  | { kind: "url"; from: number; to: number; url: string };

/** Nodes of the markdown syntax tree whose text is code, not prose. */
const CODE_NODES = new Set(["InlineCode", "CodeText", "FencedCode", "CodeBlock", "CodeMark", "CodeInfo"]);


function insideCode(state: EditorState, pos: number): boolean {
  for (let node = syntaxTree(state).resolveInner(pos, 1); ; ) {
    if (CODE_NODES.has(node.name)) return true;
    const parent = node.parent;
    if (!parent) return false;
    node = parent;
  }
}

/** `[[Note|alias]]`, `[[Note#Heading]]`, `[[Note#^id]]`, `[[#Heading]]` → what they name.
 *  An empty `label` is a link to the note it is written in. */
export function parseWikilinkBody(body: string): { label: string; heading?: string; blockId?: string } {
  const label = wikilinkTarget(body);
  const target = splitWikilink(body).target;
  const hash = target.indexOf("#");
  if (hash === -1) return { label };
  const anchor = normalizeText(target.slice(hash + 1)).trim();
  if (anchor.startsWith("^")) return anchor.length > 1 ? { label, blockId: anchor.slice(1) } : { label };
  return anchor ? { label, heading: anchor.replace(/\s+/g, " ") } : { label };
}

/** Every link on the line holding `pos`, in document order. Code spans and
 *  fences yield none; embeds (`![[…]]`) and images are not links. */
function linksOnLine(state: EditorState, pos: number): EditorLink[] {
  const doc = state.doc;
  const line = doc.lineAt(pos);
  ensureSyntaxTree(state, line.to, 50); // a bounded parse: an unparsed tail just has no links yet
  const out: EditorLink[] = [];
  for (const m of scanWikilinks(line.text)) {
    const from = line.from + m.start, to = line.from + m.end;
    if (m.start > 0 && line.text[m.start - 1] === "!") continue; // an embed
    if (insideCode(state, from)) continue;
    out.push({ kind: "wikilink", from, to, ...parseWikilinkBody(m.body) });
  }
  syntaxTree(state).iterate({
    from: line.from, to: line.to,
    enter: (node) => {
      if (node.name === "Image" || CODE_NODES.has(node.name)) return false;
      if (node.name !== "Link" && node.name !== "Autolink" && node.name !== "URL") return;
      let urlNode: { from: number; to: number } | null = null;
      if (node.name === "URL") {
        const parent = node.node.parent?.name;
        if (parent === "Link" || parent === "Autolink" || parent === "Image") return false; // the parent's job
        urlNode = node;
      } else {
        for (let c = node.node.firstChild; c; c = c.nextSibling) if (c.name === "URL") urlNode = c;
      }
      if (!urlNode) return false; // `[text]` / `[text][ref]`: no destination written here
      const url = doc.sliceString(urlNode.from, urlNode.to).trim();
      // `[[note]]` parses as a Link too; wikilinks were found above.
      // `javascript:` and `data:` links are plain text.
      if (hasSafeLinkScheme(url)) out.push({ kind: "url", from: node.from, to: node.to, url });
      return false;
    },
  });
  return out.sort((a, b) => a.from - b.from);
}

/** The link whose text includes the character at `pos` (`from <= pos < to`):
 *  what a pointer over that character is on. null for code and embeds. */
export function linkAt(state: EditorState, pos: number): EditorLink | null {
  if (pos < 0 || pos > state.doc.length) return null;
  return linksOnLine(state, pos).find((l) => l.from <= pos && pos < l.to) ?? null;
}

/** The link the caret is inside (`from < pos < to`): a caret just before or
 *  after a link, as when typing its last bracket, is not in it. */
export function linkAroundCaret(state: EditorState, pos: number): EditorLink | null {
  return linksOnLine(state, pos).find((l) => l.from < pos && pos < l.to) ?? null;
}

// ── Whether a press follows ─────────────────────────────────────────────────

export type TapContext = {
  pointer: "touch" | "pen" | "mouse";
  /** The editor had focus when the press began (the keyboard is open). */
  focused: boolean;
  readOnly: boolean;
  /** Ctrl (or Cmd) was held. */
  modifier: boolean;
  /** An IME is composing. */
  composing: boolean;
};

/** Whether a short, still press on a link follows it (true) or is left to the
 *  editor to place the caret (false). The one table of the gestures above. */
export function followsOnTap(c: TapContext): boolean {
  if (c.composing) return false;
  if (c.readOnly) return true;
  if (c.pointer === "mouse") return c.modifier;
  return !c.focused;
}

/** Whether the "Open" chip shows for a caret at `pos`: touch, focused, a
 *  caret (not a selection) inside a link, not composing, editable. Only the
 *  link is returned; where to draw it is the view's business. */
export function chipLink(
  state: EditorState,
  c: { touch: boolean; focused: boolean; composing: boolean; readOnly: boolean },
): EditorLink | null {
  if (!c.touch || !c.focused || c.composing || c.readOnly) return null;
  const sel = state.selection.main;
  if (!sel.empty) return null;
  return linkAroundCaret(state, sel.head);
}

// ── Following ───────────────────────────────────────────────────────────────

/** What the host provides to open things. */
export type LinkFollowEnv = {
  /** The note `label` names for the note being edited (lib/wikilinks'
   *  resolveWikilink, with its space rule), or null. */
  resolveNote(label: string): { id: string } | null;
  /** The note being edited. */
  selfId(): string | null;
  /** Preview's open: the target's id, or null for an unresolved link (which
   *  the app offers to create). */
  openWikilink(label: string, targetId: string | null, blockId?: string): void;
  /** Open a URL in a new tab. */
  openUrl?(url: string): void;
  /** Where a `[[筆記/段落]]` link leads: the note and the offset of the part in it ("closed": a part link with nowhere to go,
   *  a deleted paragraph or a note that is not ours to see), or null when `label` is not a part link. */
  partTarget?(label: string): { noteId: string; title: string; at: number | null } | "closed" | null;
};

/** The position of a heading (by its text) or of the paragraph with anchor id `blockId` (the old `[[#^id]]`) in the document. */
export function anchorPosition(state: EditorState, anchor: { heading?: string; blockId?: string }): number | null {
  const doc = state.doc;
  if (anchor.blockId) {
    const at = editorAnchorsOf(state).find((a) => a.id === anchor.blockId)?.from;
    return at === undefined || at > doc.length ? null : doc.lineAt(at).from;
  }
  if (!anchor.heading) return null;
  const wanted = normalizeText(anchor.heading).replace(/\s+/g, " ").trim().toLowerCase();
  let found: number | null = null;
  ensureSyntaxTree(state, doc.length, 100);
  syntaxTree(state).iterate({
    enter: (node) => {
      if (found !== null) return false;
      if (!/^(?:ATXHeading|SetextHeading)\d$/.test(node.name)) return;
      const raw = doc.sliceString(node.from, node.to).split("\n")[0]!;
      const text = stripLineMarker(raw).replace(/\s+#+\s*$/, "");
      if (normalizeText(text).replace(/\s+/g, " ").trim().toLowerCase() === wanted) found = node.from;
      return false;
    },
  });
  return found;
}

function scrollToAnchor(view: EditorView, pos: number): void {
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 24 }), scrollIntoView: false });
}

/** Follow `link` the way Preview does. Returns whether anything was opened
 *  or scrolled to (a missing same-note anchor does nothing). */
export function followLink(view: EditorView, link: EditorLink, env: LinkFollowEnv): boolean {
  if (link.kind === "url") {
    (env.openUrl ?? defaultOpenUrl)(link.url);
    return true;
  }
  const part = env.partTarget?.(link.label) ?? null;
  if (part === "closed") return false;
  if (part) {
    if (part.noteId === env.selfId()) {
      if (part.at !== null) scrollToAnchor(view, Math.min(part.at, view.state.doc.length));
      return true;
    }
    if (part.at !== null) setPendingCursor(part.noteId, part.at, part.at);
    env.openWikilink(part.title, part.noteId);
    return true;
  }
  const anchored = link.heading !== undefined || link.blockId !== undefined;
  const target = link.label === "" ? null : env.resolveNote(link.label);
  const sameNote = link.label === "" || (target !== null && target.id === env.selfId());
  if (sameNote && anchored) {
    const pos = anchorPosition(view.state, link);
    if (pos === null) return false;
    scrollToAnchor(view, pos);
    return true;
  }
  if (link.label === "") return false; // `[[#]]`: nothing to open
  if (link.blockId !== undefined) env.openWikilink(link.label, target?.id ?? null, link.blockId);
  else env.openWikilink(link.label, target?.id ?? null);
  return true;
}

function defaultOpenUrl(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

// ── The extension ───────────────────────────────────────────────────────────

/** A short press: at most this far and this long (a longer press selects text). */
const TAP_SLOP_PX = 10;
const TAP_MAX_MS = 500;

/** Where to draw the chip and which link it opens. */
export type LinkChip = { link: EditorLink; caret: { left: number; top: number; bottom: number } };

type Press = {
  id: number; x: number; y: number; at: number;
  link: EditorLink; follows: boolean;
};

/** The character under a pointer, or null off the text (blank space after a
 *  line's end is not a link). posAtCoords returns the nearer character
 *  boundary, so the character is the one before it when the pointer is left
 *  of that boundary. */
function charUnder(view: EditorView, x: number, y: number): number | null {
  const pos = view.posAtCoords({ x, y });
  if (pos === null) return null;
  const edge = view.coordsAtPos(pos);
  if (!edge) return pos;
  return x < edge.left && pos > 0 ? pos - 1 : pos;
}

/** Whether Ctrl/Cmd is held, in the editor state so the hand cursor class
 *  survives CodeMirror rewriting its own DOM classes. */
const modifierHeld = {
  set: StateEffect.define<boolean>(),
  field: StateField.define<boolean>({
    create: () => false,
    update(held, tr) {
      for (const e of tr.effects) if (e.is(modifierHeld.set)) held = e.value;
      return held;
    },
  }),
};

/** `cm-link-follow` makes link text a hand: while Ctrl/Cmd is held, and
 *  always in a read-only note, where a plain click follows. */
const linkCursor = EditorView.editorAttributes.compute([modifierHeld.field, EditorState.readOnly], (state) => ({
  class: state.field(modifierHeld.field) || state.readOnly ? "cm-link-follow" : "",
}));

/** Link following for one editor: taps and Ctrl/Cmd+clicks (see the top of the
 *  file), the pointer hand while Ctrl/Cmd is held, and `onChip` — called with
 *  the link the caret is in (or null) so the host can draw the "Open" chip.
 *  The note's read-only state is the editor state's (EditorState.readOnly). */
export function editorLinkFollow(opts: {
  env: LinkFollowEnv;
  onChip: (chip: LinkChip | null) => void;
}): Extension {
  const { env, onChip } = opts;

  const plugin = ViewPlugin.fromClass(class {
    press: Press | null = null;
    /** The compat mouse events of a followed press must not move the caret or open the keyboard. */
    swallowUntil = 0;
    lastPointer: "touch" | "pen" | "mouse" | null = null;
    chipKey = "";
    modifier = false;
    readonly onKey = (e: KeyboardEvent) => this.setModifier(e.ctrlKey || e.metaKey);
    readonly onBlur = () => this.setModifier(false);

    constructor(readonly view: EditorView) {
      window.addEventListener("keydown", this.onKey);
      window.addEventListener("keyup", this.onKey);
      window.addEventListener("blur", this.onBlur);
    }

    destroy() {
      window.removeEventListener("keydown", this.onKey);
      window.removeEventListener("keyup", this.onKey);
      window.removeEventListener("blur", this.onBlur);
      onChip(null);
    }

    setModifier(on: boolean) {
      if (this.modifier === on) return;
      this.modifier = on;
      this.syncCursorClass();
    }

    syncCursorClass() {
      this.view.dispatch({ effects: modifierHeld.set.of(this.modifier) });
    }

    touchy() { return this.lastPointer ? this.lastPointer !== "mouse" : isCoarsePointer(); }

    update(u: ViewUpdate) {
      if (u.selectionSet || u.docChanged || u.focusChanged || u.geometryChanged) this.syncChip();
    }

    syncChip() {
      const view = this.view;
      const link = chipLink(view.state, {
        touch: this.touchy(), focused: view.hasFocus, composing: view.composing, readOnly: view.state.readOnly,
      });
      if (!link) {
        if (this.chipKey !== "") { this.chipKey = ""; onChip(null); }
        return;
      }
      const head = view.state.selection.main.head;
      view.requestMeasure({
        key: this,
        read: () => view.coordsAtPos(head),
        write: (caret) => {
          if (!caret) return;
          // Re-check: the measure runs after the update that asked for it.
          if (chipLink(view.state, {
            touch: this.touchy(), focused: view.hasFocus, composing: view.composing, readOnly: view.state.readOnly,
          })?.from !== link.from) return;
          const key = `${link.from}:${link.to}:${Math.round(caret.top)}:${Math.round(caret.left)}`;
          if (key === this.chipKey) return;
          this.chipKey = key;
          onChip({ link, caret: { left: caret.left, top: caret.top, bottom: caret.bottom } });
        },
      });
    }

    pointerdown(e: PointerEvent) {
      this.press = null;
      this.lastPointer = e.pointerType === "touch" || e.pointerType === "pen" ? e.pointerType : "mouse";
      if (e.button !== 0 || !e.isPrimary) return;
      const pos = charUnder(this.view, e.clientX, e.clientY);
      if (pos === null) return;
      const link = linkAt(this.view.state, pos);
      if (!link) return;
      const follows = followsOnTap({
        pointer: this.lastPointer, focused: this.view.hasFocus, readOnly: this.view.state.readOnly,
        modifier: e.ctrlKey || e.metaKey, composing: this.view.composing,
      });
      this.press = { id: e.pointerId, x: e.clientX, y: e.clientY, at: e.timeStamp, link, follows };
      // The compat mousedown that follows would place the caret (and, from a
      // closed keyboard, open it); a followed press must not.
      if (follows) this.swallowUntil = Date.now() + 700;
    }

    pointerup(e: PointerEvent) {
      const press = this.press;
      this.press = null;
      if (!press || press.id !== e.pointerId || !press.follows) return;
      const still = Math.hypot(e.clientX - press.x, e.clientY - press.y) <= TAP_SLOP_PX;
      if (!still || e.timeStamp - press.at > TAP_MAX_MS || this.view.composing) { this.swallowUntil = 0; return; }
      // The text may have changed under a slow press: the link must still be there.
      const now = linkAt(this.view.state, press.link.from);
      if (!now || now.from !== press.link.from || now.to !== press.link.to) { this.swallowUntil = 0; return; }
      followLink(this.view, now, env);
    }

    cancel() { this.press = null; this.swallowUntil = 0; }
  });

  const swallow = (e: Event, view: EditorView) => {
    const p = view.plugin(plugin);
    if (!p || Date.now() > p.swallowUntil) return false;
    e.preventDefault();
    return true;
  };

  return [
    modifierHeld.field,
    linkCursor,
    plugin,
    EditorView.domEventHandlers({
      pointerdown(e, view) { view.plugin(plugin)?.pointerdown(e); return false; },
      pointerup(e, view) { view.plugin(plugin)?.pointerup(e); return false; },
      pointercancel(_e, view) { view.plugin(plugin)?.cancel(); return false; },
      mousedown: swallow,
      click: swallow,
    }),
    EditorView.theme({ "&.cm-link-follow .cm-md-link": { cursor: "pointer" } }),
  ];
}
