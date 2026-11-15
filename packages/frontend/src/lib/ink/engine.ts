// InkEngine — the host-agnostic DOM layer of the ink stack.
//
// Input pipeline (Xournal++-derived): pointer events are unpacked via
// getCoalescedEvents() into a plain buffer, and ALL processing happens in a
// requestAnimationFrame loop. Two stacked canvases: the committed-strokes
// canvas is redrawn only on commit / erase / undo / resize; the wet-ink
// canvas holds only the in-progress stroke and is cleared on commit. Zero
// React (or any host) re-renders during a stroke — the host only hears about
// changes through the debounced onChange callback.
//
// Tool dispatch is flat (AFFiNE pattern): pointerdown consults a single
// current-tool field. WHICH pointer draws (pen vs finger vs mouse) and which
// ones pan / zoom / tap is decided by the pure InkInputPolicy (inputPolicy.ts);
// the engine applies its actions: it draws itself and hands pan / zoom to
// the host through `gestures`.

import { inkShapeIsDrawable } from "@onden/markdown/ink";
import { Canvas2dCommittedRenderer, type CommittedView, type ICommittedRenderer } from "./committed";
import { eraseStrokeWithTrail } from "./erase";
import { PenHoverPreview, type PenHoverLook } from "./penHover";
import { PenShortcutDetector } from "./penShortcut";
import { HIGHLIGHTER_ALPHA } from "./renderer";
import { themedStrokeColor } from "./color";
import { InkInputPolicy, type InkInputAction, type InkPointerKind, type InkPointerSample } from "./inputPolicy";
import { InkModel } from "./model";
import { PICK_REACH_PX, colorInDrawing, registerColorSource } from "./colorPick";
import { recognizeShape } from "./recognize";
import { inkItemsInRect, inkSelectionBounds, type InkRect, type InkSelection } from "./select";
import { extractInkClip, isEmptyInkClip, placeInkClip, type InkClip } from "./clip";
import { shapeStrokes, shapeTouches, shapeWidthFor } from "./shapes";
import { shouldSimulatePressure } from "./outline";
import { paintWet } from "./renderer";
import {
  INK_DEFAULT_PAGE_WIDTH,
  type EraseInterval,
  type ErasedIntervals,
  type InkActiveTool,
  type InkDocument,
  type InkOp,
  type InkPoint,
  type InkShape,
  type InkShapeFill,
  type InkShapeKind,
  type InkStroke,
  type InkToolId,
  type InkTransform,
} from "./types";
import { capturePointer } from "../pointerDrag";
import { vibrate } from "../haptics";
import { randomUUID } from "../uuid";

const ERASER_RADIUS = 12; // doc units
const GROW_MARGIN = 200; // start growing when ink reaches this close to the bottom
const GROW_STEP = 400; // grow in page-ish increments, not pixel-by-pixel
const DEFAULT_MIN_PAGE_HEIGHT = 1400;
const DEFAULT_DEBOUNCE_MS = 800;
/** Pen held this long without moving: the stroke may become a shape. */
const HOLD_MS = 500;
/** "Not moving" tolerates this much pen jitter (CSS px). */
const HOLD_SLOP_PX = 4;

/** Pan / zoom requests from the input policy, in client CSS px. A host that
 *  supplies this gets the finger rules (the Hand tool pans with one finger,
 *  2 fingers pinch, 2-/3-finger taps undo / redo); without it the engine
 *  keeps the single-pointer drawing behaviour (PDF overlay). */
export interface InkGestureHost {
  /** Move the content by (dx, dy): it follows the fingers. */
  pan(dx: number, dy: number): void;
  /** Multiply the zoom by `factor`, keeping client point (x, y) still. */
  zoom(factor: number, clientX: number, clientY: number): void;
  /** A one-finger pan ended at this velocity (px/ms); optional glide. */
  fling?(vx: number, vy: number): void;
}

export interface InkEngineOptions {
  /** Committed-strokes canvas; the engine wraps it in the default Canvas2D
   *  renderer. Omit only when `committedRenderer` is supplied. */
  committedCanvas?: HTMLCanvasElement;
  /** Injected committed renderer (Canvas2D over a host-owned
   *  surface). When set, `committedCanvas` is ignored and the HOST owns
   *  surface sizing — pair with `manageCanvasSize: false`. */
  committedRenderer?: ICommittedRenderer;
  /** Cache finished strokes as tiles so a moving camera copies them instead of
   *  refilling every stroke (the handwriting page scrolls a long surface).
   *  Ignored with `committedRenderer`. See Canvas2dCommittedRenderer. */
  tiledCommitted?: boolean;
  wetCanvas: HTMLCanvasElement;
  /** Debounced document callback — fires after mutations settle. */
  onChange?: (doc: InkDocument) => void;
  changeDebounceMs?: number;
  /** Page height (document units) after load and each growth step — a host
   *  that sizes its own scroll area follows it. */
  onPageHeightChange?: (docHeight: number) => void;
  /** A new edit was made (not an undo or redo): a host that keeps one history for
   *  the whole board registers it there. */
  onRecord?: (op: InkOp) => void;
  /** When set, the 2-/3-finger taps ask the host to undo/redo instead of the
   *  engine's own stack (the board has one history for both layers). */
  onUndoRequest?: () => void;
  onRedoRequest?: () => void;
  /** Undo/redo availability changed — host refreshes button states. */
  onHistoryChange?: (canUndo: boolean, canRedo: boolean) => void;
  /**
   * Transform seam: viewport CSS px → document coordinates. When omitted the
   * engine uses its internal fit-page-width-to-display transform (T1 host:
   * identity + native scroll). Future hosts (canvas card, PDF overlay)
   * inject their pan/zoom here; nothing else in the engine changes.
   */
  transform?: InkTransform;
  minPageHeight?: number;
  /** Default true: the engine sizes both canvases from the page model and
   *  grows the page as ink approaches the bottom. Hosts with their own
   *  camera + fixed-size surfaces (knowledge canvas) set false — the page
   *  model is meaningless on an unbounded board. */
  manageCanvasSize?: boolean;
  /** Grow the page as ink nears the bottom. Defaults to `manageCanvasSize`;
   *  the handwriting page turns it on with host-sized (viewport) canvases.
   *  With it on, strokes may START anywhere within the page width at any
   *  depth (x 0..width, y >= 0): one that begins below the current bottom
   *  grows the page to fit. */
  growPage?: boolean;
  /** Backing-store pixel ratio. Default window.devicePixelRatio; a host that
   *  caps its canvas size passes the capped ratio it sized them with. */
  pixelRatio?: () => number;
  /** Finger/pen split; see InkGestureHost and inputPolicy.ts. */
  gestures?: InkGestureHost;
  /** Fingers only scroll with a drawing tool (the device's finger setting;
   *  later: setInputPrefs). */
  stylusOnly?: boolean;
  /** The pen draws with the last drawing tool whatever the toolbar says —
   *  Hand and the host's other tools included (the device's pen setting;
   *  later: setInputPrefs). */
  penDraws?: boolean;
  /** The first time a pen touches this surface (the host may switch the
   *  device into pen mode, hooks/useInkInputPrefs). */
  onPenSeen?: () => void;
  /** Fingers that do not draw scroll natively and pinch in the host's touch
   *  layer (touchSplit.ts): the element's touch-action follows the tool
   *  ("pan-x pan-y" while fingers don't draw, "none" while they do), and the
   *  policy emits no pan / zoom for touches (inputPolicy.ts). The browser's
   *  scroll runs on the compositor; ours ran on the main thread and stuttered
   *  next to pdf.js rendering. */
  nativeTouch?: boolean;
  /** The eraser's radius in document units, read on every use. Default
   *  ERASER_RADIUS; a host whose zoom changes the doc→px scale while its
   *  eraser should stay one size on screen (the PDF page) supplies it. */
  eraserRadius?: () => number;
  /** A pen shortcut fired from pointer events (S Pen side button, see
   *  penShortcut.ts). Never fires for a read-only drawing. The host switches
   *  pen ↔ eraser; a native shell's shortcut reaches the host separately
   *  (lib/penShortcutBridge.ts). */
  onPenShortcut?: () => void;
}

export class InkEngine {
  private readonly model = new InkModel();
  private readonly committed: ICommittedRenderer;
  private readonly committedCanvas: HTMLCanvasElement | null;
  private readonly wetCanvas: HTMLCanvasElement;
  private readonly opts: InkEngineOptions;

  /** The last drawing tool (pen, highlighter, eraser, shape): what a stroke is
   *  drawn with. The Hand tool is a separate switch (`hand`) so that a pen that
   *  always draws (`penDraws`) still knows what to draw with while Hand is on. */
  private tool: Exclude<InkActiveTool, "hand"> = "pen";
  private hand = false;
  private penSeenReported = false;
  private shapeKind: InkShapeKind = "rectangle";
  private shapeFill: InkShapeFill = "none";
  private autoShape = false;
  private color = "#15130d";
  private size = 4;
  private dark = false;

  private displayWidth = INK_DEFAULT_PAGE_WIDTH;
  private pageHeight: number;

  // ── Live-stroke state (rAF-owned) ─────────────────────────────────────────
  private activePointerId: number | null = null;
  /** Who draws / pans / zooms, palm rejection included (inputPolicy.ts). */
  private readonly input: InkInputPolicy;
  private readonly penShortcut = new PenShortcutDetector();
  private inputBuffer: InkPoint[] = [];
  private wetStroke: InkStroke | null = null;
  private eraserTrail: Array<[number, number]> = [];
  /** Shape tool: the drag so far. */
  private shapeDrag: { start: [number, number]; end: [number, number] } | null = null;
  /** Pen held still: where it rests, the timer that checks the stroke, and the
   *  shape the stroke has turned into (shown until the pen moves on or lifts). */
  private holdAnchor: InkPoint | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private snapped: InkShape | null = null;
  /** Shapes the eraser drag has touched so far (removed when it ends). */
  private erasedShapes = new Set<string>();
  /** Per-stroke merged interval preview accumulated during an eraser drag. */
  private erasePreview: ErasedIntervals = {};
  /** The wet canvas may hold ink (so painting nothing must still clear it). */
  private wetHasInk = false;
  private rafId: number | null = null;
  private destroyed = false;

  private changeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: InkEngineOptions) {
    if (!options.committedRenderer && !options.committedCanvas) {
      throw new Error("InkEngine needs a committedCanvas or a committedRenderer");
    }
    this.committedCanvas = options.committedRenderer ? null : options.committedCanvas ?? null;
    this.committed =
      options.committedRenderer ??
      new Canvas2dCommittedRenderer(options.committedCanvas!, { tiled: options.tiledCommitted });
    this.wetCanvas = options.wetCanvas;
    this.opts = options;
    this.model.onRecord = (op) => options.onRecord?.(op);
    this.pageHeight = options.minPageHeight ?? DEFAULT_MIN_PAGE_HEIGHT;
    this.input = new InkInputPolicy({
      gestures: options.gestures !== undefined,
      stylusOnly: options.stylusOnly,
      penDraws: options.penDraws,
      nativeTouch: options.nativeTouch,
    });
  }

  // ── Document ──────────────────────────────────────────────────────────────

  serialize(): InkDocument {
    return this.model.serialize();
  }

  /** The loaded drawing needs a newer version to edit: shown, never changed
   *  or saved (InkModel.readOnly). */
  get readOnly(): boolean { return this.model.readOnly; }

  load(doc: InkDocument | null | undefined): void {
    this.model.load(doc);
    this.pageHeight = this.model.contentHeight(
      this.opts.minPageHeight ?? DEFAULT_MIN_PAGE_HEIGHT,
      GROW_MARGIN,
    );
    this.input.configure({ readOnly: this.model.readOnly });
    this.syncTouchAction();
    this.resizeCanvases();
    this.notifyHistory();
    if (this.growsPage()) this.opts.onPageHeightChange?.(this.pageHeight);
  }

  /** Grow the page to reach `bottom` (document units): what the host draws on
   *  the page beside the ink (pictures, text boxes), which `load` cannot see. */
  fitBelow(bottom: number): void {
    this.maybeGrow(bottom);
  }

  /** Page size in document units (width fixed, height grows). */
  getPageSize(): { width: number; height: number } {
    return { width: this.model.pageWidth, height: this.pageHeight };
  }

  // ── Input settings ────────────────────────────────────────────────────────

  /** The device's finger or pen setting changed. */
  setInputPrefs(prefs: { stylusOnly?: boolean; penDraws?: boolean }): void {
    this.input.configure(prefs);
    this.syncTouchAction();
  }

  /** Space held: mouse / pen drags pan instead of drawing. */
  setSpaceHeld(held: boolean): void { this.input.setSpaceHeld(held); }

  // ── Tool state ────────────────────────────────────────────────────────────

  setTool(tool: InkActiveTool): void {
    this.hand = tool === "hand";
    if (tool !== "hand") this.tool = tool;
    this.input.configure({ handTool: this.hand });
    this.syncTouchAction();
  }
  getTool(): InkActiveTool { return this.hand ? "hand" : this.tool; }
  /** Which shape the "shape" tool drags out. */
  setShapeKind(kind: InkShapeKind): void { this.shapeKind = kind; }
  getShapeKind(): InkShapeKind { return this.shapeKind; }
  /** Whether new shapes (dragged out, or made by holding the pen still) get a tinted inside. */
  setShapeFill(fill: InkShapeFill): void { this.shapeFill = fill; }
  /** `fill` only when set: a shape drawn unfilled is stored exactly as before fills existed. */
  private fillField(): { fill?: InkShapeFill } { return this.shapeFill === "solid" ? { fill: "solid" } : {}; }
  /** Draw, then hold still: the pen's stroke becomes the shape it looks like
   *  (a setting that follows the account). */
  setAutoShape(on: boolean): void {
    this.autoShape = on;
    if (!on) this.cancelHold();
  }
  setColor(color: string): void { this.color = color; }
  getColor(): string { return this.color; }
  setSize(size: number): void { this.size = size; }
  getSize(): number { return this.size; }

  setDarkMode(dark: boolean): void {
    if (this.dark === dark) return;
    this.dark = dark;
    this.repaintCommitted();
  }

  // ── Viewport ──────────────────────────────────────────────────────────────

  /** Fit the logical page width to `cssWidth` display pixels. */
  setDisplayWidth(cssWidth: number): void {
    if (cssWidth <= 0 || cssWidth === this.displayWidth) return;
    this.displayWidth = cssWidth;
    this.resizeCanvases();
  }

  /** doc → CSS scale. */
  private scale(): number {
    if (this.opts.transform) return this.opts.transform.scale();
    return this.displayWidth / this.model.pageWidth;
  }

  private toDoc(cssX: number, cssY: number): [number, number] {
    if (this.opts.transform) return this.opts.transform.toDoc(cssX, cssY);
    const s = this.scale();
    return [cssX / s, cssY / s];
  }

  private dpr(): number {
    if (this.opts.pixelRatio) return this.opts.pixelRatio();
    return typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
  }

  /** The host's camera moved (scroll, zoom, surface resize): repaint both
   *  surfaces at the new transform. Strokes stay in document coordinates. */
  viewChanged(): void {
    // Camera only: the renderer repaints its last scene, so the strokes are not
    // re-collected (and, with tiles, not refilled) on every scroll frame.
    if (this.opts.manageCanvasSize !== false) this.sizeCanvases();
    this.committed.setView(this.committedView());
    this.paintLive();
  }

  private growsPage(): boolean {
    return this.opts.growPage ?? this.opts.manageCanvasSize !== false;
  }

  /** CSS px offset of the doc origin (pan), from the transform seam. */
  private offsetCss(): [number, number] {
    return this.opts.transform?.offset?.() ?? [0, 0];
  }

  private committedView(): CommittedView {
    const [offsetX, offsetY] = this.offsetCss();
    return { dark: this.dark, scale: this.scale(), offsetX, offsetY, dpr: this.dpr() };
  }

  private resizeCanvases(): void {
    if (this.opts.manageCanvasSize === false) {
      // Host-owned surfaces (knowledge canvas): never touch their sizes.
      this.repaintCommitted();
      return;
    }
    this.sizeCanvases();
    this.repaintCommitted();
  }

  /** Fit the engine-owned canvases to the page. Assigning width / height clears
   *  a canvas even when the value is unchanged, so only changes are written. */
  private sizeCanvases(): void {
    const s = this.scale();
    const dpr = this.dpr();
    const cssW = Math.round(this.model.pageWidth * s);
    const cssH = Math.round(this.pageHeight * s);
    const width = Math.max(1, Math.round(cssW * dpr));
    const height = Math.max(1, Math.round(cssH * dpr));
    for (const canvas of [this.committedCanvas, this.wetCanvas]) {
      if (!canvas) continue;
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    }
  }

  private repaintCommitted(extraErased?: ErasedIntervals): void {
    const erased = extraErased
      ? { ...this.model.erased, ...extraErased }
      : this.model.erased;
    const shapes = this.model.shapes.filter((shape) => !this.erasedShapes.has(shape.id));
    const strokes = shapes.length === 0 ? this.model.strokes : [...this.model.strokes, ...shapes.flatMap(shapeStrokes)];
    this.committed.commitStrokes(strokes, erased, this.committedView());
  }

  /** Grow the page when ink approaches the bottom edge. */
  private maybeGrow(maxY: number): void {
    if (!this.growsPage()) return; // unbounded board / PDF page: no page model
    if (maxY < this.pageHeight - GROW_MARGIN) return;
    this.pageHeight = Math.ceil((maxY + GROW_MARGIN) / GROW_STEP) * GROW_STEP;
    this.resizeCanvases();
    this.opts.onPageHeightChange?.(this.pageHeight);
  }

  // ── Undo / redo (in-session; cross-session is the host's event restore) ──

  canUndo(): boolean { return this.model.canUndo(); }
  canRedo(): boolean { return this.model.canRedo(); }

  /** False when there was nothing to undo. */
  undo(): boolean {
    if (!this.model.undo()) return false;
    this.repaintCommitted();
    this.scheduleChange();
    this.notifyHistory();
    return true;
  }

  redo(): boolean {
    if (!this.model.redo()) return false;
    this.repaintCommitted();
    this.scheduleChange();
    this.notifyHistory();
    return true;
  }

  // ── Selection by area (the board selects cards and ink together) ──────────

  /** The strokes and shapes with a visible point inside the document-space rect. */
  itemsInRect(rect: InkRect): InkSelection { return inkItemsInRect(this.model, rect); }
  selectionBounds(selection: InkSelection): InkRect | null { return inkSelectionBounds(this.model, selection); }

  /** Move the selected ink by (dx, dy) document units: one undo step. */
  moveItems(selection: InkSelection, dx: number, dy: number): void {
    this.model.moveItems(new Set(selection.strokeIds), new Set(selection.shapeIds), dx, dy);
    this.afterEdit();
  }

  /** Remove the selected ink as the eraser would (one undo step). */
  removeItems(selection: InkSelection): void {
    const ids = new Set(selection.strokeIds);
    const after: ErasedIntervals = {};
    for (const stroke of this.model.strokes) if (ids.has(stroke.id)) after[stroke.id] = [[0, stroke.points.length - 1]];
    this.model.applyErase(after, new Set(selection.shapeIds));
    this.afterEdit();
  }

  /** A copy of the selected ink, ready for `pasteClip` (here or on another board). */
  copyItems(selection: InkSelection): InkClip { return extractInkClip(this.model, selection); }

  /** Add a copy of `clip` moved by (dx, dy) under new ids; each item is one undo step the
   *  board's history merges. Returns the new items, or null when the drawing is read-only. */
  pasteClip(clip: InkClip, dx: number, dy: number): InkSelection | null {
    if (this.model.readOnly || isEmptyInkClip(clip)) return null;
    const placed = placeInkClip(clip, dx, dy, randomUUID);
    for (const stroke of placed.strokes) this.model.addStroke(stroke);
    for (const shape of placed.shapes) this.model.addShape(shape);
    this.afterEdit();
    return { strokeIds: placed.strokes.map((s) => s.id), shapeIds: placed.shapes.map((s) => s.id) };
  }

  private afterEdit(): void {
    this.repaintCommitted();
    this.scheduleChange();
    this.notifyHistory();
  }

  private notifyHistory(): void {
    this.opts.onHistoryChange?.(this.model.canUndo(), this.model.canRedo());
  }

  // ── onChange plumbing ─────────────────────────────────────────────────────

  private scheduleChange(): void {
    if (!this.opts.onChange) return;
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.opts.onChange?.(this.serialize());
    }, this.opts.changeDebounceMs ?? DEFAULT_DEBOUNCE_MS);
  }

  /** Fire a pending (debounced) onChange immediately — host calls this on
   *  unmount so the last edits never sit in the timer. */
  flush(): void {
    if (!this.changeTimer) return;
    clearTimeout(this.changeTimer);
    this.changeTimer = null;
    this.opts.onChange?.(this.serialize());
  }

  // ── Pointer pipeline ──────────────────────────────────────────────────────

  /** Attach pointer handlers to the interaction element (usually the wet
   *  canvas or a wrapper over both canvases). Returns a dispose function.
   *  Every pointer goes through the input policy; the engine draws, the host
   *  pans / zooms (`gestures`). */
  addPointerHandlers(el: HTMLElement): () => void {
    // The engine owns every touch on this element (pan and pinch included),
    // so the browser must not scroll or zoom it on its own — unless the host
    // lets the browser scroll (`nativeTouch`).
    this.touchEl = el;
    this.syncTouchAction();
    // iPad Safari: no long-press callout / magnifier, no text selection, no
    // Scribble handwriting-to-text taking the pen on this surface. (Set here
    // so every host gets them, not only the one whose CSS remembers.)
    el.style.setProperty("-webkit-touch-callout", "none");
    el.style.setProperty("-webkit-user-select", "none");
    el.style.userSelect = "none";
    const pensDown = new Set<number>();
    const hover = new PenHoverPreview(el, () => this.hoverLook());

    const sample = (e: PointerEvent, isDown: boolean): InkPointerSample => ({
      id: e.pointerId,
      kind: pointerKind(e.pointerType),
      x: e.clientX,
      y: e.clientY,
      t: e.timeStamp || Date.now(),
      button: e.button,
      inArea: isDown ? this.startsOnPage(e, el) : undefined,
    });
    const stamp = (e: Event) => e.timeStamp || Date.now();
    const down = (e: PointerEvent) => {
      if (e.pointerType === "pen") {
        pensDown.add(e.pointerId);
        if (!this.penSeenReported) { this.penSeenReported = true; this.opts.onPenSeen?.(); }
      }
      hover.pointerDown(pointerKind(e.pointerType), e.pointerId);
      this.penShortcut.pointerDown(pointerKind(e.pointerType), e.pointerId, stamp(e));
      const actions = this.input.down(sample(e, true));
      if (this.input.tracks(e.pointerId)) {
        e.preventDefault();
        capturePointer(el, e.pointerId);
      }
      this.apply(actions, e, el);
    };
    const move = (e: PointerEvent) => {
      hover.pointerMove(pointerKind(e.pointerType), e.clientX, e.clientY);
      if (!this.readOnly && this.penShortcut.pointerMove(pointerKind(e.pointerType), e.buttons, stamp(e))) {
        this.opts.onPenShortcut?.();
      }
      if (this.input.tracks(e.pointerId)) e.preventDefault();
      this.apply(this.input.move(sample(e, false)), e, el);
    };
    const up = (e: PointerEvent) => {
      pensDown.delete(e.pointerId);
      hover.pointerEnd(pointerKind(e.pointerType), e.pointerId);
      this.penShortcut.pointerEnd(pointerKind(e.pointerType), e.pointerId, stamp(e));
      this.apply(this.input.up(sample(e, false)), e, el);
    };
    const cancel = (e: PointerEvent) => {
      pensDown.delete(e.pointerId);
      hover.pointerEnd(pointerKind(e.pointerType), e.pointerId);
      this.penShortcut.pointerEnd(pointerKind(e.pointerType), e.pointerId, stamp(e), true);
      this.apply(this.input.cancel(sample(e, false)), e, el);
    };
    // Side button held while the pen touches: only a contextmenu reaches us.
    const contextMenu = (e: MouseEvent) => {
      if (this.readOnly || !this.opts.onPenShortcut) return;
      const result = this.penShortcut.contextMenu((e as PointerEvent).pointerType ?? "", stamp(e));
      if (result.swallow) e.preventDefault();
      if (result.toggle) this.opts.onPenShortcut();
    };

    // Safari can still start a text selection / Scribble / page scroll from a
    // pen touch; stopping touchmove while a pen is down (never for fingers,
    // which the engine pans with) keeps the stroke.
    const touchMove = (e: TouchEvent) => {
      if (pensDown.size > 0 && e.cancelable) e.preventDefault();
    };
    const selectStart = (e: Event) => e.preventDefault();
    const leave = (e: PointerEvent) => hover.pointerLeave(pointerKind(e.pointerType));

    const withdrawColors = registerColorSource({ element: el, colorAt: (x, y) => this.colorAt(el, x, y) });
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("touchmove", touchMove, { passive: false });
    el.addEventListener("selectstart", selectStart);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", cancel);
    el.addEventListener("contextmenu", contextMenu);
    return () => {
      withdrawColors();
      if (this.touchEl === el) this.touchEl = null;
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("touchmove", touchMove);
      el.removeEventListener("selectstart", selectStart);
      pensDown.clear();
      hover.dispose();
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", cancel);
      el.removeEventListener("contextmenu", contextMenu);
      this.penShortcut.reset();
      this.apply(this.input.reset(), null, el);
    };
  }

  /** The stored colour of the stroke or shape under a viewport point (the
   *  eyedropper), or null. Read from the drawing, not from the screen. */
  private colorAt(el: HTMLElement, clientX: number, clientY: number): string | null {
    const rect = el.getBoundingClientRect();
    const [x, y] = this.toDoc(clientX - rect.left, clientY - rect.top);
    return colorInDrawing(this.model, x, y, PICK_REACH_PX / Math.max(this.scale(), 1e-6));
  }

  /** The element addPointerHandlers is attached to (its touch-action). */
  private touchEl: HTMLElement | null = null;

  private syncTouchAction(): void {
    if (!this.touchEl) return;
    const fingersScroll = this.opts.nativeTouch && (!this.input.fingerDraws || this.model.readOnly);
    this.touchEl.style.touchAction = fingersScroll ? "pan-x pan-y" : "none";
  }

  /** The hover marker for the current tool, in CSS px; null = none. */
  private hoverLook(): PenHoverLook | null {
    if (this.readOnly || (this.hand && !this.input.penDrawsAlways)) return null;
    const s = this.scale();
    if (this.tool === "eraser") return { diameter: this.eraserRadius() * 2 * s, color: null, opacity: 0.8 };
    return {
      diameter: this.size * s,
      color: themedStrokeColor(this.color, this.dark),
      opacity: this.tool === "highlighter" ? HIGHLIGHTER_ALPHA : 0.9,
    };
  }

  /** Page hosts: a stroke may start within the page width at any depth (the
   *  page grows to fit, see maybeGrow); left/right of the paper or above it
   *  does not take a stroke. Boards and PDF pages accept every point. */
  private startsOnPage(e: PointerEvent, el: HTMLElement): boolean {
    if (!this.growsPage()) return true;
    const rect = el.getBoundingClientRect();
    const [x, y] = this.toDoc(e.clientX - rect.left, e.clientY - rect.top);
    return x >= 0 && y >= 0 && x <= this.model.pageWidth;
  }

  private apply(actions: InkInputAction[], e: PointerEvent | null, el: HTMLElement): void {
    for (const action of actions) {
      switch (action.type) {
        case "draw-start":
          if (!e) break;
          this.activePointerId = action.id;
          this.beginInput(e, el);
          break;
        case "draw-move":
          if (e) this.bufferInput(e, el);
          break;
        case "draw-end":
          if (e) this.bufferInput(e, el);
          this.endInput();
          break;
        case "draw-cancel":
          try { el.releasePointerCapture(action.id); } catch { /* jsdom / already released */ }
          if (action.keep && this.hasKeepableInput()) this.endInput();
          else this.discardInput();
          break;
        case "pan":
          this.opts.gestures?.pan(action.dx, action.dy);
          break;
        case "zoom":
          this.opts.gestures?.zoom(action.factor, action.x, action.y);
          break;
        case "fling":
          this.opts.gestures?.fling?.(action.vx, action.vy);
          break;
        case "undo":
          if (this.opts.onUndoRequest) this.opts.onUndoRequest(); else this.undo();
          break;
        case "redo":
          if (this.opts.onRedoRequest) this.opts.onRedoRequest(); else this.redo();
          break;
      }
    }
  }

  private eventToDocPoint(e: PointerEvent, el: HTMLElement, realPressure: boolean): InkPoint {
    const rect = el.getBoundingClientRect();
    const [x, y] = this.toDoc(e.clientX - rect.left, e.clientY - rect.top);
    return realPressure ? [x, y, e.pressure > 0 ? e.pressure : 0.5] : [x, y];
  }

  private beginInput(e: PointerEvent, el: HTMLElement): void {
    const realPressure = !shouldSimulatePressure(e.pointerType);
    this.inputBuffer = [this.eventToDocPoint(e, el, realPressure)];
    this.cancelHold();
    if (this.tool === "eraser") {
      this.eraserTrail = [];
      this.erasePreview = {};
      this.erasedShapes = new Set();
    } else if (this.tool === "shape") {
      const [x, y] = this.inputBuffer[0]!;
      this.shapeDrag = { start: [x, y], end: [x, y] };
    } else {
      this.wetStroke = {
        id: randomUUID(),
        points: [],
        color: this.color,
        size: this.size,
        toolId: this.tool as InkToolId,
      };
    }
    this.startRaf();
  }

  private bufferInput(e: PointerEvent, el: HTMLElement): void {
    const realPressure = !shouldSimulatePressure(e.pointerType);
    const coalesced: PointerEvent[] =
      typeof e.getCoalescedEvents === "function" && e.getCoalescedEvents().length > 0
        ? e.getCoalescedEvents()
        : [e];
    for (const ev of coalesced) {
      this.inputBuffer.push(this.eventToDocPoint(ev, el, realPressure));
    }
  }

  private eraserRadius(): number {
    return this.opts.eraserRadius?.() ?? ERASER_RADIUS;
  }

  private startRaf(): void {
    if (this.rafId !== null) return;
    const raf = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number;
    const tick = () => {
      this.rafId = null;
      if (this.destroyed) return;
      this.processBuffer();
      if (this.activePointerId !== null) {
        this.rafId = raf(tick);
      }
    };
    this.rafId = raf(tick);
  }

  private processBuffer(): void {
    if (this.inputBuffer.length === 0) return;
    const incoming = this.inputBuffer;
    this.inputBuffer = [];

    if (this.tool === "eraser") {
      for (const p of incoming) this.eraserTrail.push([p[0], p[1]]);
      const radius = this.eraserRadius();
      let changed = false;
      for (const stroke of this.model.strokes) {
        const existing = this.erasePreview[stroke.id] ?? this.model.erased[stroke.id];
        // Only the fresh tail of the trail matters per frame, but pass the
        // last few points so segment hit-testing bridges frame boundaries.
        const tail = this.eraserTrail.slice(-Math.max(2, incoming.length + 1));
        const next = eraseStrokeWithTrail(stroke, existing, tail, radius);
        if (next) {
          this.erasePreview[stroke.id] = next;
          changed = true;
        }
      }
      for (const shape of this.model.shapes) {
        if (this.erasedShapes.has(shape.id)) continue;
        if (this.eraserTrail.slice(-incoming.length - 1).some((p) => shapeTouches(shape, p[0], p[1], radius))) {
          this.erasedShapes.add(shape.id);
          changed = true;
        }
      }
      if (changed) this.repaintCommitted(this.erasePreview);
      return;
    }

    if (this.tool === "shape") {
      const drag = this.shapeDrag;
      if (!drag) return;
      const last = incoming[incoming.length - 1]!;
      drag.end = [last[0], last[1]];
      this.maybeGrow(last[1]);
      this.paintLive();
      return;
    }

    const stroke = this.wetStroke;
    if (!stroke) return;
    let maxY = 0;
    for (const p of incoming) {
      stroke.points.push(p);
      if (p[1] > maxY) maxY = p[1];
    }
    this.maybeGrow(maxY);
    this.trackHold(incoming[incoming.length - 1]!);
    this.paintLive();
  }

  // ── Draw, hold still, get the shape ────────────────────────────────────────

  /** The pen moved on (or rests): restart the wait for it to hold still. */
  private trackHold(at: InkPoint): void {
    if (!this.autoShape || this.tool !== "pen") return;
    const slop = HOLD_SLOP_PX / this.scale();
    const anchor = this.holdAnchor;
    if (anchor && Math.hypot(at[0] - anchor[0], at[1] - anchor[1]) <= slop) return;
    this.holdAnchor = at;
    this.snapped = null; // moving on after the shape appeared: it was not wanted
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => this.snapIfShape(), HOLD_MS);
  }

  private cancelHold(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.holdAnchor = null;
    this.snapped = null;
  }

  /** The pen has been still: show the shape the stroke looks like, if any. */
  private snapIfShape(): void {
    this.holdTimer = null;
    const stroke = this.wetStroke;
    if (this.destroyed || this.activePointerId === null || !stroke || this.tool !== "pen") return;
    this.processBuffer();
    const found = recognizeShape(stroke.points);
    if (!found || !inkShapeIsDrawable(found.kind, found.start, found.end)) return;
    this.snapped = { id: randomUUID(), kind: found.kind, start: found.start, end: found.end, color: stroke.color, size: shapeWidthFor(stroke.size), ...this.fillField() };
    this.paintLive();
    vibrate(8);
  }

  /** What the wet canvas shows: the stroke, or the shape it has turned into
   *  (with a halo), or the shape being dragged out. */
  private paintLive(): void {
    const shape = this.snapped ?? this.dragShape();
    const live = shape ? shapeStrokes(shape) : this.wetStroke;
    const drawing = (Array.isArray(live) ? live : live ? [live] : []).some((stroke) => stroke.points.length > 0);
    // Nothing live and nothing left from before (a scroll frame): leave the canvas
    // alone — clearing an empty full-size canvas still makes the browser re-send it.
    if (!drawing && !this.wetHasInk) return;
    this.wetHasInk = drawing;
    paintWet(this.wetCanvas, live, { ...this.wetPaintOptions(), halo: this.snapped !== null });
  }

  private dragShape(): InkShape | null {
    const drag = this.shapeDrag;
    if (!drag) return null;
    return { id: "wet", kind: this.shapeKind, start: drag.start, end: drag.end, color: this.color, size: shapeWidthFor(this.size), ...this.fillField() };
  }

  /** Wet paints in device px: doc scale + pan offset, both × dpr. */
  private wetPaintOptions() {
    const dpr = this.dpr();
    const [ox, oy] = this.offsetCss();
    return { dark: this.dark, scale: this.scale() * dpr, offsetX: ox * dpr, offsetY: oy * dpr };
  }

  /** Abandon the in-progress stroke/eraser without committing: a pen
   *  preempting a palm stroke, or a finger stroke turning into a pinch. */
  private discardInput(): void {
    this.activePointerId = null;
    this.inputBuffer = [];
    this.wetStroke = null;
    this.shapeDrag = null;
    this.cancelHold();
    this.eraserTrail = [];
    if (Object.keys(this.erasePreview).length > 0 || this.erasedShapes.size > 0) {
      this.erasePreview = {};
      this.erasedShapes = new Set();
      this.repaintCommitted(); // drop the eraser preview overlay
    }
    paintWet(this.wetCanvas, null, this.wetPaintOptions());
  }

  /** A pen cancelled mid-stroke: something worth keeping was drawn (a stroke
   *  of >= 2 points) or erased. */
  private hasKeepableInput(): boolean {
    if (this.tool === "eraser") return true; // nothing erased → endInput commits nothing
    if (this.tool === "shape") return this.shapeDrag !== null;
    return (this.wetStroke?.points.length ?? 0) + this.inputBuffer.length >= 2;
  }

  private endInput(): void {
    // Drain whatever the last frame hadn't processed yet.
    this.processBuffer();
    this.activePointerId = null;

    if (this.tool === "eraser") {
      const after: Record<string, EraseInterval[]> = this.erasePreview;
      const touchedShapes = this.erasedShapes;
      this.erasePreview = {};
      this.erasedShapes = new Set();
      this.eraserTrail = [];
      if (Object.keys(after).length > 0 || touchedShapes.size > 0) {
        this.model.applyErase(after, touchedShapes);
        this.scheduleChange();
        this.notifyHistory();
      }
      this.repaintCommitted();
      return;
    }

    if (this.tool === "shape") {
      const shape = this.dragShape();
      this.shapeDrag = null;
      paintWet(this.wetCanvas, null, this.wetPaintOptions());
      if (shape && inkShapeIsDrawable(shape.kind, shape.start, shape.end)) {
        this.model.addShape({ ...shape, id: randomUUID() });
        this.repaintCommitted();
        this.scheduleChange();
        this.notifyHistory();
      }
      return;
    }

    const stroke = this.wetStroke;
    const snapped = this.snapped;
    this.wetStroke = null;
    this.cancelHold();
    paintWet(this.wetCanvas, null, this.wetPaintOptions());
    if (stroke && snapped && stroke.points.length > 0) {
      this.model.snapStrokeToShape(stroke, snapped);
      this.repaintCommitted();
      this.scheduleChange();
      this.notifyHistory();
    } else if (stroke && stroke.points.length > 0) {
      this.model.addStroke(stroke);
      this.repaintCommitted();
      this.scheduleChange();
      this.notifyHistory();
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.cancelHold();
    if (this.rafId !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.rafId);
    }
    this.rafId = null;
    if (this.changeTimer) {
      clearTimeout(this.changeTimer);
      this.changeTimer = null;
    }
  }
}

function pointerKind(pointerType: string): InkPointerKind {
  return pointerType === "pen" ? "pen" : pointerType === "touch" ? "touch" : "mouse";
}
