// Quoting a region of a handwriting page: the geometry of the frame the person drags, and the text
// that goes on the clipboard. The syntax and its reading are @onden/markdown inkRegion.ts; this
// file only makes regions (a drag, in page units, kept on the page and not smaller than a speck)
// and writes the embed for one.

import { INK_REGION_MIN, formatInkRegion, type InkRegion } from "@onden/markdown/ink";
import { nodeRefTarget } from "@onden/markdown";
import { linkNameTargets, type WikilinkNode } from "./wikilinks";

type Point = { x: number; y: number };
type PageSize = { width: number; height: number };
export type RegionCorner = "nw" | "ne" | "sw" | "se";

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The frame dragged from `a` to `b` (page units), kept on the page. Null while it is smaller than a
 *  deliberate quote in either direction (a tap, a twitch): no frame is made. */
export function regionFromDrag(page: string, a: Point, b: Point, size: PageSize): InkRegion | null {
  const x1 = clamp(Math.min(a.x, b.x), 0, size.width), x2 = clamp(Math.max(a.x, b.x), 0, size.width);
  const y1 = clamp(Math.min(a.y, b.y), 0, size.height), y2 = clamp(Math.max(a.y, b.y), 0, size.height);
  return x2 - x1 < INK_REGION_MIN || y2 - y1 < INK_REGION_MIN
    ? null
    : { page, x: Math.round(x1), y: Math.round(y1), w: Math.round(x2 - x1), h: Math.round(y2 - y1) };
}

/** `region` with `corner` pulled to `to`: the opposite corner stays, the frame never gets smaller than
 *  INK_REGION_MIN, flips over itself, or leaves the page. */
export function resizeRegion(region: InkRegion, corner: RegionCorner, to: Point, size: PageSize): InkRegion {
  const west = corner === "nw" || corner === "sw", north = corner === "nw" || corner === "ne";
  const fixedX = west ? region.x + region.w : region.x, fixedY = north ? region.y + region.h : region.y;
  const px = clamp(to.x, 0, size.width), py = clamp(to.y, 0, size.height);
  const x = west ? Math.min(px, fixedX - INK_REGION_MIN) : fixedX, x2 = west ? fixedX : Math.max(px, fixedX + INK_REGION_MIN);
  const y = north ? Math.min(py, fixedY - INK_REGION_MIN) : fixedY, y2 = north ? fixedY : Math.max(py, fixedY + INK_REGION_MIN);
  const left = clamp(x, 0, size.width - INK_REGION_MIN), right = clamp(x2, INK_REGION_MIN, size.width);
  const top = clamp(y, 0, size.height - INK_REGION_MIN), bottom = clamp(y2, INK_REGION_MIN, size.height);
  return { page: region.page, x: Math.round(left), y: Math.round(top), w: Math.round(right - left), h: Math.round(bottom - top) };
}

/** `region` moved by (dx, dy), kept on the page. */
export function moveRegion(region: InkRegion, dx: number, dy: number, size: PageSize): InkRegion {
  return {
    ...region,
    // Not rounded: a slow drag at high zoom moves less than a unit per step, and rounding each step would drop it.
    x: clamp(region.x + dx, 0, size.width - region.w),
    y: clamp(region.y + dy, 0, size.height - region.h),
  };
}

/** Whether `![[title]]` can name `note` and no other note: every note the link rule (the rule in lib/wikilinks —
 *  title, slug, alias, `.excalidraw`, case) lets that name reach is this one. Another note it could reach — a same
 *  title, "sketch" for "Sketch", a slug or alias — would take the embed wherever it is pasted. */
export function titleNamesNote(note: { id: string; title: string }, nodes: readonly WikilinkNode[]): boolean {
  const reached = linkNameTargets(nodes)(note.title);
  return reached.some((n) => n.id === note.id) && reached.every((n) => n.id === note.id);
}

/** What 「複製引用」 puts on the clipboard: the embed of `region` of the note. The note is named by its
 *  title, as every embed is, unless that could not say which note (the same title twice) or could not
 *  be written inside `![[ ]]` — then by the note's own id, which the app resolves too (the published
 *  site shows such an embed as a placeholder). */
export function inkRegionEmbedText(note: { id: string; title: string; titleNamesNote: boolean }, region: InkRegion): string | null {
  const written = formatInkRegion(region);
  if (!written) return null;
  const title = note.title.trim();
  const plain = title !== "" && !/[[\]|#\n]/.test(title) && note.titleNamesNote;
  return `![[${plain ? title : nodeRefTarget(note.id)}|${written}]]`;
}
