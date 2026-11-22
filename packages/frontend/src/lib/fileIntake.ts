import { acceptFor, mediaTypeOf, type MediaFileKind } from "@onden/markdown";
import type { CreateNote } from "./data";

// What a file the person gives the app becomes. The ONE definition: "this kind of file → what is made".
// The editor's drop, "＋ → 上傳檔案", the `/` menu's PDF page and the phone's file picker all read it, and so do
// the pickers' `accept` values, so an entry can neither take a file another entry refuses nor make something else
// of it. Two intents, and only these two:
//   new-note   a file becomes a NEW note (a PDF: its pages and text; a picture, sound or video: a note showing it;
//              a document: a note linking to it)
//   into-note  a file goes INTO the text of the open note (what is drawn inline: picture, sound, video)
// The same intent gives the same result from every entry; the two intents may differ.
// Sizes and the kinds themselves are @onden/markdown mediaTypes.ts's table. Guard: test/guards/fileIntake.guard.test.ts.

type NewNoteResult = "pdf-note" | "embed-note" | "link-note";
const NEW_NOTE: Readonly<Record<MediaFileKind, NewNoteResult>> = {
  pdf: "pdf-note", image: "embed-note", audio: "embed-note", video: "embed-note", document: "link-note",
};
const INTO_NOTE: Readonly<Partial<Record<MediaFileKind, "embed">>> = { image: "embed", audio: "embed", video: "embed" };

const kindsOf = (table: Readonly<Partial<Record<MediaFileKind, unknown>>>) => Object.keys(table) as MediaFileKind[];

/** The `accept` of every picker that makes a new note from a file. */
export const NEW_NOTE_ACCEPT = acceptFor(...kindsOf(NEW_NOTE));
/** The `accept` of the `/` menu's PDF page: the kinds that become a PDF note. */
export const PDF_NOTE_ACCEPT = acceptFor(...kindsOf(NEW_NOTE).filter((kind) => NEW_NOTE[kind] === "pdf-note"));
/** The `accept` of the picker that puts a file into the open note's text. */
export const INTO_NOTE_ACCEPT = acceptFor(...kindsOf(INTO_NOTE));

/** The kind of a file by its name on the media table (a PDF without a useful name: by its MIME type); null for any other. */
function fileKind(file: { name: string; type?: string }): MediaFileKind | null {
  return mediaTypeOf(file.name)?.kind ?? (file.type === "application/pdf" ? "pdf" : null);
}

/** What `file` becomes as a new note; null when no entry takes it. */
export function newNoteResult(file: { name: string; type?: string }): NewNoteResult | null {
  const kind = fileKind(file);
  return kind ? NEW_NOTE[kind] : null;
}

/** Whether the open note's text takes `file` inline. */
export function goesIntoNote(file: { name: string; type?: string }): boolean {
  const kind = fileKind(file);
  return kind !== null && INTO_NOTE[kind] !== undefined;
}

/** The text that shows a file inline in a note (`src` is the address it was stored at). */
export const embedMarkdown = (alt: string, src: string): string => `![${alt}](${src})`;

const fileTitle = (name: string): string => name.replace(/\.[^.]+$/, "");

/** Uploads `file` and makes the new note it becomes (`create` adds the door's own parent / space). Rejects when the
 *  upload or the creation does. A PDF's note carries its text (lib/pdf/pdfNote); an unreadable PDF still becomes a note. */
export async function makeNoteFromFile<Made>(
  file: File,
  { upload, create, notify, parentId }: {
    upload: () => Promise<string>;
    create: (input: CreateNote) => Promise<Made>;
    notify: (message: string) => void;
    parentId?: string | null;
  },
): Promise<Made> {
  const result = newNoteResult(file);
  if (!result) throw new Error("this kind of file is not taken");
  if (result === "pdf-note") return (await import("./pdf")).createPdfNote(file, { upload, create, notify, parentId });
  const url = await upload();
  const title = fileTitle(file.name);
  return create({ title, markdown: `${result === "embed-note" ? embedMarkdown(title, url) : `[${title}](${url})`}\n`, ...(parentId ? { parent_id: parentId } : {}) });
}
