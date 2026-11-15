// Where a `![[…]]` embed gets its text and drawing: the data layer (store,
// one read for a slim note, the local mirror while a save is queued). Split
// from lib/embeds.ts, which is pure resolution and also loaded by the
// published site; only embedDom (the app) imports this file.
import { formatInkRegion, inkRegionToSvg, inkToSvg, type InkRegion, type InkRegionPicture } from "@onden/markdown/ink";
import type { WikilinkNode } from "./wikilinks";
import { reads } from "./data";
import { drawingChangeSerial } from "./drawingChanges";
import { mediaSrc } from "@onden/markdown";
import { ApiError, getApiBase, nodeNeedsBody } from "./api";
import type { SourceNode } from "./embeds";

const RELOAD_MS = 2000;

export type EmbedSource = { ok: true; markdown: string } | { ok: false; reason: "notFound" | "forbidden" | "unavailable" };

const bodies = new Map<string, { at: number; done: Promise<EmbedSource> }>();

/** The embedded note's Markdown. `forbidden`: the server refused (the reader
 *  may not read it); `notFound`: it is gone; `unavailable`: the read failed
 *  for another reason (offline) — the caller shows a link. */
export function embedSource(node: WikilinkNode): Promise<EmbedSource> {
  const row = node as SourceNode;
  if (typeof row.markdown === "string" && !nodeNeedsBody(row)) return Promise.resolve({ ok: true, markdown: row.markdown });
  const now = Date.now();
  const recent = bodies.get(node.id);
  if (recent && now - recent.at < RELOAD_MS) return recent.done;
  const done = reads.notes.full(node.id).then(
    (full): EmbedSource => ({ ok: true, markdown: full.markdown ?? "" }),
    (error): EmbedSource => {
      if (error instanceof ApiError && error.status === 403) return { ok: false, reason: "forbidden" };
      if (error instanceof ApiError && error.status === 404) return { ok: false, reason: "notFound" };
      return { ok: false, reason: "unavailable" };
    },
  );
  bodies.set(node.id, { at: now, done });
  return done;
}

// ── Drawings ───────────────────────────────────────────────────────────────
// A drawing's stored ink_data value is read once per RELOAD_MS (reads.notes.attributeValues, as
// lib/ink/store does: the server, or the local mirror while a save is queued or offline), shared
// by every picture of it: a note drawn in the editor and the split preview at once costs one
// request, and the whole-drawing picture and each quoted region (`![[drawing|ink=…]]`) of one
// drawing come from the same read. A picture is cached per stored value and redrawn only when it
// changed. A change announced here (lib/drawingChanges: a local save, or a sync from another device) makes the next read fresh.

type Drawn = { raw: string | null; svg: string | null };
const drawn = new Map<string, Drawn>();
type DrawingValues = { ink: string | null; text: string | null; images: string | null };
const pending = new Map<string, { at: number; serial: number; done: Promise<DrawingValues> }>();
const regions = new Map<string, { version: string; picture: InkRegionPicture }>();

/** The note's stored handwriting (and the text boxes and pictures laid on its pages); `ink` is null when it has none or is a PDF's. */
function drawingValues(nodeId: string): Promise<DrawingValues> {
  const now = Date.now();
  const recent = pending.get(nodeId);
  const serial = drawingChangeSerial(nodeId);
  // Shared by every picture of this note while it is fresh and no change was announced since it was read: N
  // quoted areas of one drawing cost one read per change, not N.
  if (recent && now - recent.at < RELOAD_MS && recent.serial === serial) return recent.done;
  const done = reads.notes.attributeValues(nodeId, ["ink_data", "pdf_url", "page_text", "page_images"] as const)
    .then(({ ink_data, pdf_url, page_text, page_images }): DrawingValues => ({ ink: pdf_url ? null : ink_data, text: page_text, images: page_images }));
  pending.set(nodeId, { at: now, serial, done });
  done.catch(() => pending.delete(nodeId));
  return done;
}

/** The note's drawing as an SVG string; null when the note has no
 *  handwriting page (no ink_data, an empty drawing, or a PDF's envelope). */
export function drawingSvg(nodeId: string): Promise<string | null> {
  return drawingValues(nodeId).then(({ ink: raw }) => {
    const cached = drawn.get(nodeId);
    if (cached && cached.raw === raw) return cached.svg;
    const svg = raw ? inkToSvg(raw) : null;
    drawn.set(nodeId, { raw, svg });
    return svg;
  });
}

/** The part of one page of the note's drawing inside `region` (`![[drawing|ink=…]]`): the picture, or
 *  why there is none (the page is gone, nothing is drawn there now, the rectangle is off the page). */
export function drawingRegion(nodeId: string, region: InkRegion): Promise<InkRegionPicture> {
  const key = `${nodeId}|${formatInkRegion(region)}`;
  return drawingValues(nodeId).then(({ ink, text, images }) => {
    const version = `${ink}\u0000${text}\u0000${images}`;
    const cached = regions.get(key);
    if (cached && cached.version === version) return cached.picture;
    const picture = inkRegionToSvg(ink, region, { text, images, withImages: true, imageSrc: (src) => mediaSrc(src, { apiBase: getApiBase() }) });
    regions.set(key, { version, picture });
    return picture;
  });
}

/** Forget cached drawings (tests). */
export function resetDrawingCache(): void {
  drawn.clear();
  pending.clear();
  regions.clear();
  bodies.clear();
}
