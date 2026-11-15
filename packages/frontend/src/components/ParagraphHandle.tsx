import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { paragraphStartAt } from "../lib/editorParagraphActions";
import { chordOf, shortcutById } from "../lib/shortcuts";
import { ParagraphHandleButton, type ParagraphHandleControl, type ParagraphMenuProps } from "./ParagraphMenu";

// The handle at the left of a paragraph, on a desktop (mouse, wide screen): a
// faint grip that follows the line under the pointer and opens the ¶ menu
// (ParagraphMenu) for that paragraph. One button for the whole editor, placed
// by the mouse and moved with it; it sits beside the text, so it never covers
// what is typed and never changes the editor's width. Phones and touch screens
// keep the ¶ on the format bar.

const HANDLE_SIZE = 24;
const GAP = 4;
/** The pointer must rest on a line this long before the paragraph is looked up
 *  (reading the paragraph parses the note), so sweeping across lines costs nothing. */
const SETTLE_MS = 60;
/** Leaving the editor for the handle crosses a few pixels of margin. */
const LEAVE_MS = 200;

/** `doc`: the text `pos` was read from (CodeMirror docs are immutable, so a new one means an edit). */
type Target = { pos: number; doc: Text; top: number; left: number; height: number };

/** Where the handle goes for the paragraph starting at `pos`: beside the left edge of the text, on the paragraph's first line. */
function targetAt(view: EditorView, wrap: HTMLElement, pos: number): Target {
  const wrapBox = wrap.getBoundingClientRect();
  const text = view.contentDOM.getBoundingClientRect();
  const line = view.coordsAtPos(pos, 1);
  const block = view.lineBlockAt(pos);
  const top = line ? line.top : view.documentTop + block.top;
  const height = line ? line.bottom - line.top : view.defaultLineHeight;
  return {
    pos, doc: view.state.doc, height,
    top: top - wrapBox.top + Math.max(0, (height - HANDLE_SIZE) / 2),
    left: text.left - wrapBox.left - HANDLE_SIZE - GAP,
  };
}

export function ParagraphHandle({ viewRef, wrapRef, menu, readOnly }: {
  viewRef: RefObject<EditorView | null>;
  wrapRef: RefObject<HTMLElement | null>;
  menu: Omit<ParagraphMenuProps, "onOpenChange" | "readOnly">;
  readOnly: boolean;
}) {
  const [target, setTarget] = useState<Target | null>(null);
  const [open, setOpen] = useState(false);
  const control = useRef<ParagraphHandleControl>(null);
  const keepRef = useRef(false);
  keepRef.current = open;
  const lastLine = useRef(-1);
  const latest = useRef({ extrasAt: menu.extrasAt, readOnly });
  latest.current = { extrasAt: menu.extrasAt, readOnly };
  const [wantOpen, setWantOpen] = useState(false);

  /** The handle for the paragraph at `pos`, or none where there is no paragraph
   *  (code, a table, front matter, a blank line) or, in a read-only note, nothing to offer. */
  const place = (pos: number): Target | null => {
    const view = viewRef.current;
    const wrap = wrapRef.current;
    if (!view || !wrap) return null;
    const start = paragraphStartAt(view, pos);
    if (start === null) return null;
    if (latest.current.readOnly && !latest.current.extrasAt(start).onBlockHistory) return null;
    return targetAt(view, wrap, start);
  };

  /** The paragraph beside the handle when it is clicked. Typing, a paste,
   *  undo or a sync may have changed the note since the handle was placed:
   *  then the paragraph is read again from where the handle stands, so the
   *  menu never acts on a stale position (another paragraph, or past the end). */
  const currentPos = (at: Target): number | null => {
    const view = viewRef.current;
    const wrap = wrapRef.current;
    if (!view || !wrap) return null;
    if (view.state.doc === at.doc) return at.pos;
    const box = view.contentDOM.getBoundingClientRect();
    const y = wrap.getBoundingClientRect().top + at.top + HANDLE_SIZE / 2;
    if (y < box.top || y > box.bottom) return null;
    return paragraphStartAt(view, view.posAtCoords({ x: box.left + 1, y }, false));
  };

  useEffect(() => {
    // The editor is made after this mounts: every handler reads the view when it runs.
    const wrap = wrapRef.current;
    if (!wrap) return;
    let frame = 0;
    let settle: ReturnType<typeof setTimeout> | undefined;
    let leave: ReturnType<typeof setTimeout> | undefined;
    const hide = () => { lastLine.current = -1; setTarget(null); };
    const onMove = (e: MouseEvent) => {
      clearTimeout(leave);
      if (keepRef.current) return;
      if ((e.target as Element).closest(".md-paragraph-handle")) return;
      const { clientX, clientY } = e;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const view = viewRef.current;
        if (!view) return;
        const box = view.contentDOM.getBoundingClientRect();
        if (clientY < box.top || clientY > box.bottom) return;
        // The margin beside the text counts as the line it is level with.
        const pos = view.posAtCoords({ x: Math.min(Math.max(clientX, box.left + 1), box.right - 1), y: clientY }, false);
        const lineNo = view.state.doc.lineAt(pos).number;
        if (lineNo === lastLine.current) return;
        lastLine.current = lineNo;
        clearTimeout(settle);
        settle = setTimeout(() => { if (!keepRef.current) setTarget(place(pos)); }, SETTLE_MS);
      });
    };
    const onLeave = () => { clearTimeout(settle); leave = setTimeout(() => { if (!keepRef.current) hide(); }, LEAVE_MS); };
    // Typing takes the handle away until the pointer moves again.
    const onKey = (e: KeyboardEvent) => {
      const view = viewRef.current;
      if (!view || !view.contentDOM.contains(e.target as Node)) return;
      const chord = shortcutById("paragraph-menu")?.chord;
      if (chord && chordOf(e) === chord && !e.defaultPrevented && !view.composing) {
        e.preventDefault();
        const next = place(view.state.selection.main.head);
        if (!next) return;
        setTarget(next);
        setWantOpen(true);
      } else if (!keepRef.current && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) hide();
    };
    wrap.addEventListener("mousemove", onMove);
    wrap.addEventListener("mouseleave", onLeave);
    wrap.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(settle);
      clearTimeout(leave);
      wrap.removeEventListener("mousemove", onMove);
      wrap.removeEventListener("mouseleave", onLeave);
      wrap.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- place reads refs only; the wrapper is fixed for this mount
  }, []);

  // The keyboard asked: the handle is placed for the caret's paragraph, then its menu opens there.
  useLayoutEffect(() => {
    if (!wantOpen || !target) return;
    setWantOpen(false);
    control.current?.open(target.pos);
  }, [wantOpen, target]);

  if (!target) return null;
  return (
    <ParagraphHandleButton {...menu} readOnly={readOnly} pos={() => currentPos(target)} control={control}
      top={target.top} left={target.left}
      // Once the menu is done the paragraph may have moved or gone: the handle waits for the pointer again.
      onOpenChange={(isOpen) => {
        if (!isOpen && keepRef.current) { lastLine.current = -1; setTarget(null); }
        setOpen(isOpen);
      }} />
  );
}
