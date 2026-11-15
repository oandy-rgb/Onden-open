// The first picture of a note — the one rule for an article cover, a card image
// and a listed row. Pure text in, the image's address out, as written.
// Fenced code is not prose, so an image shown inside it is not the note's
// picture; both `![alt](url)` and `<img src>` count.

import { withoutFences } from "./fences.js";

const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)/g;
const HTML_IMAGE = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;

/** The address of the first image in `markdown`, or undefined. With `accept`,
 *  the first image whose address it accepts (a published page passes the check
 *  for what it may show, so one unusable picture does not hide the next). */
export function firstImage(markdown: string, accept: (url: string) => boolean = () => true): string | undefined {
  const text = withoutFences(markdown, " ");
  const found = [
    ...[...text.matchAll(MARKDOWN_IMAGE)].map((m) => ({ at: m.index ?? 0, url: m[1]! })),
    ...[...text.matchAll(HTML_IMAGE)].map((m) => ({ at: m.index ?? 0, url: m[1]! })),
  ].sort((a, b) => a.at - b.at);
  return found.find(({ url }) => accept(url))?.url;
}
