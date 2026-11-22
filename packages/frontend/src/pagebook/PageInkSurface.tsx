// The interactive ink surface of one page: the host-agnostic ink engine over one page box,
// mounted into the page (a PDF page's overlay, a notebook page). It opts back into pointer events
// (a PDF's overlay itself is pointer-events:none), so while it is up it blocks text selection.
//
// The engine's document is the page itself, in page units (1000 wide, the handwriting page's own
// format): the transform maps the page box's px to units (scale = page width / 1000), the page's
// stored drawing is loaded as is, and `serialize()` is the page to save. That is what lets the
// eraser and undo reach strokes from earlier sessions. The page-awareness lives in the mounting —
// one engine per page, registered with the host's InkPageSession.
//
// Tool, colour, size and the stylus switch change on the live engine, and a zoom only moves the
// transform and repaints (a rebuild would drop the undo stack); only a different page or session
// rebuilds it.
//
// Only pages on or near the screen get an engine. Each one holds two page-sized canvases at
// device resolution (about 5 MP each on a tablet); pdf.js keeps ~10 pages rendered, and 20 such
// layers (125 MP, measured on a Galaxy Tab) made finger scrolling stutter in the compositor. A
// page that scrolls away hands its edits to the session (detach) and drops its canvases;
// meanwhile its drawing shows as PageInkSvg (`onLiveChange`).

import { useCallback, useEffect, useRef } from "react";
import { INK_PAGE_UNITS, type InkDocument } from "@onden/markdown/ink";
import {
  InkEngine, cappedPixelRatio, onPointerEnd, pixelRatio, useNearScreen,
  type InkActiveTool, type InkGestureHost, type InkShapeFill, type InkShapeKind, type PageSurfaceSession,
} from "../lib/ink";
import "./PageInk.css";

/** The eraser's radius on screen, as it was when a PDF page was drawn in px. */
const ERASER_RADIUS_PX = 12;

export interface PageInkSurfaceProps {
  pageKey: string;
  /** The page box on screen, in px (it changes with zoom). */
  box: { width: number; height: number };
  session: PageSurfaceSession;
  /** The page's drawing as it is now (read once, at mount). */
  getDoc: () => InkDocument | null;
  /** Selector of the scroller the page is in: near-screen is measured against it. */
  scrollerSelector: string;
  tool: InkActiveTool;
  color: string;
  /** The pen's size: px on screen when `penSize` is "screen" (a PDF page: the toolbar's sizes mean px
   *  at any zoom, and the eraser keeps its size too), page units when "page" (a notebook sheet:
   *  strokes scale with the paper). */
  size: number;
  penSize: "screen" | "page";
  /** What the shape tool draws, and whether a pen held still makes a shape. */
  shapeKind: InkShapeKind;
  shapeFill: InkShapeFill;
  autoShape: boolean;
  /** The device's finger and pen settings (lib/inkInputPrefs). */
  stylusOnly: boolean;
  penDraws: boolean;
  /** A pen touched this page for the first time (switches a new device into pen mode). */
  onPenSeen: () => void;
  /** The S Pen side button was pressed (ink/penShortcut.ts). */
  onPenShortcut: () => void;
  /** Pen / mouse drags with the Hand tool scroll the book. */
  gestures: InkGestureHost;
  /** This page's engine came (true) or went (false): its drawing is on the canvases while it
   *  lives, so the SVG copy must hide meanwhile. */
  onLiveChange?: (pageKey: string, live: boolean) => void;
  /** The surface element, for a layer over the page that needs to hear its taps (a text tool). */
  onHost?: (host: HTMLElement | null) => void;
}

const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));

/** Size the page's two canvases to its box at device resolution, within the
 *  per-canvas limit iOS enforces. */
function sizeCanvases(host: HTMLElement, canvases: HTMLCanvasElement[], ratioRef: { current: number }): void {
  const cssW = host.clientWidth;
  const cssH = host.clientHeight;
  ratioRef.current = cappedPixelRatio(cssW, cssH, pixelRatio());
  for (const canvas of canvases) {
    canvas.width = Math.max(1, Math.round(cssW * ratioRef.current));
    canvas.height = Math.max(1, Math.round(cssH * ratioRef.current));
  }
}

export function PageInkSurface({
  pageKey, box, session, getDoc, scrollerSelector, tool, color, size, penSize, shapeKind, shapeFill, autoShape,
  stylusOnly, penDraws, onPenSeen, onPenShortcut, gestures, onLiveChange, onHost,
}: PageInkSurfaceProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const committedRef = useRef<HTMLCanvasElement | null>(null);
  const wetRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<InkEngine | null>(null);
  // px per page unit now, and the backing-store ratio the canvases were sized
  // with: the engine reads both live, so a zoom needs no new engine.
  const scaleRef = useRef(box.width / INK_PAGE_UNITS);
  scaleRef.current = box.width / INK_PAGE_UNITS;
  const heightRatio = useRef(box.height / box.width);
  heightRatio.current = box.height / box.width;
  const ratioRef = useRef(1);
  // Latest props for the engine built once below.
  const live = useRef({ tool, color, size, penSize, shapeKind, shapeFill, autoShape, stylusOnly, penDraws, onPenSeen, onPenShortcut, gestures, getDoc });
  live.current = { tool, color, size, penSize, shapeKind, shapeFill, autoShape, stylusOnly, penDraws, onPenSeen, onPenShortcut, gestures, getDoc };
  const onLiveChangeRef = useRef(onLiveChange);
  onLiveChangeRef.current = onLiveChange;
  const onHostRef = useRef(onHost);
  onHostRef.current = onHost;
  const setHost = useCallback((el: HTMLDivElement | null) => {
    hostRef.current = el;
    onHostRef.current?.(el);
  }, []);
  const near = useNearScreen(hostRef, scrollerSelector);
  const engineSize = (px: number) => (live.current.penSize === "screen" ? px / scaleRef.current : px);

  useEffect(() => {
    const host = hostRef.current;
    const committed = committedRef.current;
    const wet = wetRef.current;
    if (!host || !near || !committed || !wet) return;
    const canvases = [committed, wet];
    sizeCanvases(host, canvases, ratioRef);
    const screenPen = live.current.penSize === "screen";
    const engine = new InkEngine({
      committedCanvas: committed,
      wetCanvas: wet,
      manageCanvasSize: false, // surfaces are sized here, from the page box
      // Kept on the page: a stroke dragged past an edge (the pointer is captured) runs along it, so a
      // sheet never holds ink outside itself — a handwriting note's first page is as tall as its ink
      // (notePages), and would grow by the overshoot every time it is opened.
      transform: {
        toDoc: (x, y) => [
          clamp(x / scaleRef.current, INK_PAGE_UNITS),
          // Rounded: the ratio comes back from px with float noise (1400.0000000000002), and
          // notePages rounds a page's height up.
          clamp(y / scaleRef.current, Math.round(INK_PAGE_UNITS * heightRatio.current * 1000) / 1000),
        ],
        scale: () => scaleRef.current,
      },
      pixelRatio: () => ratioRef.current,
      ...(screenPen ? { eraserRadius: () => ERASER_RADIUS_PX / scaleRef.current } : {}),
      gestures: {
        pan: (dx, dy) => live.current.gestures.pan(dx, dy),
        zoom: (factor, x, y) => live.current.gestures.zoom(factor, x, y),
        fling: (vx, vy) => live.current.gestures.fling?.(vx, vy),
      },
      // Fingers that don't draw scroll natively; the book's touch layer
      // pinches (lib/ink/touchSplit.ts).
      nativeTouch: true,
      stylusOnly: live.current.stylusOnly,
      penDraws: live.current.penDraws,
      onPenSeen: () => live.current.onPenSeen(),
      onPenShortcut: () => live.current.onPenShortcut(),
      onHistoryChange: () => session.historyChanged(),
      // Strokes are saved while drawing mode stays on, about a second after
      // the pen lifts (the session commits them).
      onChange: () => session.strokesChanged(),
      changeDebounceMs: 1000,
    });
    engineRef.current = engine;
    engine.setTool(live.current.tool);
    engine.setColor(live.current.color);
    engine.setSize(engineSize(live.current.size));
    engine.setShapeKind(live.current.shapeKind);
    engine.setShapeFill(live.current.shapeFill);
    engine.setAutoShape(live.current.autoShape);
    engine.load(live.current.getDoc());
    const disposePointers = engine.addPointerHandlers(host);
    const onDown = () => { session.pointerDown(); session.touched(pageKey); };
    const onUp = () => session.pointerUp();
    // A drawing surface has no long-press menu (Chrome offers to download the
    // canvas as an image); the side button's own menu is the engine's.
    const noMenu = (e: Event) => e.preventDefault();
    host.addEventListener("contextmenu", noMenu);
    host.addEventListener("pointerdown", onDown);
    const stopUp = onPointerEnd(onUp);
    session.attach(pageKey, engine, heightRatio.current);
    onLiveChangeRef.current?.(pageKey, true);
    return () => {
      host.removeEventListener("contextmenu", noMenu);
      host.removeEventListener("pointerdown", onDown);
      stopUp();
      session.detach(pageKey, engine);
      disposePointers();
      engine.destroy();
      engineRef.current = null;
      onLiveChangeRef.current?.(pageKey, false);
    };
  }, [pageKey, session, near]);

  useEffect(() => { engineRef.current?.setTool(tool); }, [tool]);
  useEffect(() => { engineRef.current?.setColor(color); }, [color]);
  // A zoom: the page box changed size. Canvases, transform and pen size follow;
  // the engine, its history and the drawing stay.
  useEffect(() => {
    const host = hostRef.current;
    const engine = engineRef.current;
    if (!host || !engine) return;
    sizeCanvases(host, [committedRef.current, wetRef.current].filter((c): c is HTMLCanvasElement => c !== null), ratioRef);
    engine.setSize(engineSize(size));
    engine.viewChanged();
  }, [box.width, box.height, size]);
  useEffect(() => { engineRef.current?.setShapeKind(shapeKind); }, [shapeKind]);
  useEffect(() => { engineRef.current?.setShapeFill(shapeFill); }, [shapeFill]);
  useEffect(() => { engineRef.current?.setAutoShape(autoShape); }, [autoShape]);
  useEffect(() => { engineRef.current?.setInputPrefs({ stylusOnly, penDraws }); }, [stylusOnly, penDraws]);

  // Not `data-ink-tool`: that one marks the toolbar's tool buttons, and a test finds a tool by it.
  return (
    <div ref={setHost} className={near ? "page-ink-surface" : "page-ink-surface is-idle"} data-surface-tool={tool}>
      {near && <>
        <canvas ref={committedRef} className="page-ink-canvas" />
        <canvas ref={wetRef} className="page-ink-canvas" />
      </>}
    </div>
  );
}
