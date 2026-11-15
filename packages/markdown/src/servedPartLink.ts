// `[[筆記/段落開頭]]` on the published site, in a module of its own so the app's first JS (which holds blockHome.ts) does not
// carry the part-link reading (blockLink.ts): only the server's publishing and tests import this.

import { BLOCK_LINK_EXCERPT_MAX, blockLinkWords, linkPathReadings, matchParts } from "./blockLink.js";
import { plainExcerpt } from "./graphemes.js";
import { servedLinkTarget, type ServedPage } from "./sitePath.js";

/**
 * A `[[筆記/段落開頭]]` on the published site: the served page it opens and the words it shows. The site has no
 * bindings (anchors never leave the app), so the part is found by its words, as a link typed by hand is; several
 * fits open the page and read as its title. Null: not a part link, no served page is named, or no part of it fits
 * (the caller leaves the link as it did).
 */
export function servedPartLink<P extends ServedPage>(
  target: string, served: readonly P[], fromId?: string | null,
): { page: P; words: string; heading: string | null } | null {
  const readings = linkPathReadings(target);
  if (readings.length === 0 || servedLinkTarget(target, served, fromId)) return null;
  for (const r of readings) {
    const page = r.note === "" ? served.find((p) => p.id === fromId) ?? null : servedLinkTarget(r.note, served, fromId);
    if (!page) continue;
    const hit = typeof page.markdown === "string" ? matchParts(page.markdown, r.segments) : { found: "none" as const };
    // No part of that page fits: the link is whatever it was (the app shows it as typed too, a click there makes the note).
    if (hit.found === "none") continue;
    if (hit.found === "many") return { page, words: page.title, heading: null };
    const t = hit.target;
    return {
      page, words: blockLinkWords(r.note === "" ? null : page.title, plainExcerpt(t.text, BLOCK_LINK_EXCERPT_MAX)),
      heading: t.kind === "heading" ? t.text : null,
    };
  }
  return null;
}
