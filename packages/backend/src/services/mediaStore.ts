// Where uploaded media lives on disk and what may be stored there: the
// directory, the opaque key a new file gets, the extension allowlist and the
// per-extension size caps. Storing a file is services/media.ts storeMedia;
// the upload route, the importers and the publishers read these constants.

import { randomBytes } from "node:crypto";
import { join } from "path";
import { MEDIA_TYPES } from "@onden/markdown";
import { STORE } from "../git.js";

export const MEDIA_DIR = join(STORE, "media");

// Mint an opaque, unguessable on-disk key for a media asset.
//
// GET /api/media/* is DELIBERATELY public (anonymous visitors render images
// embedded in published pages — see index.ts isPublicRead), so auth does NOT
// gate reads. That makes the key itself the only barrier against enumeration:
// the old `${Date.now()}-${originalName}` scheme was guessable across users
// (a known upload time + filename reconstructs the URL). We instead derive the
// stem from 128 bits of CSPRNG entropy. The extension is preserved verbatim
// because the GET route maps it → Content-Type; the random stem carries all
// the secrecy. We do NOT keep the original name even as a suffix: it would
// leak content and shrink the guessing space.
export function opaqueMediaName(ext: string): string {
  return `${randomBytes(16).toString("hex")}${ext}`;
}

// The upload allowlist, Content-Type and size caps are the one media table,
// @onden/markdown mediaTypes.ts (the renderers and the app's file pickers read
// the same table). Anything not keyed there is rejected at POST time. Beyond
// images we accept the media a knowledge note actually carries: lecture
// audio/video (teacher, language-learner) and the office documents a casework
// note attaches (lawyer: .docx/.eml/.xlsx). Audio/video/docs keep their bytes
// verbatim — only the raster image formats get re-encoded by sharp.
// No prototype: a lookup of "constructor" or "__proto__" finds nothing.
export const MIME: Readonly<Record<string, string>> = Object.freeze(Object.assign(
  Object.create(null) as Record<string, string>,
  Object.fromEntries(Object.entries(MEDIA_TYPES).map(([ext, type]) => [ext, type.mime])),
));

/** The byte cap for an extension (".mp3"); 0 for one off the allowlist. The
 *  caps keep a single upload from exhausting the backend's memory at the
 *  `await file.arrayBuffer()` line. Pure. */
export function capFor(ext: string): number {
  return Object.hasOwn(MEDIA_TYPES, ext) ? MEDIA_TYPES[ext].maxBytes : 0;
}
