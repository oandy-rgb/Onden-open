// Loading a note's drawing-related attributes (ink_data, pdf_annotations,
// pdf_url) for an ink surface. The local mirror holds every stroke the moment
// it is drawn (persistInkAttribute mirrors before it queues), so while any
// write to this note's attributes is still queued, the mirror is the truth:
// reading the server then would load the version from before those strokes,
// and the next save — a whole-document overwrite — would erase them. With
// nothing queued, the server answers (it may hold another device's edits);
// offline or on a network error, the mirror does.

import { decodeInk as decodeSharedInk, encodeInk as encodeSharedInk, type DecodedInk, type InkAnnotation, type InkEnvelope } from "@onden/markdown/ink";
import { isInkReadOnly, INK_DATA_ATTR, INK_PAGE_ATTRS } from "@onden/markdown/ink";
import { addToast } from "../appStore";
import { reads } from "../data";
import { t } from "../i18n";
import type { InkDocument } from "./types";

export type InkAttributeKey = "ink_data" | "board_ink" | "note_ink" | "page_text" | "page_images" | "pdf_annotations" | "pdf_url";

export async function loadInkAttributes<K extends InkAttributeKey>(nodeId: string, keys: readonly K[]): Promise<Record<K, string | null>> {
  return reads.notes.attributeValues(nodeId, keys);
}

// ── The one ink_data codec ─────────────────────────────────────────────────
// ink_data holds one of two shapes: a single page (handwriting note, canvas
// layer) or the PDF envelope {version:1, pages, annotations} — the PDF's
// per-page strokes AND its highlight/drawing records, so one PDF edit is one
// attribute write. Every reader decodes here; nothing else parses ink_data.
// The codec itself is shared with the server (@onden/markdown/ink), which
// merges a save into what another device stored meanwhile.

export type { DecodedInk };

/** Decode a stored ink_data value. Empty, unreadable or unrecognised values
 *  are "none" (a note opens an empty surface instead of failing); a PDF
 *  envelope keeps only its readable pages. `A` is the host's highlight record
 *  type (the PDF's, lib/pdf/pdfAdapter) — this module does not know it. */
export function decodeInk<A extends InkAnnotation = InkAnnotation>(raw: string | null | undefined): DecodedInk<A> {
  return decodeSharedInk<A>(raw);
}

/** The attributes a single drawing page lives in: `ink_data` (a handwriting page) or `board_ink` (the pen
 *  layer of the note's whiteboard view). Two places, one format: a page drawn on a board is not the note's content. */
export type InkPageAttr = typeof INK_PAGE_ATTRS[number];

/** A single-page surface's drawing: its page in `attr`, or null for none yet. A PDF envelope is not a
 *  page and loads as null — saving a page over it would lose the PDF's strokes and highlights. */
export async function loadInkPage(nodeId: string, attr: InkPageAttr = INK_DATA_ATTR): Promise<InkDocument | null> {
  const stored = (await loadInkAttributes(nodeId, [attr] as const))[attr];
  const ink = decodeInk(stored);
  return ink.kind === "page" ? ink.doc : null;
}

/** The stored form of either shape. */
export function encodeInk(doc: InkDocument | InkEnvelope): string {
  return encodeSharedInk(doc);
}

// ── Drawings made with a newer version ──────────────────────────────────────
// A drawing whose `requires` names a feature this version lacks opens read-only
// (@onden/markdown/ink, Format evolution). Hosts read the flag with
// isInkReadOnly and tell the person once per opened drawing; saveInk refuses to
// write it either way.

export { isInkReadOnly };

export const inkReadOnlyMessage = (): string =>
  t("This drawing was made with a newer version of Onden, so it is read-only here. Update the app to edit it.");

/** The one notice for a read-only drawing. */
export function notifyInkReadOnly(): void {
  addToast(inkReadOnlyMessage(), "info");
}
