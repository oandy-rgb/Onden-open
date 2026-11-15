// The picture a shared link to a published page shows (og:image). A crawler
// needs an absolute address it can fetch without the reader's session, so a
// stored media value becomes `<origin>/api/media/<id>`; a picture that lives in
// the page itself (a data: or blob: URL) cannot be fetched and gives none.
import { isHttpUrl, mediaSrc } from "@onden/markdown";

/** `src` as written in a note (or the site's logo setting) → an absolute
 *  address on `origin`, or undefined when there is nothing a crawler could load. */
export function shareImageUrl(src: string | undefined, origin: string): string | undefined {
  if (!src) return undefined;
  const url = mediaSrc(src);
  if (isHttpUrl(url)) return url;
  return url.startsWith("/") ? `${origin}${url}` : undefined;
}
