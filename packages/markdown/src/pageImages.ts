// Pictures on a page (`page_images`) — the stored format and its three-way
// merge, one module for the app (lib/pageImages, which edits and saves it) and
// the server (which merges a save into what another device stored meanwhile,
// services/attributeWrites). Pure: no DOM, no pipeline imports. The sibling of
// the text boxes (pageText.ts), laid out the same way:
//
//   { v: 1, pages: { [pageKey]: { images: [{ id, x, y, w, h, src, alt, updated_at }] } } }
//
// It is its own attribute, not part of `ink_data` (pen strokes are drawn over
// the pictures, and the stroke format changes on its own) and not part of
// `page_text` (a picture and a caption are different edits and never merge
// against each other).
//
// pageKey is the one of pageText.ts (`page` for a handwriting note, `pdf:<n>`
// and `slide:<id>` reserved). Coordinates and sizes are PAGE UNITS, independent
// of zoom: x/y the picture's top-left, w/h its size (the picture keeps the
// aspect ratio it was inserted with). Pictures are drawn in list order, later
// ones over earlier ones, all under the pen strokes.
//
// `src` is the picture's media address, `/api/media/<id>` (media grammar:
// mediaRefs.ts), so the server's ownership claim and read check find it in the
// attribute like any other reference. Anything else is not a picture and is
// dropped when read. `alt` is the picture's description (the file's name).
//
// Merge, by picture id and per page: pictures added on either side are kept;
// changed on one side only: that side's version; changed on both differently:
// the incoming (later) save wins and the stored version is reported as a
// conflict, so a person can get it back; removed on one side, changed on the
// other: the change is kept (reported). Unknown fields travel unchanged, and a
// value with `v` above PAGE_IMAGES_VERSION is opened read-only
// (isPageImagesReadOnly).

import { cutToGraphemes } from "./graphemes.js";
import { isJsonRecord as isRecord, mergeById, parseJsonRecord } from "./jsonMerge.js";
import { MEDIA_URL_PREFIX, isMediaId } from "./mediaRefs.js";

export const PAGE_IMAGES_VERSION = 1;
export const PAGE_IMAGES_ATTRIBUTE = "page_images";
/** A picture is never smaller than this on a side (page units). */
export const PAGE_IMAGE_MIN_SIDE = 40;
export const PAGE_IMAGE_DEFAULT_WIDTH = 360;
/** More than this on one page is not a handwriting page any more; the rest are dropped when read. */
export const PAGE_IMAGES_MAX_PER_PAGE = 100;
export const PAGE_IMAGE_ALT_MAX = 120;

export type PageImage = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** `/api/media/<id>` */
  src: string;
  alt: string;
  /** ISO time of the last edit of this picture. */
  updated_at: string;
};
export type PageImagesPage = { images: PageImage[] };
export type PageImagesDoc = { v: 1; pages: Record<string, PageImagesPage> };

export type PageImagesConflict = { pageKey: string; id: string };
export type PageImagesMergeResult = { value: string; conflicts: PageImagesConflict[] };

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export const emptyPageImages = (): PageImagesDoc => ({ v: 1, pages: {} });

/** Whether `src` is a stored picture's address: `/api/media/<media id>`, nothing before or after. */
export function isPageImageSrc(src: unknown): src is string {
  return typeof src === "string" && src.startsWith(MEDIA_URL_PREFIX) && isMediaId(src.slice(MEDIA_URL_PREFIX.length));
}

/** One stored picture repaired to a usable one, or null when it has no id or
 *  no address of ours. Fields this version does not know stay on it. */
function readImage(raw: unknown): PageImage | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || raw.id === "" || !isPageImageSrc(raw.src)) return null;
  return {
    ...raw,
    id: raw.id,
    x: finite(raw.x) ? raw.x : 0,
    y: finite(raw.y) ? raw.y : 0,
    w: finite(raw.w) ? Math.max(PAGE_IMAGE_MIN_SIDE, raw.w) : PAGE_IMAGE_DEFAULT_WIDTH,
    h: finite(raw.h) ? Math.max(PAGE_IMAGE_MIN_SIDE, raw.h) : PAGE_IMAGE_DEFAULT_WIDTH,
    src: raw.src,
    alt: typeof raw.alt === "string" ? cutToGraphemes(raw.alt, PAGE_IMAGE_ALT_MAX) : "",
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : "",
  };
}

/** The pictures in a stored value; empty for none or an unreadable value.
 *  Malformed pictures are repaired or dropped; unknown fields are kept. */
export function decodePageImages(raw: string | null | undefined): PageImagesDoc {
  const value = parseJsonRecord(raw);
  if (!value || !isRecord(value.pages)) return emptyPageImages();
  const pages: Record<string, PageImagesPage> = {};
  for (const [key, page] of Object.entries(value.pages)) {
    if (!isRecord(page) || !Array.isArray(page.images)) continue;
    const seen = new Set<string>();
    const images: PageImage[] = [];
    for (const item of page.images) {
      const image = readImage(item);
      if (!image || seen.has(image.id) || images.length >= PAGE_IMAGES_MAX_PER_PAGE) continue; // a duplicated id keeps its first picture
      seen.add(image.id);
      images.push(image);
    }
    pages[key] = { ...page, images };
  }
  return { ...value, v: 1, pages } as PageImagesDoc;
}

/** The stored form: pages without pictures are left out, so a note whose
 *  pictures were all removed stores almost nothing. */
export function encodePageImages(doc: PageImagesDoc): string {
  const pages: Record<string, PageImagesPage> = {};
  for (const [key, page] of Object.entries(doc.pages)) {
    if (page.images.length > 0) pages[key] = page;
  }
  return JSON.stringify({ ...doc, v: PAGE_IMAGES_VERSION, pages });
}

/** Written by a newer version that this one must not edit (it would drop what
 *  it does not understand): show it, never save it. */
export function isPageImagesReadOnly(raw: string | null | undefined): boolean {
  const version = parseJsonRecord(raw)?.v;
  return finite(version) && version > PAGE_IMAGES_VERSION;
}

export const pageImagesOf = (doc: PageImagesDoc, pageKey: string): readonly PageImage[] => doc.pages[pageKey]?.images ?? [];

// ── Three-way merge ────────────────────────────────────────────────────────

/** Merge a save of the pictures into what is stored. `base` is the value the
 *  incoming save was made from; `stored` the current one, which another device
 *  may have changed since. Pure and deterministic. */
export function mergePageImages(base: string | null | undefined, stored: string | null | undefined, incoming: string): PageImagesMergeResult {
  const conflicts: PageImagesConflict[] = [];
  const b = decodePageImages(base), s = decodePageImages(stored), i = decodePageImages(incoming);
  const pages: Record<string, PageImagesPage> = {};
  const keys = new Set([...Object.keys(s.pages), ...Object.keys(i.pages)]);
  for (const key of [...keys].sort()) {
    const images = mergeById(
      b.pages[key]?.images ?? [], s.pages[key]?.images ?? [], i.pages[key]?.images ?? [],
      (id) => conflicts.push({ pageKey: key, id }),
    );
    pages[key] = { ...s.pages[key], ...i.pages[key], images };
  }
  return { value: encodePageImages({ ...s, ...i, v: 1, pages }), conflicts };
}

/** What a merge conflict reverts to: `merged` with only the pictures both sides
 *  changed (`conflicts`) taken back from `overridden` — swapped, removed when
 *  that side had none, or re-added when only it had it. Merging the result over
 *  the pictures as they are now (base = `merged`) re-applies just those. */
export function revertPageImagesConflicts(merged: string, overridden: string, conflicts: readonly PageImagesConflict[]): string {
  const doc = decodePageImages(merged);
  const theirs = decodePageImages(overridden);
  const pages = { ...doc.pages };
  for (const { pageKey, id } of conflicts) {
    const images = [...(pages[pageKey]?.images ?? [])];
    const other = theirs.pages[pageKey]?.images.find((image) => image.id === id);
    const at = images.findIndex((image) => image.id === id);
    if (at < 0) { if (other) images.push(other); }
    else if (other) images[at] = other;
    else images.splice(at, 1);
    pages[pageKey] = { ...pages[pageKey], images };
  }
  return encodePageImages({ ...doc, pages });
}
