import type { CreateNote } from "../data";
import { t } from "../i18n";
import { extractPdfText, type PdfTextResult } from "./extractText";

// The one place a note is made from a PDF file: upload it, read its text, create the note with
// that text and the `pdf_url` attribute in ONE request. The drop on the editor, the create
// sheet's "Upload a file", the `/` menu's PDF page and any later door all come through here, so
// the same file is searchable and readable by the AI whichever door it came in by
// (guard: test/guards/fileIntake.guard.test.ts). Pages are lazy: pdf.js loads inside extractPdfText.

/** Said once when a PDF's text could not be read at all. A scanned PDF (no text layer) says nothing. */
export const PDF_TEXT_FAILED_MESSAGE = "The PDF was added, but its text could not be read, so search and AI cannot use it yet.";

/** The note's title: the file name without ".pdf". */
const pdfNoteTitle = (fileName: string): string => fileName.replace(/\.pdf$/i, "");

/** The PDF's text as a note body. A paper's own `[[1]]`, `#a=b` or `key:: value` would otherwise be read by the server
 *  as links and attributes of this note. Attribute lines are never read inside a code fence, so the text sits in one
 *  (longer than any backtick run inside it); `[[` is read even there, so a zero-width space is put between its brackets. */
function pdfTextAsBody(text: string): string {
  if (!text) return "";
  const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${fence}\n${text.replace(/\[(?=\[)/g, "[\u200b")}\n${fence}\n`;
}

/** The creation of a PDF note. The ONE line that decides where the extracted text lives is `markdown`. */
function pdfNoteInput(file: { name: string }, url: string, text: string): CreateNote {
  return { title: pdfNoteTitle(file.name), markdown: pdfTextAsBody(text), attributes: [{ key: "pdf_url", value: url }] };
}

/** Tells the person (once) when extraction failed; "none" (a scan) is not a failure. */
function reportPdfText(result: PdfTextResult, notify: (message: string) => void): void {
  if (result.status === "failed") notify(t(PDF_TEXT_FAILED_MESSAGE));
}

/** Uploads `file`, reads its text and creates the note. `create` is the door's own note creation
 *  (it adds parent / space); `notify` shows a plain message. Rejects only when the upload or the
 *  creation does: an unreadable PDF still becomes a note. */
export async function createPdfNote<Made>(
  file: File,
  { upload, create, notify, extract = extractPdfText, parentId }: {
    upload: () => Promise<string>;
    create: (input: CreateNote) => Promise<Made>;
    notify: (message: string) => void;
    extract?: (file: File) => Promise<PdfTextResult>;
    parentId?: string | null;
  },
): Promise<Made> {
  // Read first, upload second: closing the page during the (slow) read leaves no uploaded file without a note.
  const result = await extract(file);
  const url = await upload();
  const made = await create({ ...pdfNoteInput(file, url, result.text), ...(parentId ? { parent_id: parentId } : {}) });
  reportPdfText(result, notify);
  return made;
}
