// Which file extension is which kind of media — the one table. The backend's
// upload allowlist, Content-Type and size caps (services/mediaStore.ts), the
// renderers' audio/video players (mediaEmbed.ts classifyMedia), the canvas
// card's media card (frontend lib/cardBody.ts) and the app's file pickers
// (acceptFor) all read it, so a file the app offers to upload is one the
// server takes, and a file the server takes is drawn as what it is.
//
// Adding an extension here makes it uploadable, served with `mime`, and
// rendered by `kind`. Audio, video, documents and .ico are stored as given
// (served with `mime` and `nosniff`); raster images are decoded by sharp and
// SVG is sanitised (backend services/media.ts).

/** What a file is, for drawing it: an image is an <img>, audio/video a
 *  player, a PDF the PDF viewer, a document a download link. */
export type MediaFileKind = "image" | "audio" | "video" | "pdf" | "document";

export type MediaType = {
  /** The Content-Type the file is served with. */
  mime: string;
  kind: MediaFileKind;
  /** The largest file accepted, in bytes. */
  maxBytes: number;
};

const MB = 1024 * 1024;
const IMAGE_MAX = 50 * MB;
// SVG is text and an active document (sanitised on upload): 2 MB is already
// an unreasonable embed. An .ico is stored unchecked beyond its signature, and
// a favicon is a few KB.
const SMALL_IMAGE_MAX = 2 * MB;
const PDF_MAX = 200 * MB;
const DOC_MAX = 50 * MB;        // office documents / .eml / .txt
const AUDIO_MAX = 200 * MB;     // a lecture recording
const VIDEO_MAX = 500 * MB;     // a captured lecture clip

// The transport caps. A request larger than these never reaches the backend:
// nginx answers 413 with an HTML page (docker/nginx/nginx.conf
// client_max_body_size, kept equal to these by the frontend test
// uploadCaps.test.ts). POST /api/media has its own location so a file up to
// its per-type cap above gets through; every other /api/ request stays small.
/** The largest request nginx passes to /api/ (anything but a media upload). */
export const MAX_REQUEST_BYTES = 20 * MB;
/** The largest POST /api/media request: the largest per-type cap (video)
 *  plus room for the multipart envelope around the file. */
export const MAX_MEDIA_REQUEST_BYTES = VIDEO_MAX + MB;
/** The largest backup upload (POST /api/backup/restore/upload, a zip from
 *  Settings › 你的資料) unless the server is set otherwise. A backup download has
 *  no size limit, so this is high: 16 GB. The server's real limit is
 *  ONDEN_MAX_BACKUP_MB (backend services/backupFile.ts `maxBackupUploadBytes`),
 *  which the page asks for (GET /api/backup/restore/limit); this default is what
 *  it falls back to, what docker/nginx/nginx.conf states (uploadCaps.test.ts
 *  checks it) and what the backend uses when the variable is unset.
 *  nginx buffers the body to disk; the backend streams it to a file and checks
 *  what is inside. */
export const DEFAULT_MAX_BACKUP_REQUEST_BYTES = 16 * 1024 * MB;

/** The whole megabytes of a byte cap, as the size-limit messages state it. */
export const capMegabytes = (bytes: number): number => Math.floor(bytes / MB);

const image = (mime: string, maxBytes = IMAGE_MAX): MediaType => ({ mime, kind: "image", maxBytes });
const audio = (mime: string): MediaType => ({ mime, kind: "audio", maxBytes: AUDIO_MAX });
const video = (mime: string): MediaType => ({ mime, kind: "video", maxBytes: VIDEO_MAX });
const doc = (mime: string): MediaType => ({ mime, kind: "document", maxBytes: DOC_MAX });

/** Every media extension (lower case, with the dot). Anything not keyed here
 *  is refused on upload and drawn as a plain image/link. */
export const MEDIA_TYPES: Readonly<Record<string, MediaType>> = Object.freeze({
  // images
  ".jpg": image("image/jpeg"), ".jpeg": image("image/jpeg"), ".png": image("image/png"),
  ".gif": image("image/gif"), ".webp": image("image/webp"), ".avif": image("image/avif"),
  ".svg": image("image/svg+xml", SMALL_IMAGE_MAX),
  ".ico": image("image/x-icon", SMALL_IMAGE_MAX),
  // documents
  ".pdf": { mime: "application/pdf", kind: "pdf", maxBytes: PDF_MAX },
  ".docx": doc("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
  ".xlsx": doc("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
  ".pptx": doc("application/vnd.openxmlformats-officedocument.presentationml.presentation"),
  ".eml": doc("message/rfc822"),
  ".txt": doc("text/plain; charset=utf-8"),
  // audio
  ".mp3": audio("audio/mpeg"), ".m4a": audio("audio/mp4"), ".wav": audio("audio/wav"),
  ".oga": audio("audio/ogg"), ".ogg": audio("audio/ogg"),
  ".aac": audio("audio/aac"), ".flac": audio("audio/flac"),
  // video
  ".mp4": video("video/mp4"), ".webm": video("video/webm"), ".mov": video("video/quicktime"),
  ".ogv": video("video/ogg"),
});

/** The extension of a file name, path or URL (".mp3"), lower case; "" when
 *  there is none. A URL's query and fragment are not part of it. */
export function mediaExtension(nameOrUrl: string): string {
  const path = nameOrUrl.split(/[?#]/, 1)[0];
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/** The media type of a file name, path or URL, by its extension; null when
 *  the extension is not on the table. */
export function mediaTypeOf(nameOrUrl: string | null | undefined): MediaType | null {
  if (!nameOrUrl) return null;
  const ext = mediaExtension(nameOrUrl);
  return Object.hasOwn(MEDIA_TYPES, ext) ? MEDIA_TYPES[ext] : null;
}

/** Whether a file name, path or URL ends in an image extension on the table. */
export function isImageName(nameOrUrl: string | null | undefined): boolean {
  return mediaTypeOf(nameOrUrl)?.kind === "image";
}

/** The pictures a site's nav bar or browser tab can show: a small, stable
 *  subset of the images the table takes (no gif, avif or ico). */
export const SITE_IMAGE_EXTS: readonly string[] = [".png", ".jpg", ".jpeg", ".webp", ".svg"];
export const isSiteImageName = (name: string): boolean => SITE_IMAGE_EXTS.includes(mediaExtension(name));
/** The `accept` value for choosing a site image: the MIME types, then the extensions. */
export const SITE_IMAGE_ACCEPT: string = [...new Set(SITE_IMAGE_EXTS.map((ext) => MEDIA_TYPES[ext].mime)), ...SITE_IMAGE_EXTS].join(",");

/** The extensions of one kind, in table order. */
export function extensionsOf(kind: MediaFileKind): string[] {
  return Object.keys(MEDIA_TYPES).filter((ext) => MEDIA_TYPES[ext].kind === kind);
}

/** An <input type="file"> `accept` value for the given kinds: the table's
 *  concrete MIME types (without parameters, deduplicated), then its
 *  extensions. The MIME types are what make Android Chrome and iOS offer the
 *  photo/media picker instead of only a file browser; the extensions cover
 *  files the OS types differently. No `image/*` wildcard: that would offer
 *  formats the server refuses (.heic, .bmp). */
export function acceptFor(...kinds: MediaFileKind[]): string {
  const extensions = kinds.flatMap(extensionsOf);
  const mimes = extensions.map((ext) => MEDIA_TYPES[ext].mime.split(";")[0].trim());
  return [...new Set([...mimes, ...extensions])].join(",");
}
