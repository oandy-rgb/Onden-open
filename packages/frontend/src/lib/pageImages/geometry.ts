// Where a picture goes and how it changes size, in page units. Pure.

import { PAGE_IMAGE_DEFAULT_WIDTH, PAGE_IMAGE_MIN_SIDE } from "@onden/markdown/page-images";

export type Rect = { x: number; y: number; w: number; h: number };
export type Corner = "nw" | "ne" | "sw" | "se";

/** The size a newly inserted picture gets: its own proportions, a comfortable
 *  width (never wider than the page, never tiny), and not taller than `maxHeight`.
 *  `natural` is null when the picture's size could not be read: 4:3. */
export function insertedSize(natural: { width: number; height: number } | null, pageWidth: number, maxHeight: number): { w: number; h: number } {
  const ratio = natural && natural.width > 0 && natural.height > 0 ? natural.width / natural.height : 4 / 3;
  let w = Math.min(PAGE_IMAGE_DEFAULT_WIDTH, pageWidth);
  if (natural && natural.width > 0) w = Math.min(w, natural.width); // a small picture is not blown up
  w = Math.max(PAGE_IMAGE_MIN_SIDE, w);
  if (w / ratio > maxHeight) w = Math.max(PAGE_IMAGE_MIN_SIDE, maxHeight * ratio);
  return { w, h: Math.max(PAGE_IMAGE_MIN_SIDE, w / ratio) };
}

/** The part of the page that is on screen, in page units: its top and height.
 *  `view` is the scrolling area and `page` the sheet, both as client rects;
 *  `pageWidth` is the sheet's width in page units. A page that is not on screen
 *  at all (or has no size yet) gives its top part. */
export function visiblePageBand(
  view: { top: number; bottom: number },
  page: { top: number; bottom: number; width: number },
  pageWidth: number,
): { top: number; height: number } {
  const scale = page.width > 0 ? page.width / pageWidth : 1;
  const top = Math.max(view.top, page.top), bottom = Math.min(view.bottom, page.bottom);
  if (!(bottom > top)) return { top: 0, height: Math.min(view.bottom - view.top, page.bottom - page.top) / scale || 0 };
  return { top: (top - page.top) / scale, height: (bottom - top) / scale };
}

/** The top-left that centres a `w` × `h` picture on the visible part of the
 *  page (`view`), kept on the page (`pageHeight`: its length so far). */
export function centeredIn(view: { top: number; height: number }, size: { w: number; h: number }, pageWidth: number, pageHeight = Infinity): { x: number; y: number } {
  return {
    x: Math.max(0, (pageWidth - size.w) / 2),
    y: Math.max(0, Math.min(pageHeight - size.h, view.top + (view.height - size.h) / 2)),
  };
}

/** `rect` moved by (dx, dy), kept on the page: within its width, below its top
 *  and (when the page's length is known) above its bottom edge. */
export function moved(rect: Rect, dx: number, dy: number, pageWidth: number, pageHeight = Infinity): Rect {
  return {
    ...rect,
    x: Math.max(0, Math.min(pageWidth - rect.w, rect.x + dx)),
    y: Math.max(0, Math.min(pageHeight - rect.h, rect.y + dy)),
  };
}

/** `rect` resized by dragging `corner` by (dx, dy): the opposite corner stays
 *  put and the proportions are kept. The drag counts along both sides (half
 *  from each), so a diagonal pull feels like what the corner does. */
export function resizedFromCorner(rect: Rect, corner: Corner, dx: number, dy: number, pageWidth: number, pageHeight = Infinity): Rect {
  const sx = corner.endsWith("e") ? 1 : -1;
  const sy = corner.startsWith("s") ? 1 : -1;
  const ratio = rect.w / rect.h;
  const wanted = rect.w + (sx * dx + sy * dy * ratio) / 2;
  const right = rect.x + rect.w, bottom = rect.y + rect.h;
  // As wide as the page allows from the fixed corner, and no smaller than a side may be.
  const room = Math.min(sx > 0 ? pageWidth - rect.x : right, sy > 0 ? (pageHeight - rect.y) * ratio : Infinity);
  const minW = Math.max(PAGE_IMAGE_MIN_SIDE, PAGE_IMAGE_MIN_SIDE * ratio);
  const w = Math.max(minW, Math.min(room, wanted));
  const h = w / ratio;
  return { w, h, x: sx > 0 ? rect.x : right - w, y: sy > 0 ? rect.y : Math.max(0, bottom - h) };
}
