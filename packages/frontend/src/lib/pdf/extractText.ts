import { trimLineSpaces } from "../textScan";
import { loadPdfCore } from "./pdfjs";
import { cutToUnits } from "@onden/markdown";
// PDF text extraction for RAG. The PDF page background (PdfPageBackground) renders a
// visible text layer but never persists the text, so an uploaded paper stores
// markdown:'' and is invisible to embeddings/Ask. This module pulls the full
// text out of the SAME pdfjs getTextContent pipeline at upload time, so the
// node body — and therefore the semantic embedding (embeddings.ts embeds
// title+markdown) — actually contains the paper.
//
// The pdfjs *import* (worker, ~MB) lives here lazily; the assembly half
// (pageItemsToText / clampForEmbedding) is pure so it stays unit-testable
// without spinning up a worker.

/** The subset of a pdfjs TextItem we read. pdfjs also emits TextMarkedContent
 *  entries (no `str`); those are skipped. */
export interface PdfTextItemLike {
  str?: string;
  /** pdfjs sets this when the item ends a line (so the next item is a new line). */
  hasEOL?: boolean;
  [other: string]: unknown;
}

/** Collapse one page's getTextContent items into a text string: join runs on a
 *  line, break on hasEOL. pdfjs already orders items in reading order. */
export function pageItemsToText(items: PdfTextItemLike[]): string {
  let out = "";
  for (const item of items) {
    if (typeof item.str !== "string") continue; // marked-content marker
    out += item.str;
    if (item.hasEOL) out += "\n";
  }
  // Squash the runs of spaces/blank lines pdfjs leaves between glyph clusters.
  return out
    .replace(/[ \t]+/g, " ")
    // Spaces around line breaks (trimLineSpaces: linear on long space runs).
    .replace(/[\s\S]*/, (s) => trimLineSpaces(s))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Join per-page text with a blank line; drop empty pages (scanned/figure-only
 *  pages contribute nothing and would just be blank gaps). */
export function joinPages(pages: string[]): string {
  return pages.map((p) => p.trim()).filter(Boolean).join("\n\n").trim();
}

// Embeddings run on a small local model with a bounded context; a 40-page paper
// would blow it out and the tail would be silently truncated mid-pipeline.
// Cap the stored body at a generous size — enough for Ask to retrieve the paper
// and cite it, without persisting a megabyte of glyphs into the node body.
export const PDF_TEXT_CHAR_LIMIT = 60_000;

/** Clamp extracted text to the embedding-friendly limit, cutting on a paragraph
 *  boundary when possible so we don't slice a sentence in half. */
export function clampForEmbedding(text: string, limit = PDF_TEXT_CHAR_LIMIT): string {
  if (text.length <= limit) return text;
  const head = cutToUnits(text, limit);
  const lastBreak = head.lastIndexOf("\n\n");
  return (lastBreak > limit * 0.6 ? head.slice(0, lastBreak) : head).trim();
}

/** Duck-typed pdfjs document, so this module doesn't depend on the heavy
 *  viewer types and tests can supply a fake. */
interface PdfDocumentLike {
  numPages: number;
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: PdfTextItemLike[] }> }>;
  destroy?(): Promise<void>;
}

type GetDocument = (args: { data: ArrayBuffer }) => { promise: Promise<PdfDocumentLike> };

async function textOfPages(doc: PdfDocumentLike): Promise<string> {
  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pages.push(pageItemsToText(content.items));
    // Only the first PDF_TEXT_CHAR_LIMIT characters are kept: stop reading pages once there is enough.
    if (pages.reduce((total, text) => total + text.length, 0) >= PDF_TEXT_CHAR_LIMIT) break;
  }
  return clampForEmbedding(joinPages(pages));
}

/** Walk every page, concatenate text. Exposed (with an injectable getDocument)
 *  for tests; production callers use extractPdfText below. */
export async function extractTextFromDocument(
  buffer: ArrayBuffer,
  getDocument: GetDocument,
): Promise<string> {
  const doc = await getDocument({ data: buffer }).promise;
  try {
    return await textOfPages(doc);
  } finally {
    await doc.destroy?.().catch(() => undefined);
  }
}

/** What extraction found. "none": the PDF opened and has no text layer (a scan, or only pictures).
 *  "failed": the file could not be read at all (encrypted, damaged, the pdf.js worker did not start). */
export type PdfTextResult = { status: "text" | "none" | "failed"; text: string };

const resultOf = (text: string): PdfTextResult => ({ status: text ? "text" : "none", text });

/** Extract the full text of a PDF File. Never throws, so an upload still succeeds; the status
 *  tells a scan ("none") from a file that could not be read ("failed"). */
export async function extractPdfText(file: File | Blob): Promise<PdfTextResult> {
  try {
    const buffer = await file.arrayBuffer();
    const core = await loadPdfCore();
    const getDocument = core.getDocument as unknown as GetDocument;
    return resultOf(await extractTextFromDocument(buffer, getDocument));
  } catch {
    return { status: "failed", text: "" };
  }
}
