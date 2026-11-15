import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { COLLAPSE_DRAG_OVERSHOOT, usePaneWidthState } from "../../lib/paneWidths";
import { capturePointer } from "../../lib/pointerDrag";

const KEY_STEP = 16;
const DRAGGING_CLASS = "onden-pane-dragging";

type Props = {
  /** The handle's own class beside `.pane-resizer`: where it sits is CSS. */
  className: string;
  label: string;
  /** The width the person chose; null = the stylesheet's, read off the pane. */
  width: number | null;
  min: number;
  max: number;
  /** Used until the pane has been measured. */
  fallback: number;
  /** 1: a pane on the left, dragging right widens it. -1: a pane on the right. */
  grows: 1 | -1;
  /** Room to leave for the column beside the pane, inside the pane's parent. */
  keepBeside?: number;
  onResize: (px: number) => void;
  /** Double-click: back to the default. */
  onReset: () => void;
  onDragStart?: () => void;
  /** A drag that ends COLLAPSE_DRAG_OVERSHOOT px below the minimum calls this; without it a drag stops at the minimum. */
  onFold?: () => void;
};

/**
 * The drag handle on a pane's inner edge, a direct child of the pane. Drag,
 * double-click and the arrow/Home/End keys all end in `onResize` or `onReset`.
 * Arrow keys move the handle's edge: → widens a pane on the left, ← one on the
 * right. Past the fold point the handle shows that letting go folds the pane.
 * The hosts are PaneResizer (the shell's side panes) and ColumnResizer (a
 * column inside a page).
 */
export default function PaneHandle({ className, label, width, min, max, fallback, grows, keepBeside, onResize, onReset, onDragStart, onFold }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startWidth: number; collapse: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [collapsing, setCollapsing] = useState(false);
  const [measured, setMeasured] = useState<number | null>(null);
  const [outer, setOuter] = useState(0);
  const { viewport } = usePaneWidthState();

  // With no chosen width the pane has its stylesheet width; read it off the pane.
  useLayoutEffect(() => {
    const pane = ref.current?.parentElement;
    const w = Math.round(pane?.getBoundingClientRect().width ?? 0);
    setMeasured(w > 0 ? w : null);
    setOuter(pane?.parentElement?.clientWidth ?? 0);
  }, [width, viewport]);
  useLayoutEffect(() => () => document.body.classList.remove(DRAGGING_CLASS), []);

  const now = width ?? measured ?? fallback;
  const widest = keepBeside !== undefined && outer > 0 ? Math.max(min, Math.min(max, outer - keepBeside)) : max;
  const commit = (px: number) => onResize(Math.max(min, Math.min(px, widest)));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    capturePointer(e.currentTarget, e.pointerId);
    drag.current = { startX: e.clientX, startWidth: now, collapse: false };
    onDragStart?.();
    document.body.classList.add(DRAGGING_CLASS);
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    const wanted = current.startWidth + (e.clientX - current.startX) * grows;
    current.collapse = !!onFold && wanted < min - COLLAPSE_DRAG_OVERSHOOT;
    setCollapsing(current.collapse);
    commit(wanted);
  };
  const endDrag = (fold = false) => {
    const folds = fold && drag.current?.collapse;
    drag.current = null;
    setCollapsing(false);
    if (folds) onFold?.();
    document.body.classList.remove(DRAGGING_CLASS);
    setDragging(false);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const toward = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (toward) commit(now + toward * grows * KEY_STEP);
    else if (e.key === "Home") commit(min);
    else if (e.key === "End") commit(widest);
    else return;
    e.preventDefault();
  };

  return (
    <div
      ref={ref}
      className={`pane-resizer ${className}`}
      role="separator" aria-orientation="vertical" tabIndex={0}
      aria-label={label}
      aria-valuenow={now} aria-valuemin={min} aria-valuemax={widest}
      data-dragging={dragging || undefined} data-collapsing={collapsing || undefined} data-customized={width !== null || undefined}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      onPointerUp={() => endDrag(true)} onPointerCancel={() => endDrag()} onLostPointerCapture={() => endDrag()}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
