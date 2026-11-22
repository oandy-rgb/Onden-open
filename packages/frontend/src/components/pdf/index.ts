// Public surface of components/pdf: the PDF note's own pieces for the page book.
//
//   PdfPageBackground — a PDF page as a book page's background (canvas, selectable text, links)
//   PdfPageHighlights — a page's saved text and area highlights
//   usePdfDocument, usePdfPageShapes — a PDF opened for the book, and its pages' shapes

export { PdfPageBackground, type PdfPageBackgroundProps } from "./PdfPageBackground";
export { PdfPageHighlights } from "./PdfHighlights";
export { usePdfDocument, usePdfPageShapes, type LoadedPdf, type PdfPageShapes } from "./usePdfDocument";
