// A region of a handwriting page, named inside an embed: `![[筆記|ink=頁@x,y,w,h]]`.
// The one reading of that parameter (the app's editor and preview, the published site and the
// exports all come here): a page of the note's drawing (its key — `page` for the first, a uuid for
// the others, stable when pages are added or moved) and a rectangle in that page's own units
// (inkPages.ts: 1000 wide whatever the zoom), whole units, top-left corner + size.
//
// It rides in the embed's `|` part, as Obsidian's `![[image|100x145]]` size does: a reader that
// does not know it takes the part for a label and draws the whole drawing, which is the fallback
// we want. A region is a place on a page, not a set of strokes: strokes erased or rewritten leave
// the region valid, and what is written in it later shows too.
//
// Turning it into an anchor later is mechanical: the anchor's note is the embed's target, its
// kind "ink region", its key `page`, its position the rectangle (x, y, w, h).

export type InkRegion = { page: string; x: number; y: number; w: number; h: number };

/** Smallest region worth quoting, in page units: below this the picture would be a speck. */
export const INK_REGION_MIN = 24;

const PAGE_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const NUM = "(-?\\d{1,7})";
const REGION_SOURCE = `ink=([A-Za-z0-9_-]{1,64})@${NUM},${NUM},(\\d{1,7}),(\\d{1,7})`;
const REGION = new RegExp(`^${REGION_SOURCE}$`);
/** The embed parameter for `region`, rounded to whole units; null when the page key could not be read back. */
export function formatInkRegion(region: InkRegion): string | null {
  if (!PAGE_KEY.test(region.page)) return null;
  const n = [region.x, region.y, region.w, region.h];
  if (!n.every(Number.isFinite)) return null;
  return `ink=${region.page}@${Math.round(region.x)},${Math.round(region.y)},${Math.max(0, Math.round(region.w))},${Math.max(0, Math.round(region.h))}`;
}

/** The region an embed's `|` part names, or null when it is anything else (a label). */
export function parseInkRegion(text: string): InkRegion | null {
  const m = REGION.exec(text.trim());
  if (!m) return null;
  const [x, y, w, h] = [Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  return w > 0 && h > 0 ? { page: m[1]!, x, y, w, h } : null;
}

/** `region` kept inside a page of `width` × `height` units: moved in when it hangs over an
 *  edge, cut to the page when larger. Null when nothing of it is on the page. */
export function clampInkRegion(region: InkRegion, size: { width: number; height: number }): InkRegion | null {
  const x1 = Math.max(0, region.x), y1 = Math.max(0, region.y);
  const x2 = Math.min(size.width, region.x + region.w), y2 = Math.min(size.height, region.y + region.h);
  return x2 > x1 && y2 > y1 ? { page: region.page, x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null;
}

