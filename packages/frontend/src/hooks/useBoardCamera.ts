import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import type { FitViewOptions, Node, ReactFlowInstance } from "@xyflow/react";
import { readViewport, writeViewport } from "../lib/canvasViewport";
import { DEFAULT_CARD_W } from "../lib/cardGeometry";
import { FOCUS_ZOOM } from "../lib/cardDisplay";
import { observeSize } from "../lib/observeSize";
import { flingVelocity, pushFlingSample, startGlide, type FlingSample } from "../lib/ink";

type Options = {
  rfInstance: ReactFlowInstance | null;
  boardId: string | null;
  /** The app's focused node; a card focused from elsewhere is brought into view. */
  selectedNodeId: string | null;
  /** The nodes the board currently shows (positions and saved sizes). */
  displayNodes: Node[];
  /** The board's container, watched while a card is edited. */
  wrapRef: RefObject<HTMLDivElement | null>;
  /** How the first fit leaves room for the controls floating over the board. */
  fitOptions: FitViewOptions;
};

/**
 * Where the whiteboard camera points, and when it moves on its own.
 *
 * - Each board reopens at the viewport it was left at (per session); only a
 *   board without one fits to its content: `fitOnOpen` for the cards there at
 *   the first render, and once more when its first cards arrive later (the
 *   sub-note tree is drawn from notes that may not have loaded yet).
 * - A card focused from outside the board (tree, graph, palette) is centred
 *   once; later content or display updates keep the camera where it is.
 * - A card clicked on the board stays where it is. A title clicked in far zoom
 *   (titles only) zooms to about 90% with that card centred (`focusCard`).
 * - Starting to edit a card centres it at 1× or more, and keeps it centred
 *   while the board resizes (a phone keyboard) until the edit ends.
 *
 * - Letting go of a fast drag keeps the board gliding (the handwriting page's
 *   glide, lib/ink/glide). A new touch, a wheel turn, a card drag or any
 *   camera move of the app's own stops it; the viewport is saved once, when
 *   the glide ends.
 *
 * The camera never writes board geometry: display sizes stay display-only.
 */
export function useBoardCamera({ rfInstance, boardId, selectedNodeId, displayNodes, wrapRef, fitOptions }: Options) {
  // Browsing keeps the chosen overview scale; beginning an edit explicitly
  // asks for readable text. Both use the same camera operation.
  const centerCardForReading = useCallback((node: Node, minimumZoom = 0) => {
    if (!rfInstance) return;
    const w = typeof node.style?.width === "number" ? node.style.width : DEFAULT_CARD_W;
    const h = typeof node.style?.height === "number" ? node.style.height : 120;
    void rfInstance.setCenter(node.position.x + w / 2, node.position.y + h / 2, {
      zoom: Math.max(rfInstance.getZoom(), minimumZoom), duration: 280,
    });
  }, [rfInstance]);
  // The selection the camera has already dealt with, so the follow effect
  // below does not move it again (or undo an explicit edit zoom).
  const centeredSelection = useRef<{ canvasId: string | null; nodeId: string } | null>(null);

  const onNodeEditStart = useCallback((nodeId: string) => {
    const node = rfInstance?.getNode(nodeId);
    if (!node || node.type !== "card") return;
    // A pending selection effect must not move the camera back to the
    // overview scale after this explicit edit intent.
    centeredSelection.current = { canvasId: boardId, nodeId };
    centerCardForReading(node, 1);
    const wrap = wrapRef.current;
    if (!wrap) return;
    let { width, height } = wrap.getBoundingClientRect();
    let frame: number | undefined;
    const stopObserving = observeSize(wrap, ([entry]) => {
      if (!entry || (entry.contentRect.width === width && entry.contentRect.height === height)) return;
      ({ width, height } = entry.contentRect);
      if (frame !== undefined) cancelAnimationFrame(frame);
      // Let React Flow receive the new viewport dimensions before centring.
      frame = requestAnimationFrame(() => {
        const current = rfInstance?.getNode(nodeId);
        if (current?.type === "card") centerCardForReading(current, 1);
      });
    });
    return () => { stopObserving(); if (frame !== undefined) cancelAnimationFrame(frame); };
  }, [rfInstance, boardId, centerCardForReading, wrapRef]);

  /** A card was clicked where it is on the board. Selecting it (or adding it to
   *  a selection) never moves the board — it used to slide the cards already
   *  picked under the tools and the minimap. */
  const cardClicked = useCallback((node: Node) => {
    centeredSelection.current = { canvasId: boardId, nodeId: node.id };
  }, [boardId]);

  /** A click on a title in far zoom (titles only): about 90%, the card centred. */
  const focusCard = useCallback((nodeId: string) => {
    const node = rfInstance?.getNode(nodeId);
    if (!rfInstance || !node) return;
    centeredSelection.current = { canvasId: boardId, nodeId };
    centerCardForReading(node, FOCUS_ZOOM);
  }, [rfInstance, boardId, centerCardForReading]);

  // P0-5 縮放定位: restore the canvas's last viewport (zoom + pan) instead of
  // re-fitting every open — fitView stays the cold-start fallback. Same
  // sessionStorage pattern as the editor's caret restore (navPosition).
  //
  // Restore is DETERMINISTIC (no setTimeout racing fitView): the same value
  // gates the `fitView` prop (auto-fit is off when we'll restore) and drives
  // the restore effect, so the two are mutually exclusive instead of racing.
  const hasStash = useMemo(() => readViewport(boardId) != null, [boardId]);
  // Runs the moment the instance + canvas are known — both for cold mount
  // (onInit sets rfInstance) and canvas-to-canvas switch (the board isn't
  // remounted, so this effect is the restore path).
  useEffect(() => {
    if (!rfInstance) return;
    const stash = readViewport(boardId);
    if (stash) void rfInstance.setViewport(stash);
  }, [boardId, rfInstance]);

  const fittedBoard = useRef<string | null>(null);
  const fitOptionsRef = useRef(fitOptions);
  fitOptionsRef.current = fitOptions;
  const hasCards = displayNodes.length > 0;
  useEffect(() => {
    if (!rfInstance || !boardId || hasStash || !hasCards || fittedBoard.current === boardId) return;
    fittedBoard.current = boardId;
    void rfInstance.fitView({ ...fitOptionsRef.current, duration: 0 });
  }, [rfInstance, boardId, hasStash, hasCards]);

  const saveViewport = useCallback(() => {
    if (!rfInstance || !boardId) return;
    writeViewport(boardId, rfInstance.getViewport());
  }, [rfInstance, boardId]);

  // ── Glide after a fast drag ─────────────────────────────────────────────
  // setViewport (duration 0) fires move start/move/end synchronously; those
  // are the glide's own frames, not a new gesture, so `stepping` ignores them.
  const stopGlideRef = useRef<(() => void) | null>(null);
  const stepping = useRef(false);
  const trail = useRef<FlingSample[]>([]);
  const gestureZoom = useRef(1);
  /** Stop a glide in progress. The place it came to rest is the one end-of-move save. */
  const stopGlide = useCallback(() => {
    const stop = stopGlideRef.current;
    if (!stop) return;
    stopGlideRef.current = null;
    stop();
    saveViewport();
  }, [saveViewport]);
  useEffect(() => stopGlide, [stopGlide]);

  const onMoveStart = useCallback((_event: unknown, viewport: { zoom: number }) => {
    if (stepping.current) return;
    stopGlide();
    trail.current = [];
    gestureZoom.current = viewport.zoom;
  }, [stopGlide]);
  const onMove = useCallback((event: MouseEvent | TouchEvent | null, viewport: { x: number; y: number }) => {
    if (stepping.current || !event) return;
    pushFlingSample(trail.current, performance.now(), viewport.x, viewport.y);
  }, []);
  const onMoveEnd = useCallback((event: MouseEvent | TouchEvent | null, viewport: { zoom: number }) => {
    if (stepping.current) return;
    // React Flow reports the end of each glide frame after the fact (stepping is over by then): not a gesture end.
    if (!event && stopGlideRef.current) return;
    // Only a finger, pen or mouse drag glides: not a wheel turn, a pinch or a move the app made.
    const dragged = !!event && event.type !== "wheel" && viewport.zoom === gestureZoom.current;
    const speed = dragged && rfInstance ? flingVelocity(trail.current, performance.now()) : null;
    trail.current = [];
    if (!speed || !rfInstance) { saveViewport(); return; }
    // The trail holds the view's own movement, so it glides on at that velocity.
    let finished = false;
    const stop = startGlide(speed.vx, speed.vy, (dx, dy) => {
      const now = rfInstance.getViewport();
      stepping.current = true;
      try { void rfInstance.setViewport({ x: now.x - dx, y: now.y - dy, zoom: now.zoom }); } finally { stepping.current = false; }
      return true;
    }, () => { finished = true; stopGlideRef.current = null; saveViewport(); });
    if (!finished) stopGlideRef.current = stop; // reduced motion finishes before it begins

  }, [rfInstance, saveViewport]);

  // Stash on unmount / canvas switch too: switching away unmounts the board
  // before any move-end fires on a freshly-restored canvas, so a move-end-only
  // save would lose the viewport set by the previous visit. Persist whatever
  // the camera shows when this canvas goes away.
  useEffect(() => {
    if (!rfInstance || !boardId) return;
    const inst = rfInstance;
    const id = boardId;
    return () => { writeViewport(id, inst.getViewport()); };
  }, [rfInstance, boardId]);

  // ── Three-view selection sync: pan the canvas to the selected card ──────
  // When the focused node changes (typically from the tree or global graph),
  // center on its card. Compact overview selections open at a readable scale.
  // Later display or content updates keep the current camera; explicit Fit
  // still shows the map.
  useEffect(() => {
    if (!rfInstance || !selectedNodeId) { centeredSelection.current = null; return; }
    if (centeredSelection.current?.canvasId === boardId && centeredSelection.current.nodeId === selectedNodeId) return;
    const node = displayNodes.find((n) => n.id === selectedNodeId);
    if (!node) return;
    centeredSelection.current = { canvasId: boardId, nodeId: selectedNodeId };
    centerCardForReading(node);
  }, [selectedNodeId, rfInstance, displayNodes, boardId, centerCardForReading]);

  return { fitOnOpen: !hasStash, onMoveStart, onMove, onMoveEnd, stopGlide, onNodeEditStart, cardClicked, focusCard };
}
