// Where a selected piece of text sits in a note: the one check "hand to AI" runs before it spends
// a model call (backend selectionActions) and again when the answer arrives (backend selectionDelivery).

export type SelectionMatch =
  | { found: "one"; /** UTF-16 offset in the note */ at: number; /** the note's own length of the match (CRLF counts two) */ length: number }
  | { found: "none" | "several" };

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Find `selected` in `markdown`, requiring exactly one place (matches may overlap, as with `indexOf`).
 *  The editor hands over line breaks as `\n`; a note saved with `\r\n` still matches a multi-line selection,
 *  and `length` is what the match takes in the note, so replacing `[at, at + length)` is exact. */
export function findSelection(markdown: string, selected: string): SelectionMatch {
  if (selected === "") return { found: "none" };
  const pattern = new RegExp(escapeRegExp(selected.replace(/\r\n/g, "\n")).replace(/\n/g, "\\r?\\n"), "g");
  const first = pattern.exec(markdown);
  if (!first) return { found: "none" };
  pattern.lastIndex = first.index + 1;
  if (pattern.exec(markdown)) return { found: "several" };
  return { found: "one", at: first.index, length: first[0].length };
}
