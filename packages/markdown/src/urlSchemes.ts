// Which URL schemes a link or an image may use — the one list. The reader and
// the published pages (sanitizeSchema), the static site builder, the RSS
// importer and the editor all ask here, so the same `tel:` link is a link
// everywhere or nowhere. A test (test/guards/ownership.guard.test.ts) fails
// when another file tests a URL's scheme itself.

/** Schemes an `<a href>` may carry (a link with no scheme — `/x`, `#h`, `a.md` — is always fine). */
export const LINK_SCHEMES = ["http", "https", "mailto", "tel"] as const;
/** Schemes an `<img src>` may carry besides the inline-media `data:` below. */
export const IMAGE_SCHEMES = ["http", "https"] as const;

/** An inline image: `data:image/…`. */
export const SAFE_DATA_IMAGE_SRC = /^data:image\//i;

/** Inline media a note may carry: `data:image|audio|video/…` (never `data:text/html`). */
export const SAFE_DATA_MEDIA_SRC = /^data:(?:image|audio|video)\//i;

/** The scheme `url` starts with, lower-case, or undefined when it has none.
 *  Whitespace and control characters inside the scheme are ignored the way
 *  browsers ignore them (`java\tscript:` is `javascript:`). */
export function urlScheme(url: string): string | undefined {
  return /^([a-z][a-z0-9+.-]*):/i.exec(url.replace(/[\u0000- ]/g, ""))?.[1]?.toLowerCase();
}

/** An absolute `http://…` or `https://…` address (the "is this typed value a web address" test). */
export function isHttpUrl(url: string): boolean {
  return /^https?:\/\/\S/i.test(url.trim());
}

/** Whether `url` is a link target a page may offer: no scheme, or one of LINK_SCHEMES. */
export function isSafeLinkHref(url: string): boolean {
  const scheme = urlScheme(url);
  return scheme === undefined || (LINK_SCHEMES as readonly string[]).includes(scheme);
}

/** Whether a link with this explicit scheme may be opened (a bare `/x` or `#h` is not "a URL" here). */
export function hasSafeLinkScheme(url: string): boolean {
  const scheme = urlScheme(url);
  return scheme !== undefined && (LINK_SCHEMES as readonly string[]).includes(scheme);
}

/** Whether a published page may load `url` as an image: `http(s)://…` or a
 *  site-relative `/…` (not `//host`, which a browser reads as another origin). */
export function isSafeImageSrc(url: string): boolean {
  const trimmed = url.trim();
  return /^https?:\/\/\S+$/i.test(trimmed) || /^\/(?!\/)\S*$/.test(trimmed);
}
