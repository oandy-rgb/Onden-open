import type { ContentNode } from "./api";
import { wikilinkSpan } from "./wikilinks";

// Backlink snippet derivation, shared by the editor's reference strip and the
// NodeInspector's Backlinks section so both surface the *context* of a link
// (the prose around it) rather than a bare title. Extracted from OverviewEditor
// when the inspector adopted the same card (doc 09: "backlinks carry context").

// Given a `source` note that wikilinks `target`, return an excerpt of ~RADIUS
// chars on either side of the link. Any form that names target counts
// (`[[Title]]`, `[[slug]]`, `[[Title|label]]`, `[[Title#Heading]]`, an alias);
// returns null when no matching link is found. The start/end indices of
// the matched link within the snippet let the renderer highlight it.
const SNIPPET_RADIUS = 90;

export type BacklinkSnippet = {
  text: string;
  linkStart: number;
  linkEnd: number;
  /** ABSOLUTE offset of the link/mention in the SOURCE node's markdown (not
   *  snippet-relative). Lets a "click backlink → open source" navigation land
   *  the caret ON the referencing line via the pendingCursor handoff, instead of
   *  dumping the reader at the note top to hunt for it. */
  linkAbsStart: number;
  truncatedStart: boolean;
  truncatedEnd: boolean;
  /** The note the snippet is from: the links in it read as written there (`[[/words]]` is that note; its space scopes names). */
  source?: { id: string; space_id?: string | null };
};

export function findBacklinkSnippet(source: ContentNode, target: ContentNode): BacklinkSnippet | null {
  const md = source.markdown ?? "";
  // The first [[...]] in the source that names target — `|alias`, `#anchor`,
  // aliases and the slug form included (lib/wikilinks.ts, the server's rule).
  const match = wikilinkSpan(md, source, target);
  if (!match) return null;
  const linkAbsStart = match.start;
  const linkAbsEnd = match.end;
  const snipStart = Math.max(0, linkAbsStart - SNIPPET_RADIUS);
  const snipEnd = Math.min(md.length, linkAbsEnd + SNIPPET_RADIUS);
  return {
    text: md.slice(snipStart, snipEnd),
    linkStart: linkAbsStart - snipStart,
    linkEnd: linkAbsEnd - snipStart,
    linkAbsStart,
    truncatedStart: snipStart > 0,
    truncatedEnd: snipEnd < md.length,
    source: { id: source.id, space_id: source.space_id },
  };
}

// One wikilink matcher for the whole app (it strips `|alias` and `#anchor`);
// a second copy here did not, so aliased links failed in version history.
// Which note a link opens (the space rule) is lib/wikilinks.ts resolveWikilink.
export { nodeMatchesLink } from "./utils";

const isWordChar = (c: string | undefined): boolean => c != null && /[\p{L}\p{N}]/u.test(c);

// Find an UNLINKED mention: `targetTitle` appearing as plain text in `source`'s
// markdown — at a word boundary, and NOT already a `[[wikilink]]` (those are
// linked backlinks). Returns the same snippet shape as findBacklinkSnippet so
// the inspector can render "you wrote this name here but never linked it"
// (doc 09 #3) with the mention highlighted. null when there's no such mention.
export function findMentionSnippet(source: ContentNode, targetTitle: string): BacklinkSnippet | null {
  const md = source.markdown ?? "";
  const title = targetTitle.trim();
  if (!md || !title) return null;
  const lowerMd = md.toLowerCase();
  const lowerTitle = title.toLowerCase();
  let from = 0;
  for (;;) {
    const idx = lowerMd.indexOf(lowerTitle, from);
    if (idx === -1) return null;
    from = idx + lowerTitle.length;
    // Skip occurrences that are actually a wikilink to the node ([[Title]]) —
    // those surface as linked backlinks, not unlinked mentions.
    if (md.slice(Math.max(0, idx - 2), idx) === "[[") continue;
    // Word-ish boundary: don't match inside a larger word (Cat ⊄ Category).
    if (isWordChar(md[idx - 1]) || isWordChar(md[idx + lowerTitle.length])) continue;
    const snipStart = Math.max(0, idx - SNIPPET_RADIUS);
    const snipEnd = Math.min(md.length, idx + lowerTitle.length + SNIPPET_RADIUS);
    return {
      text: md.slice(snipStart, snipEnd),
      linkStart: idx - snipStart,
      linkEnd: idx + lowerTitle.length - snipStart,
      linkAbsStart: idx,
      truncatedStart: snipStart > 0,
      truncatedEnd: snipEnd < md.length,
      source: { id: source.id, space_id: source.space_id },
    };
  }
}
