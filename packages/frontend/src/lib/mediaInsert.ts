// What the editor's 「插入檔案」 entries (slash menu, phone toolbar, desktop
// toolbar button) offer and accept: images, audio and video, the kinds
// /api/media takes and the renderers draw inline (@onden/markdown mediaTypes).
// The upload itself is OverviewEditor's uploadMediaFile, so every entry —
// picker, paste, drop — shares one path, one size/type check and one message.
import { acceptFor, mediaTypeOf } from "@onden/markdown";

/** The `accept` of the insert-file picker: concrete MIME types so a phone
 *  offers the photo library as well as the file browser. */
export const INSERT_MEDIA_ACCEPT = acceptFor("image", "audio", "video");

const INSERT_KINDS: readonly string[] = ["image", "audio", "video"];
const INSERT_MIMES = new Set(INSERT_MEDIA_ACCEPT.split(",").filter((a) => !a.startsWith(".")));

/** Whether the editor takes this file as media: its name ends in an image, audio or video extension on the
 *  table, or (a pasted screenshot may have no useful name) its MIME type is one the picker offers. Any `image/*`
 *  goes to the upload too, so a format the server refuses (.heic) is told so instead of being dropped silently. */
function isInsertableMedia(file: { name: string; type: string }): boolean {
  const kind = mediaTypeOf(file.name)?.kind;
  return (kind !== undefined && INSERT_KINDS.includes(kind)) || INSERT_MIMES.has(file.type) || file.type.startsWith("image/");
}

/** The files a paste inserts as media. A clipboard with text on it is a text paste even when it carries a picture
 *  too (a copied spreadsheet range or Word text brings a preview image along): the text is what the person copied. */
export function pastedMediaFiles(files: readonly File[], text: string): File[] {
  if (text.trim() !== "") return [];
  return files.filter(isInsertableMedia);
}

/** A drop split into what the editor inserts and what is left (a PDF, anything else). */
export function splitDroppedFiles(files: readonly File[]): { media: File[]; rest: File[] } {
  return { media: files.filter(isInsertableMedia), rest: files.filter((f) => !isInsertableMedia(f)) };
}
