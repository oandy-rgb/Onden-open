import type { BlockContext, Element, InlineContext, Line, MarkdownConfig } from "@lezer/markdown";
import { Tag, tags as t } from "@lezer/highlight";

// `$…$` and `$$…$$` in the editor's markdown grammar, read the way the
// published pages read them (remark-math 6 → micromark-extension-math), so
// `*`, `_`, backticks and brackets inside a formula never become emphasis,
// code or links while you type. Nodes:
//
//   InlineMath   `$a_b$`, `$$a$$` on one line or across the lines of a paragraph
//   BlockMath    a `$$` line, the formula's lines, a closing `$$` line
//   …Mark        the `$` runs (faded like other marks)
//
// The rules are micromark's, which are NOT the "no space after the opening
// $" rules of pandoc / LaTeX editors — so `$5 and $10` is math here, exactly as
// on the published page (fixtures/math.json pins both sides):
//   - an opening run of n `$` closes at the next run of exactly n `$`
//     (a longer or shorter run inside is content); no closing → plain text,
//     and the whole run is skipped, not retried from its second `$`;
//   - a backslash before the opening `$` makes it a literal `\$`; inside the
//     formula backslashes mean nothing to the grammar (KaTeX reads them);
//   - a `$$` line (up to 3 spaces of indent, no `$` in what follows) opens a
//     block that lasts until a line of at least as many `$` and nothing else,
//     or the end of the container; it may interrupt a paragraph.

/** Style tag of a formula's source (themes colour it as code-like text). */
export const mathTag = Tag.define();

const DOLLAR = 36;
const BACKSLASH = 92;

/** True when `pos` is a `$` that continues a run which already failed to
 *  open (or is the second half of `\$$`), so it must not start a new one. */
function insideRun(cx: InlineContext, pos: number): boolean {
  let start = pos;
  while (start > cx.offset && cx.char(start - 1) === DOLLAR) start--;
  if (start === pos) return false;
  let slashes = 0;
  while (start - slashes > cx.offset && cx.char(start - slashes - 1) === BACKSLASH) slashes++;
  // The run's first `$` is consumed by the Escape `\$` when an odd number of
  // backslashes precede it; the rest of the run is a fresh run.
  return slashes % 2 === 1 ? pos > start + 1 : true;
}

function parseInlineMath(cx: InlineContext, next: number, pos: number): number {
  if (next !== DOLLAR || insideRun(cx, pos)) return -1;
  let open = 1;
  while (pos + open < cx.end && cx.char(pos + open) === DOLLAR) open++;
  for (let i = pos + open; i < cx.end;) {
    if (cx.char(i) !== DOLLAR) { i++; continue; }
    let run = 1;
    while (i + run < cx.end && cx.char(i + run) === DOLLAR) run++;
    if (run === open) {
      const end = i + run;
      return cx.addElement(cx.elt("InlineMath", pos, end, [
        cx.elt("InlineMathMark", pos, pos + open),
        cx.elt("InlineMathMark", i, end),
      ]));
    }
    i += run;
  }
  return -1;
}

const OPENING = /^(\$\$+)([^$]*)$/;
const CLOSING = /^(\$+)\s*$/;

function opensBlock(line: Line): RegExpExecArray | null {
  if (line.next !== DOLLAR || line.indent - line.baseIndent >= 4) return null;
  return OPENING.exec(line.text.slice(line.pos));
}

/** The line still belongs to the containers (quote, list item) the block
 *  opened in. `Line.depth` is how many of them it continued — what lezer's
 *  own FencedCode compares — but is missing from the published typings. */
function stillInside(cx: BlockContext, line: Line): boolean {
  return (line as Line & { depth: number }).depth >= cx.depth;
}

function parseBlockMath(cx: BlockContext, line: Line): boolean {
  const opening = opensBlock(line);
  if (!opening) return false;
  const fence = opening[1].length;
  const from = cx.lineStart + line.pos;
  const marks: Element[] = [cx.elt("BlockMathMark", from, from + fence)];
  let end = cx.lineStart + line.text.length;
  while (cx.nextLine() && stillInside(cx, line)) {
    const closing = CLOSING.exec(line.text.slice(line.pos));
    if (closing && closing[1].length >= fence && line.indent - line.baseIndent < 4) {
      const markFrom = cx.lineStart + line.pos;
      end = markFrom + closing[1].length;
      marks.push(cx.elt("BlockMathMark", markFrom, end));
      cx.nextLine();
      break;
    }
    end = cx.lineStart + line.text.length;
  }
  cx.addElement(cx.elt("BlockMath", from, end, marks));
  return true;
}

/** Pass to `markdown({ extensions })`. */
export const mathMarkdown: MarkdownConfig = {
  defineNodes: [
    { name: "InlineMath", style: mathTag },
    { name: "InlineMathMark", style: t.processingInstruction },
    { name: "BlockMath", block: true, style: mathTag },
    { name: "BlockMathMark", style: t.processingInstruction },
  ],
  parseBlock: [{
    name: "BlockMath",
    before: "FencedCode",
    parse: parseBlockMath,
    endLeaf: (_cx, line) => opensBlock(line) !== null,
  }],
  parseInline: [{ name: "InlineMath", before: "Escape", parse: parseInlineMath }],
};
