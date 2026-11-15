// The part link last copied from a paragraph (「複製段落連結」): what it says and where the paragraph was. Kept in memory
// only — a link copied and never pasted leaves nothing in any note. When the same text is pasted into a note of Onden,
// the paste (lib/blockSafety/pendingLink) asks the server to anchor the paragraph and bind the pasted link to it; pasted
// anywhere else, or after a restart, the link still reads by its words.

export type CopiedPartLink = {
  /** The text on the clipboard: `[[Note/first words]]`. */
  link: string;
  /** The note the paragraph is in, where the person saw it, and what it began with (the server checks, never guesses). */
  noteId: string;
  at: number;
  seenText: string;
  /** The words after the `/`. */
  text: string;
};

let latest: CopiedPartLink | null = null;

export function rememberCopiedPartLink(copied: CopiedPartLink): void { latest = copied; }

/** The copied link that `pasted` is, or null (anything else, or another link). */
export function copiedPartLinkOf(pasted: string): CopiedPartLink | null {
  return latest !== null && latest.link === pasted.trim() ? latest : null;
}
