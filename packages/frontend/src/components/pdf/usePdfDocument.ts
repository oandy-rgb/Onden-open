// A PDF opened for the page book (kept out of lib/pdf, which the app's boot path imports): the document (pdf.js core, legacy build — see pdfjs.ts) and the
// shape of its pages. The shell (PdfNodeView) reads both and hands the book one page per PDF page.
//
// Page shapes must be known before a page is drawn, or the scroll would jump as pages are
// measured. Two ways were compared (docs/research/pdf-unify/step2-design.md, step c):
//   - read every page's viewport before showing anything: exact from the first frame, but a
//     300-page PDF waits for 300 page requests to the worker;
//   - lay every page out with the first page's shape at once, read the rest in the background and
//     correct the sheets that differ, the book keeping the point at the top of the view where it
//     was (PageBook: pages that change size). Chosen: it opens as soon as page 1 is read, and a
//     PDF whose pages are all alike (most are) never re-lays anything out.

import { useEffect, useMemo, useState } from "react";
import { loadPdfCore, type PdfJsCore } from "../../lib/pdf";

export type PdfDocument = Awaited<ReturnType<PdfJsCore["getDocument"]>["promise"]>;
export type PdfPage = Awaited<ReturnType<PdfDocument["getPage"]>>;

export interface LoadedPdf {
  core: PdfJsCore;
  doc: PdfDocument;
}

/** Opens `url`; null until it is open. The document is destroyed when the url changes or the view goes. */
export function usePdfDocument(url: string): { pdf: LoadedPdf | null; error: Error | null } {
  const [state, setState] = useState<{ url: string; pdf: LoadedPdf | null; error: Error | null }>({ url, pdf: null, error: null });
  useEffect(() => {
    let disposed = false;
    let task: { destroy(): Promise<void> } | null = null;
    void (async () => {
      try {
        const core = await loadPdfCore();
        if (disposed) return;
        // pdfjs 5+ dropped the bare-string overload — params object only.
        const opened = core.getDocument({ url });
        task = opened;
        const doc = await opened.promise;
        if (!disposed) setState({ url, pdf: { core, doc }, error: null });
      } catch (err) {
        if (!disposed) setState({ url, pdf: null, error: err instanceof Error ? err : new Error(String(err)) });
      }
    })();
    return () => {
      disposed = true;
      void task?.destroy().catch(() => null);
    };
  }, [url]);
  // A state left over from the previous url is not this url's.
  return state.url === url ? { pdf: state.pdf, error: state.error } : { pdf: null, error: null };
}

/** A page's height / width at scale 1, page rotation included (what the page looks like on screen). */
export function pageRatio(page: PdfPage): number {
  const viewport = page.getViewport({ scale: 1 });
  return viewport.height / viewport.width;
}

export interface PdfPageShapes {
  count: number;
  /** Height / width of page `n` (1-based): measured when it has been, the first page's until then. */
  ratio(n: number): number;
}

const SAME_RATIO = 0.0005;
const CHUNK = 24;

/** The shapes of a document's pages: after page 1 is read, every page has its shape; the others are
 *  read in chunks in the background, and a state change is made only when a chunk has a page that
 *  differs from the first. Null until page 1 is read. */
export function usePdfPageShapes(doc: PdfDocument | null): PdfPageShapes | null {
  const [measured, setMeasured] = useState<{ doc: PdfDocument; first: number; ratios: ReadonlyMap<number, number> } | null>(null);
  useEffect(() => {
    if (!doc) return;
    let disposed = false;
    void (async () => {
      try {
        const first = pageRatio(await doc.getPage(1));
        if (disposed) return;
        setMeasured({ doc, first, ratios: new Map() });
        const found = new Map<number, number>();
        for (let from = 2; from <= doc.numPages && !disposed; from += CHUNK) {
          const numbers = Array.from({ length: Math.min(CHUNK, doc.numPages - from + 1) }, (_, i) => from + i);
          const ratios = await Promise.all(numbers.map(async (n) => pageRatio(await doc.getPage(n))));
          if (disposed) return;
          let differs = false;
          numbers.forEach((n, i) => {
            if (Math.abs(ratios[i]! - first) > SAME_RATIO) { found.set(n, ratios[i]!); differs = true; }
          });
          if (differs) setMeasured({ doc, first, ratios: new Map(found) });
        }
      } catch {
        // A page that cannot be read keeps the first page's shape; the document's own error is the hook above's.
      }
    })();
    return () => { disposed = true; };
  }, [doc]);
  return useMemo(() => {
    if (!doc || !measured || measured.doc !== doc) return null;
    return { count: doc.numPages, ratio: (n) => measured.ratios.get(n) ?? measured.first };
  }, [doc, measured]);
}
