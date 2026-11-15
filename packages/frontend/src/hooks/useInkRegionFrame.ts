import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { InkRegion } from "@onden/markdown/ink";
import { moveRegion, regionFromDrag, resizeRegion, type RegionCorner } from "../lib/inkRegionQuote";
import { capturePointer, DRAG_SLOP_PX } from "../lib/pointerDrag";
import { isPrimaryPress } from "../lib/pageText";

// The pointer work of the 「引用」 frame (components/page/InkRegionLayer): drag out a frame, pull a corner,
// move it. Which pointer may frame is the page's input policy: the pen and the mouse always do, a finger
// only when fingers draw (not "only scroll"), and a second finger is a pinch that drops the frame.

type Press =
  | { kind: "draw"; id: number; from: { x: number; y: number }; moved: boolean }
  | { kind: "move"; id: number; last: { x: number; y: number } }
  | { kind: "resize"; id: number; corner: RegionCorner };

export function useInkRegionFrame({ pageKey, pageSize, rootRef, stylusOnly, region, onRegionChange, onPenSeen }: {
  pageKey: string;
  pageSize: { width: number; height: number };
  rootRef: RefObject<HTMLElement | null>;
  stylusOnly: boolean;
  /** This page's frame, if it has one. */
  region: InkRegion | null;
  onRegionChange: (region: InkRegion | null) => void;
  /** The pen touched the screen (the page learns this is a pen device). */
  onPenSeen?: () => void;
}) {
  const press = useRef<Press | null>(null);
  const touches = useRef(new Set<number>());
  const [draft, setDraft] = useState<InkRegion | null>(null);
  const mine = region;

  const toUnits = useCallback((e: { clientX: number; clientY: number }) => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return { x: 0, y: 0 };
    return { x: ((e.clientX - rect.left) / rect.width) * pageSize.width, y: ((e.clientY - rect.top) / rect.height) * pageSize.height };
  }, [rootRef, pageSize.width, pageSize.height]);

  const fingerFrames = !stylusOnly;
  const onCaptureDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType === "pen") onPenSeen?.();
    if (e.pointerType === "touch") {
      touches.current.add(e.pointerId);
      if (touches.current.size > 1) { press.current = null; setDraft(null); return; } // a second finger: pinch
      if (!fingerFrames) return; // this finger scrolls
    }
    if (!isPrimaryPress(e)) return;
    press.current = { kind: "draw", id: e.pointerId, from: toUnits(e), moved: false };
    capturePointer(e.currentTarget, e.pointerId);
  };
  const onMove = (e: ReactPointerEvent<HTMLElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    const at = toUnits(e);
    if (p.kind === "draw") {
      const rect = rootRef.current?.getBoundingClientRect();
      const px = rect ? Math.hypot(((at.x - p.from.x) / pageSize.width) * rect.width, ((at.y - p.from.y) / pageSize.height) * rect.height) : 0;
      if (!p.moved && px < DRAG_SLOP_PX) return;
      p.moved = true;
      // While dragging the frame follows the pointer even below the smallest size; letting go decides.
      setDraft({ page: pageKey, x: Math.max(0, Math.min(p.from.x, at.x)), y: Math.max(0, Math.min(p.from.y, at.y)), w: Math.min(pageSize.width, Math.abs(at.x - p.from.x)), h: Math.min(pageSize.height, Math.abs(at.y - p.from.y)) });
    } else if (p.kind === "move" && mine) {
      onRegionChange(moveRegion(mine, at.x - p.last.x, at.y - p.last.y, pageSize));
      p.last = at;
    } else if (p.kind === "resize" && mine) {
      onRegionChange(resizeRegion(mine, p.corner, at, pageSize));
    }
  };
  const onUp = (e: ReactPointerEvent<HTMLElement>) => {
    touches.current.delete(e.pointerId);
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    press.current = null;
    if (p.kind !== "draw") return;
    setDraft(null);
    // A tap, or a frame too small to be meant, puts the old frame away: pressing elsewhere cancels.
    onRegionChange(p.moved ? regionFromDrag(pageKey, p.from, toUnits(e), pageSize) : null);
  };
  const onCancel = (e: ReactPointerEvent<HTMLElement>) => {
    touches.current.delete(e.pointerId);
    if (press.current?.id === e.pointerId) { press.current = null; setDraft(null); }
  };
  const startOn = (kind: "move" | "resize", corner?: RegionCorner) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType === "pen") onPenSeen?.();
    // "Only scroll" for fingers: a finger on the frame scrolls and pinches the page, it does not move or resize it.
    if (e.pointerType === "touch" && !fingerFrames) return;
    if (!isPrimaryPress(e) || !mine) return;
    e.stopPropagation();
    press.current = kind === "move" ? { kind, id: e.pointerId, last: toUnits(e) } : { kind, id: e.pointerId, corner: corner! };
    capturePointer(e.currentTarget, e.pointerId);
  };
  // Handles and the frame body keep the pointer they captured: route their events through the same handlers.
  const forward = { onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onCancel };
  return { draft, onCaptureDown, startOn, forward, fingerFrames };
}
