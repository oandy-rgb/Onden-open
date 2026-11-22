/** One sentence for a PDF note (null for any other note): how much of the file is readable here, so a model does
 *  not guess at a file it cannot open. Where the text lives (today the body) is this one line's concern.
 *  When docs/architecture/proposals/pdf-pages-in-note-2026-11-16.md step 1–2 moves the text into the hidden `pdf_text`
 *  attribute, this reads that attribute instead, and the note creation (frontend lib/pdf/pdfNote.ts `pdfNoteInput`)
 *  stops writing the body, in the same change: notes made until then hold their text in the body. */
export function pdfNoteSummary(attributes: ReadonlyArray<{ key: string }>, markdown: string | null): string | null {
  if (!attributes.some((a) => a.key === "pdf_url")) return null;
  const chars = (markdown ?? "").trim().length;
  return chars > 0
    ? `This note is a PDF file. Its body holds ${chars} characters of text extracted from it (page pictures and handwriting on it are not available).`
    : "This note is a PDF file, but no text could be extracted from it (a scan or pictures only), and the file itself cannot be opened by this tool.";
}
