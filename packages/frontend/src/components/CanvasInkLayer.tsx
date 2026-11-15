import { isInkReadOnly, loadInkPage, notifyInkReadOnly } from "../lib/ink/store";
import { useReactFlow, useStore, useViewport } from "@xyflow/react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { BOARD_INK_ATTR, inkHasContent } from "@onden/markdown/ink";
import { createCommittedRenderer, type ICommittedRenderer } from "../lib/ink/committed";
import { InkEngine } from "../lib/ink/engine";
import { useDrawingRestoreSerial } from "../hooks/useDrawingRestoreSerial";
import { InkSaver, isEmptyInkClip, registerInkEdit, usePenShortcutTool, type InkClip, type InkSelection } from "../lib/ink";
import { flowInkTransform } from "../lib/ink/flowTransform";
import type { InkActiveTool, InkDocument } from "../lib/ink/types";
import type { BoardHistory } from "../hooks/useBoardHistory";
import InkToolbar from "./InkToolbar";
import PageMoreMenu from "./PageMoreMenu";
import { engineToolbarProps, useApplyPen, type useInkPen } from "../hooks/useInkPen";
import "./CanvasInkLayer.css";
import { classNames } from "../lib/utils";
import { DEFAULT_CARD_H, DEFAULT_CARD_W } from "../lib/cardGeometry";
import { useInkInputPrefs } from "../hooks/useInkInputPrefs";
import { observeSize } from "../lib/observeSize";
import { isDarkTheme, observeTheme } from "../lib/documentAccess";
import { pixelRatio } from "../lib/pageEnvironment";
import { onPageHide } from "../lib/pageHide";
import { capturePointer } from "../lib/pointerDrag";

// Ink layer over the knowledge canvas.
//
// Rendered as a CHILD of <ReactFlow> (so useViewport keeps it on the store),
// positioned over the pane, ABOVE the DOM nodes — ink-on-top semantics — and
// pointer-transparent except in pen mode (pdf.js updateMode pattern). Three
// surfaces, bottom-up:
//   1. committed strokes — ICommittedRenderer (tiled Canvas 2D). Strokes live in
//      CANVAS MODEL coords; pan/zoom copies cached tiles, and a zoom is
//      stretched until it pauses, never a re-tessellation per frame.
//   2. wet ink — always Canvas2D (one stroke, zero latency).
//   3. input capture div — routes pointers into InkEngine with the React
//      Flow viewport injected as the engine's InkTransform.
//
// Persistence: the note's `board_ink` attribute (not `ink_data`, which is its handwriting page) (same spine
// ATTRIBUTE_SET path as InkNodeView; engine debounces ~800ms + flush on
// unmount). The "All Cards" tab has no backing node — the host never mounts
// this layer there.
//
// Lazy: the engine boots on first pen activation or when an opened canvas
// already carries ink.


/** What the board asks of the ink on it: select by area, move or remove the
 *  selection together with the selected cards. Positions are board (flow) coordinates. */
export type CanvasInkHandle = {
  /** Select the strokes and shapes touching this rectangle; returns whether any. */
  selectIn: (rect: { x1: number; y1: number; x2: number; y2: number }) => boolean;
  clearSelection: () => void;
  moveSelection: (dx: number, dy: number) => void;
  removeSelection: () => boolean;
  /** A copy of the selected ink for the board's clipboard, or null when none is selected. */
  copySelection: () => InkClip | null;
  /** Add a copy of `clip` moved by (dx, dy) (board units) as new ink and select it.
   *  Each item registers in the board's history (call inside `history.batch`). False when nothing was added. */
  pasteClip: (clip: InkClip, dx: number, dy: number) => boolean;
};

type Props = {
  /** Node id of the backing canvas node (named canvases only). */
  canvasId: string;
  penActive: boolean;
  /** Spacebar held → temporary pan: the layer goes pointer-transparent and
   *  React Flow's left-drag pan takes over (tldraw's explicit spacebar-pan). */
  spaceHeld: boolean;
  /** The pen in hand (the board owns it: its keys and its toolbar share it). */
  pen: ReturnType<typeof useInkPen>;
  /** 「插入」 in the toolbar: the chosen pictures become image cards at this
   *  board position (the board's own upload-and-place, as for a dropped picture). */
  onInsertImages?: (files: File[], flowPos: { x: number; y: number }) => Promise<void>;
  /** The board's one history: every stroke, shape, erase and move registers there,
   *  and the toolbar's and fingers' undo/redo run through it too. */
  boardHistory: BoardHistory;
  /** Whether some ink is selected (the board's Delete key then removes it). */
  onSelectionChange?: (hasInk: boolean) => void;
};

const CanvasInkLayer = forwardRef<CanvasInkHandle, Props>(function CanvasInkLayer({
  canvasId, penActive, spaceHeld, pen, onInsertImages, boardHistory: board, onSelectionChange,
}, handleRef) {
  const { tool, setTool } = pen;
  const onToolChange = useCallback((next: InkActiveTool) => setTool(next), [setTool]);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const wetRef = useRef<HTMLCanvasElement | null>(null);
  const captureRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<InkEngine | null>(null);
  const rendererRef = useRef<ICommittedRenderer | null>(null);
  const disposePointersRef = useRef<(() => void) | null>(null);
  const darkRef = useRef(false);
  const initStartedRef = useRef(false);

  const reactFlow = useReactFlow();
  const viewport = useViewport();
  const vpRef = useRef(viewport);
  vpRef.current = viewport; // keep the engine's transform live mid-render
  const minZoom = useStore((s) => s.minZoom);
  const maxZoom = useStore((s) => s.maxZoom);

  // undefined = still loading; null = no board_ink yet (empty doc).
  const [doc, setDoc] = useState<InkDocument | null | undefined>(undefined);
  const [rendererKind, setRendererKind] = useState<"canvas2d" | null>(null);
  const [engineReady, setEngineReady] = useState(false);
  const boardRef = useRef(board);
  boardRef.current = board;
  // The selected ink, and a counter that moves the box when the drawing changes under it.
  const [selection, setSelection] = useState<InkSelection | null>(null);
  const selectionRef = useRef<InkSelection | null>(null);
  const [, setDrawingRev] = useState(0);
  const changeSelection = useCallback((next: InkSelection | null) => {
    selectionRef.current = next;
    setSelection(next);
    onSelectionChange?.(next !== null);
  }, [onSelectionChange]);
  const input = useInkInputPrefs();
  const inputRef = useRef(input);
  useEffect(() => { inputRef.current = input; }, [input]);
  // Zoom limits for the pinch gesture, read live by the engine callbacks.
  const zoomLimitsRef = useRef({ minZoom, maxZoom });
  zoomLimitsRef.current = { minZoom, maxZoom };
  const toolRef = useRef(tool);
  // Stable, so the engine (built in an async effect) can hold it (S Pen side button).
  const onPenShortcut = usePenShortcutTool(tool, onToolChange);

  // ── Load the canvas node's ink doc (canvas switch remounts via key) ──────
  // lib/ink/store decides server vs local mirror (the mirror while strokes are
  // still queued, so a reconnect can't load an older copy over them).
  // The saver (lib/ink/surfaceSaver) remembers which drawing the next save is made from: the server merges a save into
  // what another device stored meanwhile.
  const inkSaver = useRef<InkSaver | null>(null);
  inkSaver.current ??= new InkSaver(BOARD_INK_ATTR);
  // A version put back from History: the pen layer loads it again, into the engine when it is already running.
  const drawingRestored = useDrawingRestoreSerial(canvasId);
  useEffect(() => {
    let cancelled = false;
    void loadInkPage(canvasId, BOARD_INK_ATTR).then((page) => {
      if (cancelled) return;
      inkSaver.current!.rebase(canvasId, page);
      engineRef.current?.load(page);
      // Made with a newer version: the engine shows it and refuses edits, and
      // saveInk would not write it; tell the person once.
      if (isInkReadOnly(page)) notifyInkReadOnly();
      setDoc(page);
    });
    return () => { cancelled = true; };
  }, [canvasId, drawingRestored]);

  // Ink saves ride the spine ATTRIBUTE_SET path on the CANVAS NODE — exactly
  // the route InkNodeView's parent uses, so event-log undo / inbox governance
  // come for free. The engine already debounced; persist immediately.
  // saveInk: mirrors locally + queues when offline (or on a
  // transient/5xx) so an offline stroke survives to the reconnect drain; a 4xx
  // surfaces a toast (definitive rejection — can't cleanly roll back strokes
  // mid-session). Replaces the raw fetch that silently dropped offline saves.
  const leavingRef = useRef(false);
  const persist = useCallback((next: InkDocument) => {
    inkSaver.current!.save(canvasId, next, leavingRef.current ? { keepalive: true } : undefined);
  }, [canvasId]);
  const persistRef = useRef(persist);
  useEffect(() => { persistRef.current = persist; }, [persist]);

  const currentView = useCallback(() => {
    const vp = vpRef.current;
    return {
      dark: darkRef.current,
      scale: vp.zoom,
      offsetX: vp.x,
      offsetY: vp.y,
      dpr: pixelRatio(),
    };
  }, []);

  const sizeWetCanvas = useCallback((cssW: number, cssH: number, dpr: number) => {
    const wet = wetRef.current;
    if (!wet) return;
    wet.width = Math.max(1, Math.round(cssW * dpr));
    wet.height = Math.max(1, Math.round(cssH * dpr));
    wet.style.width = `${Math.round(cssW)}px`;
    wet.style.height = `${Math.round(cssH)}px`;
  }, []);

  // ── Lazy boot: first pen activation OR an opened canvas that has ink ─────
  const wantInk = penActive || (doc != null && inkHasContent(doc));
  useEffect(() => {
    if (!wantInk || initStartedRef.current || doc === undefined) return;
    initStartedRef.current = true;
    const layer = layerRef.current;
    const surface = surfaceRef.current;
    const wet = wetRef.current;
    const capture = captureRef.current;
    if (!layer || !surface || !wet || !capture) { initStartedRef.current = false; return; }
    const rect = layer.getBoundingClientRect();
    const dpr = pixelRatio();

    const renderer = createCommittedRenderer({
      container: surface, cssWidth: rect.width, cssHeight: rect.height, dpr,
    });
    rendererRef.current = renderer;
    darkRef.current = isDarkTheme();
    sizeWetCanvas(rect.width, rect.height, dpr);

    const engine = new InkEngine({
      committedRenderer: renderer,
      wetCanvas: wet,
      transform: flowInkTransform(() => vpRef.current),
      manageCanvasSize: false,
      // Same finger rules as the handwriting page (inputPolicy.ts): a drawing
      // tool draws with 1 finger, the Hand tool pans the board with it,
      // 2 fingers pinch-zoom it, and 2-/3-finger taps undo / redo. Only
      // while pen mode captures input; otherwise React Flow handles touch
      // as before.
      gestures: {
        pan: (dx, dy) => {
          const vp = vpRef.current;
          const next = { x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom };
          vpRef.current = next; // the next frame builds on this one
          void reactFlow.setViewport(next);
        },
        zoom: (factor, clientX, clientY) => {
          const rect = layer.getBoundingClientRect();
          const px = clientX - rect.left;
          const py = clientY - rect.top;
          const vp = vpRef.current;
          const { minZoom: lo, maxZoom: hi } = zoomLimitsRef.current;
          const zoom = Math.min(hi, Math.max(lo, vp.zoom * factor));
          const k = zoom / vp.zoom;
          const next = { x: px - (px - vp.x) * k, y: py - (py - vp.y) * k, zoom };
          vpRef.current = next;
          void reactFlow.setViewport(next);
        },
      },
      stylusOnly: inputRef.current.stylusOnly,
      penDraws: inputRef.current.penDraws,
      onPenSeen: () => inputRef.current.onPenSeen(),
      onPenShortcut,
      onChange: (d) => persistRef.current(d),
      // One history for the whole board: the engine reports each new edit; undo and
      // redo (keys, toolbar, finger taps) all go through the board's history.
      onRecord: (op) => registerInkEdit(boardRef.current, () => engineRef.current, op),
      onUndoRequest: () => void boardRef.current.undo(),
      onRedoRequest: () => void boardRef.current.redo(),
      onHistoryChange: () => setDrawingRev((n) => n + 1),
    });
    engineRef.current = engine;
    engine.setDarkMode(darkRef.current);
    engine.load(doc);
    engine.setTool(toolRef.current);
    disposePointersRef.current = engine.addPointerHandlers(capture);
    setRendererKind(renderer.kind);
    setEngineReady(true);
  }, [wantInk, doc, currentView, sizeWetCanvas, reactFlow, onPenShortcut]);

  // The device's finger or pen setting changed (lib/inkInputPrefs).
  useEffect(() => {
    engineRef.current?.setInputPrefs({ stylusOnly: input.stylusOnly, penDraws: input.penDraws });
  }, [input.stylusOnly, input.penDraws, engineReady]);

  useApplyPen(() => engineRef.current, pen, engineReady);

  // Teardown on unmount (canvas switch / leaving the canvas lens): flush the
  // debounced save first so the last strokes never die in the timer.
  useEffect(() => () => {
    engineRef.current?.flush();
    disposePointersRef.current?.();
    disposePointersRef.current = null;
    engineRef.current?.destroy();
    engineRef.current = null;
    rendererRef.current?.destroy();
    rendererRef.current = null;
  }, []);

  // The page going away (close, navigate, a phone switching apps) must not take strokes still
  // waiting for the engine's debounce: save them now, as a save that outlives the page (the same
  // leaving save as the handwriting page and the PDF).
  useEffect(() => onPageHide(() => {
    leavingRef.current = true;
    try { engineRef.current?.flush(); } finally { leavingRef.current = false; }
  }), []);

  // ── Tool / color / size sync (toolbar + P/E keys live in the workspace) ──
  useEffect(() => {
    toolRef.current = tool;
    engineRef.current?.setTool(tool);
  }, [tool]);

  // ── Viewport sync: camera-only update, no re-tessellation ────────────────
  useEffect(() => {
    if (!engineReady) return;
    rendererRef.current?.setView(currentView());
  }, [viewport.x, viewport.y, viewport.zoom, engineReady, currentView]);

  // ── Pane resize → resize surfaces, repaint from cache ────────────────────
  useEffect(() => {
    if (!engineReady) return;
    const layer = layerRef.current;
    if (!layer) return;
    return observeSize(layer, () => {
      const rect = layer.getBoundingClientRect();
      const dpr = pixelRatio();
      rendererRef.current?.resize(rect.width, rect.height, dpr);
      sizeWetCanvas(rect.width, rect.height, dpr);
      rendererRef.current?.setView(currentView());
    });
  }, [engineReady, currentView, sizeWetCanvas]);

  // ── Theme: stored colors stay canonical, render-time HSL inversion ───────
  useEffect(() => {
    if (!engineReady) return;
    return observeTheme(() => {
      darkRef.current = isDarkTheme();
      engineRef.current?.setDarkMode(darkRef.current);
    });
  }, [engineReady]);

  // ── Wheel in pen mode: the capture div swallows React Flow's zoom, so
  //    mirror it (zoom around the cursor, clamped to the store's limits) ────
  useEffect(() => {
    const el = captureRef.current;
    if (!el || !penActive) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const layer = layerRef.current;
      if (!layer) return;
      const rect = layer.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const vp = vpRef.current;
      const factor = Math.pow(2, -e.deltaY * ((e.ctrlKey || e.metaKey) ? 0.01 : 0.002));
      const zoom = Math.min(maxZoom, Math.max(minZoom, vp.zoom * factor));
      const k = zoom / vp.zoom;
      reactFlow.setViewport({ x: px - (px - vp.x) * k, y: py - (py - vp.y) * k, zoom });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [penActive, reactFlow, minZoom, maxZoom]);

  // ── Selection by area ─────────────────────────────────────────────────────
  useImperativeHandle(handleRef, () => ({
    selectIn: ({ x1, y1, x2, y2 }) => {
      const found = engineRef.current?.itemsInRect({ x1, y1, x2, y2 });
      const any = !!found && (found.strokeIds.length > 0 || found.shapeIds.length > 0);
      changeSelection(any ? found : null);
      return any;
    },
    clearSelection: () => { if (selectionRef.current) changeSelection(null); },
    moveSelection: (dx, dy) => { if (selectionRef.current) engineRef.current?.moveItems(selectionRef.current, dx, dy); },
    removeSelection: () => {
      const picked = selectionRef.current;
      if (!picked) return false;
      engineRef.current?.removeItems(picked);
      changeSelection(null);
      return true;
    },
    copySelection: () => {
      const picked = selectionRef.current;
      const clip = picked && engineRef.current ? engineRef.current.copyItems(picked) : null;
      return isEmptyInkClip(clip) ? null : clip;
    },
    pasteClip: (clip, dx, dy) => {
      const added = engineRef.current?.pasteClip(clip, dx, dy) ?? null;
      if (added) changeSelection(added);
      return !!added;
    },
  }), [changeSelection]);

  // Pen mode draws; it does not select.
  useEffect(() => { if (penActive && selectionRef.current) changeSelection(null); }, [penActive, changeSelection]);

  const box = selection && engineRef.current?.selectionBounds(selection);
  // Dragging the box moves only the ink; cards move by their own drag.
  const dragBox = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const picked = selectionRef.current;
    if (!picked || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    capturePointer(el, e.pointerId);
    const startX = e.clientX, startY = e.clientY;
    const move = (ev: PointerEvent) => { el.style.transform = `translate(${ev.clientX - startX}px, ${ev.clientY - startY}px)`; };
    const up = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.style.transform = "";
      if (ev.type === "pointerup") {
        const zoom = vpRef.current.zoom || 1;
        engineRef.current?.moveItems(picked, (ev.clientX - startX) / zoom, (ev.clientY - startY) / zoom);
      }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }, []);

  // Pictures go in the middle of what is on screen; the card's top-left is half a card back.
  const [inserting, setInserting] = useState(false);
  const insertImages = onInsertImages && ((files: File[]) => {
    const rect = layerRef.current?.getBoundingClientRect();
    const middle = reactFlow.screenToFlowPosition({ x: (rect?.left ?? 0) + (rect?.width ?? 0) / 2, y: (rect?.top ?? 0) + (rect?.height ?? 0) / 2 });
    setInserting(true);
    void onInsertImages(files, { x: middle.x - DEFAULT_CARD_W / 2, y: middle.y - DEFAULT_CARD_H / 2 }).finally(() => setInserting(false));
  });
  const capturing = penActive && !spaceHeld;

  return (
    <div
      ref={layerRef}
      className={classNames("canvas-ink-layer", capturing && "canvas-ink-layer--capturing")}
      data-ink-renderer={rendererKind ?? undefined}
      data-ink-canvas={canvasId}
    >
      <div ref={surfaceRef} className="canvas-ink-surface" />
      {box && (
        <div
          className="canvas-ink-selection"
          data-testid="ink-selection"
          style={{
            "--ink-sel-x": `${viewport.x + box.x1 * viewport.zoom - 4}px`,
            "--ink-sel-y": `${viewport.y + box.y1 * viewport.zoom - 4}px`,
            "--ink-sel-w": `${(box.x2 - box.x1) * viewport.zoom + 8}px`,
            "--ink-sel-h": `${(box.y2 - box.y1) * viewport.zoom + 8}px`,
          } as React.CSSProperties}
          onPointerDown={dragBox}
        />
      )}
      <canvas ref={wetRef} className="canvas-ink-wet" />
      <div
        ref={captureRef}
        className={classNames(
          "canvas-ink-capture",
          tool === "eraser" && "canvas-ink-capture--eraser",
          tool === "hand" && "canvas-ink-capture--hand",
        )}
      />
      {penActive && (
        <InkToolbar
          className="canvas-ink-toolbar"
          tool={tool}
          onToolChange={onToolChange}
          {...pen.toolbar}
          {...engineToolbarProps(() => engineRef.current, board)}
          onUndo={() => void board.undo()}
          onRedo={() => void board.redo()}
          trailing={<PageMoreMenu fingerDraws={!input.stylusOnly} onToggleFingerDraws={input.toggleFingerDraws} />}
          insert={insertImages ? { onFiles: insertImages, busy: inserting } : undefined}
        />
      )}
    </div>
  );
});

export default CanvasInkLayer;
