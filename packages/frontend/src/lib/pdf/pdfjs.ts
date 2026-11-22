// The one place Onden loads pdf.js. Both the viewer (usePdfDocument, drawn by PdfPageBackground) and text
// extraction (extractText) go through loadPdfCore(), so they share a single
// core instance and the same worker.
//
// LEGACY BUILD, on purpose (2026-10-18). The default ("modern") pdfjs-dist 6
// build targets only the newest Chrome and Firefox. It calls about ten
// built-ins with no feature check, among them Map#getOrInsertComputed
// (Chrome 145, Safari 26.2, Firefox 144), Math.sumPrecise (Chrome 147) and
// Uint8Array#toBase64/toHex. On an older browser or Android WebView the viewer
// throws in PDFViewer.setDocument. The legacy build is the same code with
// core-js polyfills bundled into the library, the viewer AND the worker.
// pdf.js says it supports Chrome 125+, Firefox ESR and Safari 18+.
// That is too many features for a hand-written polyfill, which would also have
// to be injected into the worker scope separately.
// src/test/pdfjsCompat.test.ts fails if a pdfjs-dist upgrade adds a new
// unguarded built-in that the legacy build does not polyfill.
//
// VERSION LOCK: pdf.js requires the worker to match the API version exactly.
// When bumping pdfjs-dist, copy
//   node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs
// to public/pdf.worker.min.mjs. pdfjsCompat.test.ts checks that the two files
// are byte-identical.

import { documentBaseUrl } from "../documentAccess";

export type PdfJsCore = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

/** The vendored legacy worker (see VERSION LOCK), as the web and Android builds serve it: at the site root. */
export const PDF_WORKER_SRC = "/pdf.worker.min.mjs";

/** Where this page finds the worker. The browser version can be served from a sub-folder (a preview address per pull request,
 *  `base: "./"`), so it asks next to its own page like sql.js does; the other builds are always at the root. */
function pdfWorkerAddress(): string {
  const base = import.meta.env.VITE_BROWSER_APP === "true" ? documentBaseUrl() : undefined;
  return base ? new URL(PDF_WORKER_SRC.slice(1), base).href : PDF_WORKER_SRC;
}

let corePromise: Promise<PdfJsCore> | null = null;

/** Lazily import the pdf.js core (legacy build) and point it at the worker. */
export function loadPdfCore(): Promise<PdfJsCore> {
  corePromise ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((core) => {
    core.GlobalWorkerOptions.workerSrc = pdfWorkerAddress();
    return core;
  });
  return corePromise;
}
