// One file upload to /api/media, shared by every place that attaches a file
// (editor images and PDFs, canvas drops, media fields, the site studio).
// Uploads are online-only: a file is too large for the offline write queue.
import { MAX_MEDIA_REQUEST_BYTES, capMegabytes, mediaTypeOf } from "@onden/markdown";
import { ApiError, apiFetch, readErrorBody } from "../api";
import { t } from "../i18n";
import { WriteActionError } from "./writeErrors";

/** A file over its upload cap, in the user's words: the server's
 *  `file_too_large` refusal (routes/media.ts) says the same. */
function tooLarge(maxBytes: number): WriteActionError {
  return new WriteActionError(t("The file is larger than the {mb} MB upload limit.", { mb: capMegabytes(maxBytes) }));
}

/** Upload one file and return its media address ("/api/media/…"). A file
 *  over its type's cap (@onden/markdown mediaTypes.ts) is refused before it
 *  is sent; a 413 — from the server, or nginx's HTML page — is the same
 *  WriteActionError. Another refused upload throws ApiError (so
 *  writeFailureMessage can explain it); a response without an address throws
 *  WriteActionError. */
export async function uploadMedia(file: Blob, fileName?: string): Promise<string> {
  const name = fileName ?? (file instanceof File ? file.name : undefined);
  const type = mediaTypeOf(name);
  if (name && !type) throw new WriteActionError(t("This file type can't be uploaded."));
  const cap = type?.maxBytes;
  if (cap !== undefined && file.size > cap) throw tooLarge(cap);
  const form = new FormData();
  if (fileName !== undefined) form.append("file", file, fileName);
  else form.append("file", file);
  const response = await apiFetch("/api/media", { method: "POST", body: form });
  if (response.status === 413) {
    const error = new ApiError(413, await readErrorBody(response));
    const maxBytes = (error.body as { max_bytes?: unknown } | undefined)?.max_bytes;
    throw tooLarge(typeof maxBytes === "number" ? maxBytes : cap ?? MAX_MEDIA_REQUEST_BYTES);
  }
  if (!response.ok) throw new ApiError(response.status, await readErrorBody(response));
  const { url } = await response.json() as { url?: string };
  if (!url) throw new WriteActionError(t("The upload did not return a file address."));
  return url;
}
