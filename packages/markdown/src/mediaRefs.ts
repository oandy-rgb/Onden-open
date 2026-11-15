// The one grammar for a stored media file's address. A file the backend
// stores (services/media.ts storeMedia) is served at `/api/media/<id>`, and
// that string is how every note body, attribute, site design and published
// snapshot refers to it. Ownership claims, read checks, the publish preview,
// the static bundle and the vault export all find references with
// `mediaRefs`/`rewriteMediaRefs`; every renderer turns a stored value into a
// URL with `mediaSrc`.
//
// The id: one path segment of `[A-Za-z0-9._-]` that starts and ends with a
// letter, digit, `_` or `-`. Minted ids are `<32 hex>.<ext>`
// (backend mediaStore.opaqueMediaName); the wider set keeps older uploads
// (`<timestamp>-<name>.png`) matching. The edges are deliberate:
//   - no `/`, and no leading `.`, so an id is never `.`, `..`, `../x` or a
//     hidden file (the backend's `.import-*.tmp` temporaries): a reference can
//     never name a path outside the media directory, wherever it is joined;
//   - no trailing `.`, so the full stop after `see /api/media/a.png.` is
//     prose, not part of the id.
// Where a reference starts: either `/api/media/` begins a URL (nothing
// URL-like right before it: start of text, space, quote, `(`, `=`, `<`…), or
// a whole origin precedes it — `https://host`, `http://user@host:8080` or
// scheme-relative `//host` — and the match covers that origin, so a rewrite
// replaces the whole URL. Anything else is not a reference: `/api/media/`
// inside a longer path (`https://host/sub/api/media/x`, `./api/media/x`) or
// after a partial origin is left alone, never half-rewritten. A query or
// fragment after the id is left in place.

import { SAFE_DATA_MEDIA_SRC, isHttpUrl } from "./urlSchemes.js";
/** The path every stored media file is served under. */
export const MEDIA_URL_PREFIX = "/api/media/";

const ID = "[A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?";
// Characters that continue a URL: a reference cannot start right after one.
const NOT_AFTER_URL_CHAR = "(?<![A-Za-z0-9._~%+@:/\\\\-])";
const ORIGIN = "(?:(?:https?:)?//[A-Za-z0-9.:\\[\\]@%_~+-]+)?";
const ID_RE = new RegExp(`^${ID}$`);
const refPattern = () => new RegExp(`${NOT_AFTER_URL_CHAR}${ORIGIN}/api/media/(${ID})`, "g");
const BUNDLE_RE = new RegExp(`^media/(${ID})((?:[?#].*)?)$`);
const BARE_RE = new RegExp(`^(${ID})((?:[?#].*)?)$`);

/** Whether `id` is a media id (see the grammar above). */
export function isMediaId(id: string): boolean {
  return ID_RE.test(id);
}

/** The address a stored file is served at: `mediaUrl("ab12.png")` →
 *  `/api/media/ab12.png`. `id` must be a media id. */
export function mediaUrl(id: string): string {
  return `${MEDIA_URL_PREFIX}${id}`;
}

/** The distinct media ids `text` references, in first-seen order. */
export function mediaRefs(text: string): string[] {
  return [...new Set([...text.matchAll(refPattern())].map((m) => m[1]!))];
}

/** Replace every media reference in `text` with `replace(id, match)`; `match`
 *  is the whole reference (origin included). Returning `match` keeps one. */
export function rewriteMediaRefs(text: string, replace: (id: string, match: string) => string): string {
  return text.replace(refPattern(), (match, id: string) => replace(id, match));
}

/** `text` made self-contained: every media reference rewritten to the path
 *  of its bundled copy, `path(id)`, and the distinct ids to copy there. The
 *  one bundle pass of the published site (backend publishing/mediaBundle.ts:
 *  `media/<id>`) and the vault export (exportZip.ts: `./attachments/<id>`). */
export function bundleMedia(text: string, path: (id: string) => string): { content: string; ids: string[] } {
  const ids = new Set<string>();
  const content = rewriteMediaRefs(text, (id) => {
    ids.add(id);
    return path(id);
  });
  return { content, ids: [...ids] };
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export type MediaSrcOptions = {
  /** Origin (or path prefix) the API is served from; "" or omitted: this origin. */
  apiBase?: string;
  /** Base URL of a published static bundle (document.baseURI). Given, a
   *  `media/<id>` value resolves against it — the files pagesPush copied next
   *  to the page; omitted, `media/<id>` is read as the id it names. */
  bundle?: string;
};

/** The URL to load a stored media value from, or "" when the value is not
 *  something a page may load as media:
 *   - `http(s):`, `blob:`, safe `data:` (image/audio/video) and site-relative
 *     `/…` values are used as they are — but not `//host/…` or `/\host/…`,
 *     which a browser reads as another origin;
 *   - a bare id (`ab12.png`) or a bundle path (`media/ab12.png`) becomes
 *     `<apiBase>/api/media/<id>`, or the bundle copy when `bundle` is given;
 *   - anything else (`javascript:`, `data:text/html`, `../x`, `a/b.png`) is "". */
export function mediaSrc(src: string, options: MediaSrcOptions = {}): string {
  const value = src.trim();
  if (!value) return "";
  if (isHttpUrl(value) || /^blob:/i.test(value)) return value;
  if (SAFE_DATA_MEDIA_SRC.test(value)) return value;
  if (SCHEME.test(value)) return "";
  if (value.startsWith("/")) return /^\/[/\\]/.test(value) ? "" : value;
  const bundled = BUNDLE_RE.exec(value);
  if (bundled && options.bundle !== undefined) return new URL(value, options.bundle).href;
  const bare = bundled ?? BARE_RE.exec(value);
  if (!bare) return "";
  return `${options.apiBase ?? ""}${mediaUrl(bare[1]!)}${bare[2] ?? ""}`;
}
