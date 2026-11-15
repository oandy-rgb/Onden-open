// Committed-strokes renderer: the one surface that fills every finished stroke,
// for both the handwriting page (InkNodeView) and the whiteboard (CanvasInkLayer).
//
// The ink stack draws on two surfaces: the WET surface (the one in-progress
// stroke) and this COMMITTED surface, both Canvas 2D with Path2D and the
// nonzero fill rule, so a self-overlapping outline (a sharp V, a loop) fills
// the same everywhere — the PDF and published SVG use nonzero too.
//
// `commitStrokes` re-tessellates (commit / erase / undo / load / theme —
// never per pointer event); `setView` only moves the camera. Geometry stays in
// outline.ts / erase.ts; the interface remains so the engine can be tested with a
// fake surface.

import { fillStrokeGeometry, strokeGeometry, type StrokeGeometry } from "./renderer";
import { createTileSurface, TILE_PX, TileCache, tileBudget, type TileFactory, type TileSurface } from "./tileCache";
import type { EraseInterval, ErasedIntervals, InkStroke } from "./types";

/** Camera + theme for the committed surface. Strokes live in document
 *  (canvas-model) coordinates; the renderer applies scale + offset. */
export interface CommittedView {
  dark: boolean;
  /** doc → CSS px uniform scale. */
  scale: number;
  /** CSS px offset of the doc origin inside the surface element. */
  offsetX: number;
  offsetY: number;
  /** Device pixel ratio of the backing store. */
  dpr: number;
}

export interface ICommittedRenderer {
  /** Surfaced as data-ink-renderer for tests and diagnostics. */
  readonly kind: "canvas2d";
  /** Re-tessellate and redraw the full committed scene. */
  commitStrokes(
    strokes: ReadonlyArray<InkStroke>,
    erased: ErasedIntervals,
    view: CommittedView,
  ): void;
  /** Update only the camera (pan/zoom/theme view) — no re-tessellation
   *  required by the contract (tiled canvases repaint from cached tiles). */
  setView(view: CommittedView): void;
  /** Resize the backing surface to CSS px dimensions. */
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  destroy(): void;
}

/** Pause after the last zoom step before tiles are repainted at the new scale. */
export const ZOOM_SETTLE_MS = 150;

export interface Canvas2dCommittedOptions {
  /** Set when the factory created (and therefore owns) the canvas. */
  onDestroy?: () => void;
  /** Paint finished strokes into cached tiles and scroll by copying them
   *  (hosts whose camera moves over a long surface: the handwriting page and the
   *  whiteboard). Off: fill every visible stroke each paint. */
  tiled?: boolean;
  /** Tile surfaces; tests inject fakes. */
  tileFactory?: TileFactory;
}

/** One committed stroke as last drawn: lets `commitStrokes` find what changed. */
interface SceneStroke {
  stroke: InkStroke;
  erased: EraseInterval[] | undefined;
  /** Outline, built the first time something paints (a renderer without a 2D
   *  context, as in jsdom, never needs it). */
  geometry?: StrokeGeometry;
}

function geometryOf(entry: SceneStroke): StrokeGeometry {
  return (entry.geometry ??= strokeGeometry(entry.stroke, entry.erased));
}

/** The scale, dpr and theme the tiles were painted at. */
interface TileLook { scale: number; dpr: number; dark: boolean }

/** The original Canvas2D committed path, formalized. Caches the last scene
 *  so `setView`/`resize` can repaint without the caller resupplying strokes.
 *
 *  With `tiled`, the scene is painted once into TILE_PX tiles (tileCache.ts)
 *  and every later paint copies the visible ones, so scrolling costs a few
 *  drawImage calls instead of a fill per stroke:
 *   - a stroke added / erased / restored drops only the tiles it touches;
 *   - theme or dpr changes drop all tiles;
 *   - zooming stretches the existing tiles, and repaints them at the new scale
 *     once the zoom pauses (ZOOM_SETTLE_MS). */
export class Canvas2dCommittedRenderer implements ICommittedRenderer {
  readonly kind = "canvas2d" as const;

  /** Draw order, plus the same strokes by id for diffing the next commit. */
  private scene: SceneStroke[] = [];
  private byId = new Map<string, SceneStroke>();
  private view: CommittedView | null = null;

  private readonly tiles = new TileCache();
  private readonly tileFactory: TileFactory;
  /** Look the cached tiles were painted at; null = none painted yet. */
  private look: TileLook | null = null;
  private frame = 0;
  private zoomTimer: ReturnType<typeof setTimeout> | null = null;
  /** The tile factory failed once (no 2D canvases): paint directly from now on. */
  private tilesUnavailable = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly options: Canvas2dCommittedOptions = {},
  ) {
    this.tileFactory = options.tileFactory ?? createTileSurface;
  }

  commitStrokes(
    strokes: ReadonlyArray<InkStroke>,
    erased: ErasedIntervals,
    view: CommittedView,
  ): void {
    this.view = view;
    this.syncScene(strokes, erased);
    this.paint();
  }

  setView(view: CommittedView): void {
    this.view = view;
    this.paint();
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    // Assigning width / height clears the canvas even when the value is the
    // same, so only touch them when the size really changed.
    const width = Math.max(1, Math.round(cssWidth * dpr));
    const height = Math.max(1, Math.round(cssHeight * dpr));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.canvas.style.width = `${Math.round(cssWidth)}px`;
    this.canvas.style.height = `${Math.round(cssHeight)}px`;
    this.paint();
  }

  destroy(): void {
    this.clearZoomTimer();
    this.tiles.release();
    this.options.onDestroy?.();
  }

  /** Compare the incoming strokes with the last scene and drop the tiles that
   *  changed strokes touch (old and new outline both). Strokes are immutable, so
   *  "changed" is a new object or a new erased-interval array for the same id. */
  private syncScene(strokes: ReadonlyArray<InkStroke>, erased: ErasedIntervals): void {
    const scene: SceneStroke[] = [];
    const byId = new Map<string, SceneStroke>();
    const dirty: Array<StrokeGeometry["bbox"]> = [];
    for (const stroke of strokes) {
      const intervals = erased[stroke.id];
      const before = this.byId.get(stroke.id);
      let entry = before;
      if (!before || before.stroke !== stroke || before.erased !== intervals) {
        entry = { stroke, erased: intervals };
        // Only strokes some tile may have painted can dirty one.
        if (before?.geometry) dirty.push(before.geometry.bbox);
        if (this.look) dirty.push(geometryOf(entry).bbox);
      }
      scene.push(entry!);
      byId.set(stroke.id, entry!);
    }
    for (const [id, gone] of this.byId) if (gone.geometry && !byId.has(id)) dirty.push(gone.geometry.bbox);
    this.scene = scene;
    this.byId = byId;
    if (!this.look || dirty.length === 0) return;
    // A load or big restore changes most of the page: drop everything instead
    // of testing each box against each tile.
    if (dirty.length > MANY_CHANGED_STROKES) { this.tiles.clear(); return; }
    const devicePerDoc = this.look.scale * this.look.dpr;
    for (const box of dirty) if (box[0] <= box[2]) this.tiles.invalidate(box, devicePerDoc);
  }

  private paint(): void {
    const view = this.view;
    if (!view) return;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return; // jsdom — engine stays constructible in unit tests
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.options.tiled && !this.tilesUnavailable && this.paintTiles(ctx, view)) return;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.paintDirect(ctx, view);
  }

  /** Fill every visible stroke (the path without tiles). */
  private paintDirect(ctx: CanvasRenderingContext2D, view: CommittedView): void {
    const s = view.scale * view.dpr;
    ctx.setTransform(s, 0, 0, s, view.offsetX * view.dpr, view.offsetY * view.dpr);
    // Visible document rect: strokes entirely outside it are skipped.
    const x0 = -view.offsetX / view.scale;
    const y0 = -view.offsetY / view.scale;
    const x1 = x0 + this.canvas.width / s;
    const y1 = y0 + this.canvas.height / s;
    for (const entry of this.scene) {
      const geometry = geometryOf(entry);
      const [minX, minY, maxX, maxY] = geometry.bbox;
      if (maxX < x0 || minX > x1 || maxY < y0 || minY > y1) continue;
      fillStrokeGeometry(ctx, entry.stroke, geometry, view.dark);
    }
  }

  /** Copy the visible tiles to the canvas, painting the missing ones first.
   *  False when tiles cannot serve this view (the caller paints directly). */
  private paintTiles(ctx: CanvasRenderingContext2D, view: CommittedView): boolean {
    const { dpr } = view;
    if (!this.look || this.look.dark !== view.dark || this.look.dpr !== dpr) {
      this.tiles.clear();
      this.look = { scale: view.scale, dpr, dark: view.dark };
      this.clearZoomTimer();
    } else if (this.look.scale !== view.scale) {
      this.scheduleZoomSettle();
    }
    const look = this.look;
    // Tile space is document × look.scale × dpr; the screen shows it stretched
    // by `ratio` while a zoom is in flight (1 when settled).
    const ratio = view.scale / look.scale;
    const originX = view.offsetX * dpr, originY = view.offsetY * dpr;
    const { width, height } = this.canvas;
    const i0 = Math.floor(-originX / ratio / TILE_PX);
    const i1 = Math.floor((width - originX) / ratio / TILE_PX);
    const j0 = Math.floor(-originY / ratio / TILE_PX);
    const j1 = Math.floor((height - originY) / ratio / TILE_PX);
    const count = (i1 - i0 + 1) * (j1 - j0 + 1);
    this.tiles.capacity = tileBudget(width, height);
    if (count > this.tiles.capacity) return false;

    this.frame += 1;
    const tiles: TileSurface[] = [];
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const tile = this.tiles.get(i, j, this.frame) ?? this.paintTile(i, j, look);
        if (!tile) { this.tilesUnavailable = true; return false; }
        tiles.push(tile);
      }
    }
    let n = 0;
    ctx.clearRect(0, 0, width, height);
    for (let j = j0; j <= j1; j++) {
      const top = Math.round(originY + j * TILE_PX * ratio);
      const bottom = Math.round(originY + (j + 1) * TILE_PX * ratio);
      for (let i = i0; i <= i1; i++) {
        const left = Math.round(originX + i * TILE_PX * ratio);
        const right = Math.round(originX + (i + 1) * TILE_PX * ratio);
        ctx.drawImage(tiles[n++]!.canvas, 0, 0, TILE_PX, TILE_PX, left, top, right - left, bottom - top);
      }
    }
    return true;
  }

  /** Paint tile (i, j) at `look` and cache it; null when no surface is available. */
  private paintTile(i: number, j: number, look: TileLook): TileSurface | null {
    const surface = this.tiles.takeSpare() ?? this.tileFactory();
    if (!surface) return null;
    const { ctx } = surface;
    const s = look.scale * look.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, TILE_PX, TILE_PX);
    ctx.setTransform(s, 0, 0, s, -i * TILE_PX, -j * TILE_PX);
    const x0 = (i * TILE_PX) / s, x1 = ((i + 1) * TILE_PX) / s;
    const y0 = (j * TILE_PX) / s, y1 = ((j + 1) * TILE_PX) / s;
    for (const entry of this.scene) {
      const geometry = geometryOf(entry);
      const [minX, minY, maxX, maxY] = geometry.bbox;
      if (maxX < x0 || minX > x1 || maxY < y0 || minY > y1) continue;
      fillStrokeGeometry(ctx, entry.stroke, geometry, look.dark);
    }
    this.tiles.put(i, j, surface, this.frame);
    return surface;
  }

  // ── Zoom: stretch now, repaint at the new scale when it pauses ───────────

  private scheduleZoomSettle(): void {
    this.clearZoomTimer();
    this.zoomTimer = setTimeout(() => {
      this.zoomTimer = null;
      this.look = null; // next paint repaints the visible tiles at the new scale
      this.tiles.clear();
      this.paint();
    }, ZOOM_SETTLE_MS);
  }

  private clearZoomTimer(): void {
    if (this.zoomTimer !== null) clearTimeout(this.zoomTimer);
    this.zoomTimer = null;
  }
}

/** More changed strokes than this in one commit: repaint every tile. */
const MANY_CHANGED_STROKES = 64;

export interface CreateCommittedRendererOptions {
  /** The surface canvas is appended here (and removed on destroy). */
  container: HTMLElement;
  cssWidth: number;
  cssHeight: number;
  dpr: number;
}

/** A tiled Canvas 2D committed renderer on a new canvas appended to `container`:
 *  the whiteboard's surface, whose camera moves over a long, wide board. */
export function createCommittedRenderer(options: CreateCommittedRendererOptions): ICommittedRenderer {
  const { container, cssWidth, cssHeight, dpr } = options;
  const canvas = document.createElement("canvas");
  canvas.className = "ink-canvas ink-canvas--committed";
  container.appendChild(canvas);
  const renderer = new Canvas2dCommittedRenderer(canvas, { onDestroy: () => canvas.remove(), tiled: true });
  renderer.resize(cssWidth, cssHeight, dpr);
  return renderer;
}
