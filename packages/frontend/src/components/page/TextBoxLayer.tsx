import { Trash2 } from "lucide-react";
import {
  useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore,
  type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent,
} from "react";
import { PAGE_TEXT_DEFAULT_WIDTH, PAGE_TEXT_MIN_WIDTH, PAGE_TEXT_SIZES, type PageTextBox, type PageTextDoc } from "@onden/markdown/page-text";
import { DEFAULT_QUICK_COLORS } from "../../lib/ink";
import { isEscapeKey, isImeComposing } from "../../lib/keys";
import { useT } from "../../lib/i18n";
import { classNames } from "../../lib/utils";
import { useInkPalette } from "../../hooks/useInkPalette";
import { isPrimaryPress, useTap, type PageTextController } from "../../lib/pageText";
import { ColorSwatch } from "../InkColorPanel";
import "../InkToolbar.css"; // the colour swatches of the bar
import "./TextBoxLayer.css";
import { capturePointer, DRAG_SLOP_PX } from "../../lib/pointerDrag";
import { observeSize } from "../../lib/observeSize";
import { Pressable, TextArea, keepFocus } from "../ui";

// The text boxes of one page — the same layer on a PDF page, a handwriting
// page and (later) a slide. The page supplies only: its key, how wide it is in
// page units, and the element that sits over it; boxes are stored in page units
// (@onden/markdown/page-text) and drawn here at the page's current size, so
// zoom and full screen move and scale them with the page.
//
// What the layer does, by `mode` (the toolbar's tool):
//   "view"    boxes are shown and nothing is touched (pen, eraser, text select…);
//   "select"  a tap selects a box, a drag moves it (the Hand tool);
//   "text"    the same, plus a tap on empty page adds a box and starts typing;
//             a tap while a box is open only closes it.
// Selecting shows a small bar (size, colour, delete) and a handle on the right
// edge that sets the width. An empty box is removed when it is closed. Saving,
// undo and the debounce are the controller's (lib/pageText).

export type TextBoxMode = "view" | "select" | "text";

type Props = {
  controller: PageTextController;
  /** The controller's document (usePageTextController): re-renders on change. */
  doc: PageTextDoc;
  pageKey: string;
  /** Page units across the page's full width. */
  pageWidth: number;
  mode: TextBoxMode;
  /** Where a tap on empty page adds a box, when the host already has the
   *  element over the page (the ink stage). Without it the layer puts its own
   *  tap catcher under the boxes (a PDF page). */
  tapTarget?: HTMLElement | null;
  /** CSS px per page unit, when it cannot be measured (tests). */
  scale?: number;
};

const px = (n: number) => `${n}px`;
const BAR_HEIGHT = 40;

export default function TextBoxLayer({ controller, doc, pageKey, pageWidth, mode, tapTarget, scale: scaleProp }: Props) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [capture, setCapture] = useState<HTMLDivElement | null>(null);
  const [measured, setMeasured] = useState(1);
  const palette = useInkPalette().palette;
  const selection = useSyncExternalStore(controller.subscribe, controller.getSelection);
  const scale = scaleProp ?? measured;
  const interactive = mode !== "view" && !controller.readOnly;
  const boxes = doc.pages[pageKey]?.boxes ?? [];
  const selected = selection?.pageKey === pageKey ? selection : null;
  const selectedBox = selected ? boxes.find((box) => box.id === selected.id) : undefined;

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || scaleProp !== undefined) return;
    const measure = () => { if (root.clientWidth > 0) setMeasured(root.clientWidth / pageWidth); };
    measure();
    return observeSize(root, measure);
  }, [pageWidth, scaleProp]);

  // Leaving the text and Hand tools ends the open box (an empty one goes).
  useEffect(() => { if (mode === "view") controller.clearSelection(); }, [mode, controller]);

  const toUnits = useCallback((clientX: number, clientY: number) => {
    const rect = rootRef.current?.getBoundingClientRect();
    return { x: (clientX - (rect?.left ?? 0)) / scale, y: (clientY - (rect?.top ?? 0)) / scale };
  }, [scale]);

  const onTapPage = useCallback((clientX: number, clientY: number) => {
    // A box is open: this tap closes it (the page is not asked for a new one).
    if (controller.getSelection()) { controller.commit(); controller.clearSelection(); return; }
    const at = toUnits(clientX, clientY);
    const w = Math.min(PAGE_TEXT_DEFAULT_WIDTH, pageWidth);
    const size = PAGE_TEXT_SIZES.medium;
    const box = controller.addBox(pageKey, {
      x: Math.max(0, Math.min(pageWidth - w, at.x)), y: Math.max(0, at.y - size * 0.7), w, size,
      color: palette.quick[0] ?? DEFAULT_QUICK_COLORS[0],
    });
    if (box) controller.select(pageKey, box.id, true);
  }, [controller, pageKey, pageWidth, palette.quick, toUnits]);

  const tapEl = tapTarget === undefined ? capture : tapTarget;
  useTap(tapEl, mode === "text" && !controller.readOnly, onTapPage);

  if (boxes.length === 0 && !(interactive && mode === "text" && tapTarget === undefined)) {
    return <div ref={rootRef} className="page-text-layer" aria-hidden="true" />;
  }
  const barBelow = selectedBox ? selectedBox.y * scale < BAR_HEIGHT + 4 : false;
  return (
    <div ref={rootRef} className="page-text-layer" data-page-text-page={pageKey}>
      {interactive && mode === "text" && tapTarget === undefined && (
        <div ref={setCapture} className="page-text-capture" data-page-text-capture="" />
      )}
      {boxes.map((box) => (
        <TextBox
          key={box.id}
          box={box}
          pageKey={pageKey}
          pageWidth={pageWidth}
          scale={scale}
          interactive={interactive}
          selected={selected?.id === box.id}
          editing={selected?.id === box.id && selected.editing}
          controller={controller}
        />
      ))}
      {interactive && selectedBox && selected && (
        <div
          className={classNames("page-text-bar", barBelow && "page-text-bar--below")}
          role="toolbar"
          aria-label={t("Text box")}
          // Keep the typing focus: pressing a button here must not close the box.
          onMouseDown={keepFocus}
          style={{
            "--ptb-left": px(selectedBox.x * scale),
            "--ptb-top": px(barBelow ? (selectedBox.y + boxHeightUnits(selectedBox)) * scale + 6 : selectedBox.y * scale - BAR_HEIGHT),
          } as CSSProperties}
        >
          {(["small", "medium", "large"] as const).map((id) => (
            <Pressable
              key={id}
              type="button"
              className={classNames("page-text-size", `page-text-size--${id}`, selectedBox.size === PAGE_TEXT_SIZES[id] && "active")}
              aria-pressed={selectedBox.size === PAGE_TEXT_SIZES[id]}
              aria-label={id === "small" ? t("Small text") : id === "medium" ? t("Medium text") : t("Large text")}
              title={id === "small" ? t("Small text") : id === "medium" ? t("Medium text") : t("Large text")}
              onClick={() => controller.setStyle(pageKey, selectedBox.id, { size: PAGE_TEXT_SIZES[id] })}
            >A</Pressable>
          ))}
          <span className="page-text-bar-sep" />
          {palette.quick.map((color) => (
            <ColorSwatch
              key={color}
              color={color}
              active={selectedBox.color.toLowerCase() === color.toLowerCase()}
              onPick={(picked) => controller.setStyle(pageKey, selectedBox.id, { color: picked })}
            />
          ))}
          <span className="page-text-bar-sep" />
          <Pressable
            type="button"
            className="page-text-delete"
            aria-label={t("Delete text box")}
            title={t("Delete text box")}
            onClick={() => controller.removeBox(pageKey, selectedBox.id)}
          ><Trash2 size={15} /></Pressable>
        </div>
      )}
    </div>
  );
}

/** Rough height of a box in page units (lines × line height), for placing the
 *  bar under a box at the top of the page. */
function boxHeightUnits(box: PageTextBox): number {
  return Math.max(1, box.text.split("\n").length) * box.size * 1.35 + 8;
}


type Press =
  | { kind: "move"; id: number; x: number; y: number; box: { x: number; y: number }; moved: boolean }
  | { kind: "resize"; id: number; x: number; w: number; moved: boolean };

function TextBox({ box, pageKey, pageWidth, scale, interactive, selected, editing, controller }: {
  box: PageTextBox; pageKey: string; pageWidth: number; scale: number; interactive: boolean;
  selected: boolean; editing: boolean; controller: PageTextController;
}) {
  const t = useT();
  const press = useRef<Press | null>(null);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  // The text as typed while an input method is composing: the box's text (and
  // the save) wait for the composition to end.
  const [draft, setDraft] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = px(el.scrollHeight);
  });
  useEffect(() => {
    if (editing) {
      const el = area.current;
      el?.focus({ preventScroll: true });
      el?.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing]);

  const startPress = (e: ReactPointerEvent, next: Press) => {
    if (!interactive || !isPrimaryPress(e)) return;
    e.stopPropagation();
    press.current = next;
    capturePointer(e.currentTarget, e.pointerId);
  };
  const onBoxDown = (e: ReactPointerEvent) => {
    if (editing && (e.target as HTMLElement).tagName === "TEXTAREA") return; // caret placement
    startPress(e, { kind: "move", id: e.pointerId, x: e.clientX, y: e.clientY, box: { x: box.x, y: box.y }, moved: false });
  };
  const onResizeDown = (e: ReactPointerEvent) => {
    startPress(e, { kind: "resize", id: e.pointerId, x: e.clientX, w: box.w, moved: false });
  };
  const onPressMove = (e: ReactPointerEvent) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    if (p.kind === "move") {
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      if (!p.moved && Math.hypot(dx, dy) < DRAG_SLOP_PX) return;
      p.moved = true;
      controller.preview(pageKey, box.id, {
        x: Math.max(0, Math.min(pageWidth - box.w, p.box.x + dx / scale)), y: Math.max(0, p.box.y + dy / scale),
      });
    } else {
      const dx = e.clientX - p.x;
      if (!p.moved && Math.abs(dx) < DRAG_SLOP_PX) return;
      p.moved = true;
      controller.preview(pageKey, box.id, { w: Math.max(PAGE_TEXT_MIN_WIDTH, Math.min(pageWidth - box.x, p.w + dx / scale)) });
    }
  };
  const onPressEnd = (e: ReactPointerEvent) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    press.current = null;
    if (p.moved) {
      // The release is the one step: what the preview left is the geometry.
      const now = controller.box(pageKey, box.id);
      if (now) controller.setGeometry(pageKey, box.id, p.kind === "move" ? { x: now.x, y: now.y } : { w: now.w });
      if (!selected) controller.select(pageKey, box.id, false);
      return;
    }
    if (p.kind === "move") controller.select(pageKey, box.id, selected && !editing);
  };

  const onBoxKey = (e: KeyboardEvent) => {
    if (isImeComposing(e) || editing) return;
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); controller.removeBox(pageKey, box.id); }
    else if (e.key === "Enter") { e.preventDefault(); controller.select(pageKey, box.id, true); }
    else if (isEscapeKey(e)) { e.preventDefault(); controller.commit(); controller.clearSelection(); }
  };
  const onAreaKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeComposing(e)) return; // Enter / Esc / Ctrl+Z belong to the candidate list
    if (isEscapeKey(e)) { e.preventDefault(); e.currentTarget.blur(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      // The box keeps its own history: one step per typing burst.
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) controller.redo(); else controller.undo();
    }
  };
  const onAreaChange = (value: string, isComposing: boolean) => {
    if (isComposing || composing.current) setDraft(value);
    else { setDraft(null); controller.setText(pageKey, box.id, value); }
  };
  const onAreaBlur = () => {
    composing.current = false;
    setDraft(null);
    controller.commit();
    const now = controller.box(pageKey, box.id);
    if (!now || now.text.trim() === "") controller.clearSelection();
    else controller.select(pageKey, box.id, false);
  };

  return (
    <div
      className={classNames("page-text-box", interactive && "page-text-box--live", selected && "page-text-box--selected", editing && "page-text-box--editing")}
      data-page-text-box={box.id}
      data-ink-color={box.color}
      style={{
        "--ptb-left": px(box.x * scale), "--ptb-top": px(box.y * scale), "--ptb-width": px(box.w * scale),
        "--ptb-size": px(box.size * scale), "--ptb-color": box.color, "--ptb-align": box.align,
      } as CSSProperties}
      tabIndex={interactive && !editing ? 0 : -1}
      role={interactive ? "group" : undefined}
      aria-label={interactive ? t("Text box") : undefined}
      onPointerDown={onBoxDown}
      // A touch tap that opens a box is followed by mouse events on whatever is
      // now under the finger (the new box's grip): they must not take focus
      // from the text being typed. The caret itself (the textarea) is left alone.
      onMouseDown={keepFocus}
      onPointerMove={onPressMove}
      onPointerUp={onPressEnd}
      onPointerCancel={() => { press.current = null; }}
      onDoubleClick={() => { if (interactive) controller.select(pageKey, box.id, true); }}
      onKeyDown={onBoxKey}
    >
      {editing ? (
        <TextArea
          ref={area}
          className="page-text-input"
          value={draft ?? box.text}
          rows={1}
          spellCheck={false}
          aria-label={t("Text box")}
          onChange={(e) => onAreaChange(e.target.value, (e.nativeEvent as InputEvent).isComposing === true)}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={(e) => { composing.current = false; setDraft(null); controller.setText(pageKey, box.id, e.currentTarget.value); }}
          onKeyDown={onAreaKey}
          onBlur={onAreaBlur}
        />
      ) : (
        <div className="page-text-content">{box.text}</div>
      )}
      {editing && interactive && (
        <span
          className="page-text-grip"
          data-page-text-grip=""
          onPointerDown={(e) => startPress(e, { kind: "move", id: e.pointerId, x: e.clientX, y: e.clientY, box: { x: box.x, y: box.y }, moved: false })}
          onPointerMove={onPressMove}
          onPointerUp={onPressEnd}
          onPointerCancel={() => { press.current = null; }}
        />
      )}
      {selected && interactive && (
        <span
          className="page-text-resize"
          data-page-text-resize=""
          role="separator"
          aria-orientation="vertical"
          aria-label={t("Change width")}
          onPointerDown={onResizeDown}
          onPointerMove={onPressMove}
          onPointerUp={onPressEnd}
          onPointerCancel={() => { press.current = null; }}
        />
      )}
    </div>
  );
}
