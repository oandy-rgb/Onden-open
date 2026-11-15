// Tile cache for the committed-strokes canvas (Canvas2dCommittedRenderer).
//
// A handwriting page scrolls a viewport-sized canvas over a long page, so every
// scroll frame used to re-fill every visible stroke (about a thousand on a dense
// screen). Finished strokes do not change while the camera moves, so they are
// painted once into fixed-size tiles and scrolling only copies tiles to the
// canvas. Tiles are TILE_PX device pixels square, cut from the document at the
// "settled" scale × dpr; a tile is dropped when a stroke touching it changes.

/** Tile edge in device pixels. 512² px = 1 MB, small enough to repaint one
 *  quickly, big enough that a screen needs only a few drawImage calls. */
export const TILE_PX = 512;

/** Most tile pixels kept at once (≈ 96 MB of RGBA): iOS Safari budgets total
 *  canvas memory (the viewport canvases already take up to MAX_CANVAS_PIXELS
 *  each), so the cache stays well under it and the renderer falls back to
 *  filling directly when a view needs more tiles than this. */
export const MAX_TILE_PIXELS = 24 * 1024 * 1024;

export interface TileSurface {
  canvas: CanvasImageSource;
  ctx: CanvasRenderingContext2D;
}

/** Makes one TILE_PX × TILE_PX surface, or null when 2D canvases are
 *  unavailable (jsdom): the renderer then paints directly. */
export type TileFactory = () => TileSurface | null;

export function createTileSurface(): TileSurface | null {
  const canvas: HTMLCanvasElement | OffscreenCanvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(TILE_PX, TILE_PX)
      : Object.assign(document.createElement("canvas"), { width: TILE_PX, height: TILE_PX });
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  return ctx ? { canvas, ctx } : null;
}

/** A tile's index: column i, row j, i.e. device-pixel box
 *  [i·TILE_PX, (i+1)·TILE_PX) × [j·TILE_PX, (j+1)·TILE_PX) at the settled scale. */
export type TileKey = `${number},${number}`;
export const tileKey = (i: number, j: number): TileKey => `${i},${j}`;

interface TileEntry extends TileSurface {
  i: number;
  j: number;
  /** Paint frame that last used it; the current frame's tiles are never evicted. */
  usedAt: number;
}

/** Tiles keyed by index with least-recently-used eviction. Knows nothing about
 *  strokes: the renderer decides what to paint and what to invalidate. */
export class TileCache {
  private readonly tiles = new Map<TileKey, TileEntry>();
  /** Surfaces of dropped tiles, kept for the next tile: making a canvas costs
   *  more than clearing one, and scrolling drops and paints tiles all the time. */
  private readonly spare: TileSurface[] = [];
  /** Maximum tiles kept (set from the viewport; see `tileBudget`). */
  capacity = 0;

  get size(): number { return this.tiles.size; }

  get(i: number, j: number, frame: number): TileSurface | undefined {
    const tile = this.tiles.get(tileKey(i, j));
    if (tile) tile.usedAt = frame;
    return tile;
  }

  has(i: number, j: number): boolean { return this.tiles.has(tileKey(i, j)); }

  /** A dropped tile's surface to paint over, if there is one. */
  takeSpare(): TileSurface | undefined { return this.spare.pop(); }

  private drop(key: TileKey, tile: TileEntry): void {
    this.tiles.delete(key);
    if (this.spare.length < this.capacity) this.spare.push({ canvas: tile.canvas, ctx: tile.ctx });
  }

  /** Store a freshly painted tile, evicting the oldest ones from earlier frames
   *  when over capacity. */
  put(i: number, j: number, surface: TileSurface, frame: number): void {
    this.tiles.set(tileKey(i, j), { ...surface, i, j, usedAt: frame });
    for (const [key, tile] of this.tiles) {
      if (this.tiles.size <= this.capacity) break;
      if (tile.usedAt !== frame) this.drop(key, tile);
    }
  }

  /** Drop every tile whose device-pixel box meets the document box
   *  [minX, minY, maxX, maxY] drawn at `devicePerDoc` (settled scale × dpr),
   *  with a pixel of slack for anti-aliased edges. */
  invalidate(box: readonly [number, number, number, number], devicePerDoc: number): void {
    const [minX, minY, maxX, maxY] = box;
    const x0 = minX * devicePerDoc - 1, x1 = maxX * devicePerDoc + 1;
    const y0 = minY * devicePerDoc - 1, y1 = maxY * devicePerDoc + 1;
    for (const [key, tile] of this.tiles) {
      const left = tile.i * TILE_PX, top = tile.j * TILE_PX;
      if (x1 >= left && x0 <= left + TILE_PX && y1 >= top && y0 <= top + TILE_PX) this.drop(key, tile);
    }
  }

  /** Drop every tile (their surfaces stay available for reuse). */
  clear(): void {
    for (const [key, tile] of this.tiles) this.drop(key, tile);
  }

  /** Drop everything, spare surfaces included. */
  release(): void {
    this.tiles.clear();
    this.spare.length = 0;
  }
}

/** Tiles worth keeping for a canvas of `width` × `height` device pixels: the
 *  visible grid plus a spare row (a scroll that has not yet outgrown the tiles keeps them), capped by
 *  MAX_TILE_PIXELS. */
export function tileBudget(width: number, height: number): number {
  const cols = Math.ceil(width / TILE_PX) + 1;
  const rows = Math.ceil(height / TILE_PX) + 1;
  return Math.min(Math.floor(MAX_TILE_PIXELS / (TILE_PX * TILE_PX)), cols * (rows + 1));
}
