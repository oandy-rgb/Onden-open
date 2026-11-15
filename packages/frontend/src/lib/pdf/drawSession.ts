// The PDF note's drawing session: lib/ink's page session, writing a page's drawing into the
// ink_data envelope (lib/pdf/pageUnits.ts). Page keys are `pdf:<n>`.

import { pdfPageOfKey } from "@onden/markdown/ink";
import { InkPageSession } from "../ink";
import type { InkMultiPageDoc } from "./pdfAdapter";
import { setPdfPageDoc } from "./pageUnits";

export type PdfDrawSession = InkPageSession<InkMultiPageDoc>;

export const createPdfDrawSession = (): PdfDrawSession => new InkPageSession<InkMultiPageDoc>((envelope, key, doc, ratio) => {
  const page = pdfPageOfKey(key);
  return page === null ? envelope : setPdfPageDoc(envelope, page, doc, ratio);
});
