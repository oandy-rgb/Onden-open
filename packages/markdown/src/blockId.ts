// The `^id` grammar (Obsidian's block id), in one place: which characters an
// id has, how long it may be, and how a line ends with one. A note's text no
// longer carries `^id` marks (a block's identity is its anchor, block_anchors,
// whose id follows this grammar); what still reads the marks — the old
// `[[Note#^id]]` links (index.ts), the code that moves old marks out of the
// text (legacyBlockIds.ts, blocks.ts readLegacyIds) and the summaries that cut
// them from old text — uses these, so they cannot disagree on what an id is.

/** The characters of an id, as a RegExp character-class body. */
export const BLOCK_ID_CHARS = "a-zA-Z0-9-";
export const BLOCK_ID_MAX = 64;
/** An id (without its caret) as a RegExp source, for building patterns such
 *  as `#\^(id)$`. Bounded, so a pattern built on it stays linear. */
export const BLOCK_ID_PATTERN = `[${BLOCK_ID_CHARS}]{1,${BLOCK_ID_MAX}}`;
/** A whole string that is an id. */
export const BLOCK_ID = new RegExp(`^${BLOCK_ID_PATTERN}$`);

/** A fresh id for a block that has none: 6 hex characters, random (the app and
 *  the server both write ids this way, so neither invents its own length). */
export function newBlockId(): string {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(3)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const ID_CHAR = new RegExp(`[${BLOCK_ID_CHARS}]`);
const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);

/** The `^id` ending `text` between `from` and `to` (trailing whitespace
 *  ignored): the caret either at `from` (an id alone on its line) or after
 *  whitespace. `start` is the caret's offset, `end` the id's end. A scan back
 *  from `to` of at most 65 characters, so a caller may run it once per line. */
export function trailingBlockId(text: string, from = 0, to = text.length): { id: string; start: number; end: number } | null {
  let end = to;
  while (end > from && isSpace(text[end - 1])) end--;
  let i = end;
  while (i > from && end - i <= BLOCK_ID_MAX && ID_CHAR.test(text[i - 1]!)) i--;
  if (end - i < 1 || end - i > BLOCK_ID_MAX || i - 1 < from || text[i - 1] !== "^") return null;
  const caret = i - 1;
  if (caret > from && !isSpace(text[caret - 1])) return null;
  return { id: text.slice(i, end), start: caret, end };
}

// What the app writes after the words of a block, at a line's end: the `{tag}`
// slot (`{task}`, `{考點, 複習}`; blocks.ts owns the full grammar, this is the
// cheap string test for text shown small) and the `^id`, or either alone. A run
// of blanks starts only at its first blank, so a long run is read once.
const BEFORE = "(?:^|(?<![ \\t])[ \\t]+)";
const LINE_TRAILERS = new RegExp(`(?:${BEFORE}\\{[^{}\\n]{1,200}\\}(?:[ \\t]+\\^${BLOCK_ID_PATTERN})?|${BEFORE}\\^${BLOCK_ID_PATTERN})[ \\t]*$`, "gm");

/** `text` without the `{tag}` and `^id` that end any of its lines
 *  (`買牛奶 {task} ^ffb6f7` → `買牛奶`). For text shown as prose (summaries,
 *  snippets, backlink previews), never for editing. One pass, linear. */
export function withoutLineTrailers(text: string): string {
  return text.replace(LINE_TRAILERS, "");
}
