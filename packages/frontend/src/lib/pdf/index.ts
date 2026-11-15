// Public surface of lib/pdf. Older callers still import the files directly
// (grandfathered in eslint-rules/module-entry-allowlist.json); new imports go
// through here.
//
//   pdfjs       — loadPdfCore(): the one pdf.js loader (legacy build + vendored worker)
//   pdfAdapter  — the PDF note's ink_data envelope (InkMultiPageDoc) and its edits/summaries
//   pageUnits   — a PDF note's drawing as pages in page units (what each page's ink engine
//                 loads and saves), converted from / written to the older fields

export { loadPdfCore, PDF_WORKER_SRC, type PdfJsCore } from "./pdfjs";
export type { PageViewportLike } from "./coords";
export { emptyPageDoc, pagesFromLegacy, pdfPageDoc, readPdfInk, recordFrame, setPdfPageDoc, withUnits } from "./pageUnits";
export {
  addDrawingToPage,
  addShapeToPage,
  decodePdfInk,
  describeInkValueChange,
  diffMultiPage,
  drawingStrokeId,
  drawingStrokesToInk,
  emptyMultiPageDoc,
  summarizeInkValue,
  type InkMultiPageDoc,
  type PdfDrawingStroke,
  type PdfShapeData,
} from "./pdfAdapter";
