// A Markdown export carries drawings as pictures: the SVG the app, the embeds
// and the published site already draw (@onden/markdown/ink), written under
// attachments/ and embedded at the end of the note. The editable strokes
// (`ink_data`, `page_text`) stay out of the Markdown, as they always did; the
// full backup carries them (services/backupArchive.ts).
//
//   handwriting page   each page as a sheet on paper (inkPages)
//   whiteboard note    its ink layer (`board_ink`), cropped to the strokes
//                      (inkToSvg): the strokes sit in board coordinates, not on
//                      a page; then any handwriting pages of the note itself
//   PDF note           each page's strokes and text boxes alone (inkOverlayToSvg);
//                      the PDF itself is not redrawn

import { HANDWRITING_LAYOUT } from "@onden/markdown";
import { decodeInk, currentUnits, inkOverlayToSvg, inkPages, inkToSvg, pdfPageOfKey } from "@onden/markdown/ink";
import { decodePageText, pageTextBoxes } from "@onden/markdown/page-text";
import { hasWhiteboardTab } from "./boardStore.js";
import { isCanvas } from "@onden/markdown/contract";

export type InkSvgFile = { name: string; svg: string };

type NoteInk = { id: string; node_type: string; collection_views: unknown };

const hasHandwritingTab = (views: unknown): boolean =>
  Array.isArray(views) && views.some((v) => !!v && typeof v === "object" && (v as { layout?: unknown }).layout === HANDWRITING_LAYOUT);

const value = (attributes: ReadonlyArray<{ key: string; value: string }>, key: string) => attributes.find((a) => a.key === key)?.value;

/** The pictures of a note's drawing, in reading order; none when it has
 *  none. Names are `ink-<note>-<n>.svg`, unique within `taken` (which this adds to). */
export function noteInkFiles(note: NoteInk, attributes: ReadonlyArray<{ key: string; value: string }>, taken: Set<string>): InkSvgFile[] {
  const views = note.collection_views;
  const ink = value(attributes, "ink_data");
  const textRaw = value(attributes, "page_text");
  const svgs: string[] = [];
  if (value(attributes, "pdf_url") !== undefined) {
    const decoded = decodeInk(ink);
    const units = decoded.kind === "pdf" ? currentUnits(decoded.doc) : null;
    const texts = decodePageText(textRaw);
    const keys = new Set([...Object.keys(units?.pages ?? {}), ...Object.keys(texts.pages).filter((k) => pdfPageOfKey(k) !== null)]);
    const ordered = [...keys].sort((a, b) => (pdfPageOfKey(a) ?? 0) - (pdfPageOfKey(b) ?? 0));
    for (const key of ordered) {
      const page = units?.pages[key];
      const size = page?.size ?? { width: 1000, height: 1414 };
      const svg = inkOverlayToSvg({ size, doc: page?.doc ?? { version: 1, strokes: [], erased: {}, page: { width: size.width } } }, pageTextBoxes(texts, key));
      if (svg) svgs.push(svg);
    }
  } else if (isCanvas(note) || hasWhiteboardTab(views)) {
    // The board's layer (`board_ink`), then the note's own handwriting pages
    // (`ink_data`) as sheets, when it has any.
    const svg = inkToSvg(value(attributes, "board_ink"));
    if (svg) svgs.push(svg);
    svgs.push(...inkPages(ink).map((page) => page.draw()));
  } else {
    svgs.push(...inkPages(ink).map((page) => page.draw()));
  }
  // The strokes of a 手寫 tab (`note_ink`) follow whatever the note's content drew, but only while the note has the tab:
  // taking it away puts the strokes out of sight, and an export is what the person sees (a full backup keeps them).
  if (value(attributes, "pdf_url") === undefined && hasHandwritingTab(views)) svgs.push(...inkPages(value(attributes, "note_ink")).map((page) => page.draw()));
  return svgs.map((svg, i) => {
    let name = `ink-${note.id.split("-")[0]}-${i + 1}.svg`;
    if (taken.has(name)) name = `ink-${note.id}-${i + 1}.svg`;
    taken.add(name);
    return { name, svg };
  });
}

/** `markdown` with each picture embedded after its text, `up` being the way
 *  from the note's folder to the archive root ("./" or "../"). */
export function withInkEmbeds(markdown: string, files: ReadonlyArray<{ name: string }>, up: string): string {
  if (files.length === 0) return markdown;
  return `${markdown.trimEnd()}\n\n${files.map((f) => `![](${up}attachments/${f.name})`).join("\n\n")}\n`;
}
