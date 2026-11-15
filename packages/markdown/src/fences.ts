// Which lines of a note are fenced code — the one reading of ``` and ~~~ for
// everything that must not treat code as prose (links, tags, mentions,
// attributes, tasks, summaries, reading time, the cover image). Before this,
// eleven copies each read the fence a little differently: with or without
// indentation, with or without a quote or list marker in front, an unclosed
// fence counted or not. CommonMark's rule is the one here: a fence opens with
// three or more backticks or tildes (a backtick fence's info text holds no
// backtick), closes on a line of the same character at least as long with
// nothing after it, and runs to the end of the note when nothing closes it.

export type FenceLine = "outside" | "open" | "inside" | "close";

type FenceOptions = {
  /** Allow the quote marks and list bullets of a container block (and any
   *  indentation) before the fence, as in `> ```` or `- ````. Default: up to
   *  three spaces, a fence of its own. */
  container?: boolean;
  /** Also read `$$` math blocks as fenced (same open/inside/close answers): a
   *  line of two or more `$`, up to three spaces in, with no `$` after it, opens
   *  one; a line of only `$` at least as many closes it; unclosed runs to the
   *  end. The rule of remark-math (mathFixture.test.ts "block …" cases). */
  math?: boolean;
};

const MATH_OPEN = /^ {0,3}(\${2,})([^$]*)$/;
const MATH_CLOSE = /^ {0,3}(\${2,})[ \t]*$/;

const PLAIN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CONTAINED = /^[ \t]*(?:(?:>|[-+*]|\d{1,9}[.)])[ \t]*)*(`{3,}|~{3,})(.*)$/;

/** The text after the marks of a line that opens a fence (`js` for "```js"),
 *  or null when the line opens none. */
export function openingFenceInfo(line: string, options: FenceOptions = {}): string | null {
  const m = (options.container ? CONTAINED : PLAIN).exec(line);
  return m && !(m[1]![0] === "`" && m[2]!.includes("`")) ? m[2]! : null;
}

/** The language word after an opening fence, "" when it has none. */
export function fenceInfoWord(info: string): string {
  return info.trim().split(/\s/)[0] ?? "";
}

/** A line-by-line reader: call it with each line in order, it says whether the
 *  line opens a fence, is inside one, closes it or is outside. `info` is the
 *  text after the opening fence's marks (for `open` only). */
export function fenceScanner(options: FenceOptions = {}): (line: string) => FenceLine {
  const pattern = options.container ? CONTAINED : PLAIN;
  let open: string | null = null;
  let math: number | null = null; // the length of the opening `$$…` run
  return (line) => {
    if (math !== null) {
      const c = MATH_CLOSE.exec(line);
      if (c && c[1]!.length >= math) { math = null; return "close"; }
      return "inside";
    }
    const m = pattern.exec(line);
    if (open === null && options.math) {
      const o = MATH_OPEN.exec(line);
      if (o) { math = o[1]!.length; return "open"; }
    }
    if (open !== null) {
      if (m && m[1]![0] === open[0] && m[1]!.length >= open.length && m[2]!.trim() === "") { open = null; return "close"; }
      return "inside";
    }
    if (!m || (m[1]![0] === "`" && m[2]!.includes("`"))) return "outside";
    open = m[1]!;
    return "open";
  };
}

/** For each line, whether it belongs to a fenced block (its fence lines included). */
export function fencedLines(lines: readonly string[], options?: FenceOptions): boolean[] {
  const next = fenceScanner(options);
  return lines.map((line) => next(line) !== "outside");
}

/** `markdown` with every fenced block (fence lines included) replaced by
 *  `replacement` (a line break stays at each cut). */
export function withoutFences(markdown: string, replacement = "", options?: FenceOptions): string {
  const lines = markdown.split("\n");
  const fenced = fencedLines(lines, options);
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (!fenced[i]) out.push(line);
    else if (!fenced[i - 1]) out.push(replacement);
  });
  return out.join("\n");
}
