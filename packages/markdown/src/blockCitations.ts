// Who cites a paragraph: the `[[Note#^id]]` / `![[Note#^id]]` links in a note's
// text that reach a paragraph of another note. Only the server counts these
// (services/blockCitations.ts), so this stays out of blockRef.ts, which the
// app's editor loads.

import { parseEmbed } from "./embeds.js";
import { scanWikilinks, linkNamesNote } from "./text.js";

/** One `[[Note#^id]]` or `![[Note#^id]]` that cites a paragraph of `note`. */
export type BlockCitation = { blockId: string; start: number };

/** The links in `markdown` that cite a paragraph (`#^id`) of the note `note`
 *  names, in order. Plain links and embeds count alike; a link that names
 *  another note, or only a heading, does not. The ONE reading of "who cites
 *  this paragraph", for the server's citation count and the app's list. */
export function blockCitations(
  markdown: string, note: { title: string; slug?: string | null; aliases?: readonly string[] },
): BlockCitation[] {
  if (!markdown.includes("#^")) return [];
  return scanWikilinks(markdown).flatMap((m): BlockCitation[] => {
    const blockId = parseEmbed(m.body).blockId;
    return blockId && linkNamesNote(m.body, note) ? [{ blockId, start: m.start }] : [];
  });
}
