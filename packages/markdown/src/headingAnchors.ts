// Heading anchors (D62): the one rule for a heading's link target. Before
// it, rendered headings had no id at all, the published TOC built ASCII-only
// ids of its own (`## 目標` linked to "#") from a line regex that also read
// `## comment` lines inside code fences, and `[[Note#Goals]]` dropped the
// heading. Now:
//
//   - headingAnchors(markdown) lists a note's headings, from an mdast walk:
//     depth, text (the plain text without the `{…}` and `^id` markers block
//     nodes read, blocks.ts headingTextEnd) and id: a Unicode slug (word.ts
//     WORD_CHARS, in NFC) de-duplicated as GitHub does (`a`, `a-1`, `a-2`);
//   - remarkHeadingIds puts those ids on the rendered h1–h6 (the shared
//     pipeline: app, published site, exports), from the tree the renderer
//     already parsed, with the same walk;
//   - the sanitizer prefixes every id (DOM_ID_PREFIX, `user-content-`), so a
//     link to a heading is `#user-content-<id>`: headingFragment. The TOC,
//     [[Note#Heading]] hrefs and the site's scroll-to-heading all use it.
//
// The page holds what this lists: a heading inside code is code, a heading
// made only of hidden `key:: value` lines (remarkInlineAttrs) is not shown and
// has no anchor.
//
// Linear: one parse, then a walk with an explicit stack. The parse has the
// same cap as block anchors (BLOCK_PARSE_MAX): over it headingAnchors is
// empty (a TOC shows nothing) while the renderer, which parses anyway, still
// sets ids; headingFragment then falls back to the heading's own slug.

import type { Plugin } from "unified";
import type { Root, RootContent, Heading, Parent } from "mdast";
import { BLOCK_PARSE_MAX, headingTextEnd } from "./blocks.js";
import { parserFor } from "./parsers.js";
import { stripFrontmatter } from "./frontmatter.js";
import { standaloneAttributeLines } from "./attributeLines.js";
import { normalizeText, WORD_CHARS } from "./word.js";
import { replaceWikilinks, splitWikilink } from "./text.js";
import { DOM_ID_PREFIX } from "./sanitizeSchema.js";

export type HeadingAnchor = {
  depth: 1 | 2 | 3 | 4 | 5 | 6;
  /** The heading as it reads: plain text, markers (`{…}`, `^id`) cut,
   *  whitespace collapsed; a [[link]] reads as its label. */
  text: string;
  /** The heading's anchor id, unique in the note. On the page the element's
   *  id is DOM_ID_PREFIX + id (headingFragment). */
  id: string;
};

// A heading reads a [[link]] from its source either way (parsers.ts "anchors").
// Looked up per call, not at import: a module-level parserFor() keeps unified and micromark in any bundle that imports this file.
const parser = { parse: (text: string) => parserFor("anchors").parse(text) };

let memo: { markdown: string; anchors: readonly HeadingAnchor[] } | null = null;

/** The headings of `markdown`, in document order. Empty over
 *  BLOCK_PARSE_MAX. The last result is kept, so asking again about the same
 *  text (every link to one note) parses once; treat it as read-only. */
export function headingAnchors(markdown: string): readonly HeadingAnchor[] {
  if (memo?.markdown === markdown) return memo.anchors;
  let anchors: HeadingAnchor[] = [];
  if (markdown.length <= BLOCK_PARSE_MAX && mayHaveHeadings(markdown)) {
    const source = stripFrontmatter(markdown);
    anchors = treeHeadings(parser.parse(source) as Root, source).map((h) => h.anchor);
  }
  memo = { markdown, anchors };
  return anchors;
}

/** The headings of `markdown` as `headingAnchors` lists them, each with the
 *  offset of its first character in `markdown` (frontmatter included), for
 *  the editor's `[[Note#` list. Not memoized: it is asked once per popup. */
export function headingAnchorStarts(markdown: string): Array<{ anchor: HeadingAnchor; start: number }> {
  if (markdown.length > BLOCK_PARSE_MAX || !mayHaveHeadings(markdown)) return [];
  const source = stripFrontmatter(markdown);
  const shift = markdown.length - source.length;
  return treeHeadings(parser.parse(source) as Root, source)
    .map((h) => ({ anchor: h.anchor, start: h.node.position!.start.offset! + shift }));
}

/** The headings of `markdown` as `headingAnchors` lists them, each with the
 *  0-based line it starts on in `markdown` (frontmatter included): the info
 *  panel's outline scrolls the editor to that line. */
export function headingAnchorLines(markdown: string): Array<{ anchor: HeadingAnchor; line: number }> {
  let line = 0, at = 0;
  return headingAnchorStarts(markdown).map(({ anchor, start }) => {
    // Starts come in document order, so count newlines only between neighbours.
    for (let next = markdown.indexOf("\n", at); next !== -1 && next < start; next = markdown.indexOf("\n", at)) { line++; at = next + 1; }
    return { anchor, line };
  });
}

/** Each heading's source span in `markdown` with frontmatter removed (the
 *  text `source` is, as returned): where its section runs — through the next
 *  heading of the same or a higher level. For embedExtract.ts. Empty over
 *  BLOCK_PARSE_MAX. */
export function headingSections(markdown: string): { source: string; sections: Array<HeadingAnchor & { start: number; end: number }> } {
  const source = stripFrontmatter(markdown);
  if (markdown.length > BLOCK_PARSE_MAX || !mayHaveHeadings(markdown)) return { source, sections: [] };
  const found = treeHeadings(parser.parse(source) as Root, source);
  const sections = found.map(({ node, anchor }, i) => {
    const next = found.slice(i + 1).find((h) => h.node.depth <= node.depth);
    return { ...anchor, start: node.position!.start.offset!, end: next ? next.node.position!.start.offset! : source.length };
  });
  return { source, sections };
}

/** Sets each heading's anchor id on the element it renders as (`<h2 id>`;
 *  the sanitizer then prefixes it). First in the plugin list, so it reads
 *  the tree before remarkBlockId cuts markers out of the text. */
export const remarkHeadingIds: Plugin<[], Root> = () => (tree, file) => {
  for (const { node, anchor } of treeHeadings(tree, String(file.value ?? ""))) {
    // mdast's types leave out the hast data path; remark-rehype reads it.
    const data = ((node as { data?: { hProperties?: Record<string, unknown> } }).data ??= {});
    data.hProperties = { ...(data.hProperties ?? {}), id: anchor.id };
  }
};

/** The in-page link to the anchor `id`: `#` + DOM_ID_PREFIX + id, the
 *  element id the sanitizer leaves on the page. */
export function anchorHref(id: string): string {
  return `#${DOM_ID_PREFIX}${id}`;
}

/** The link to the heading `heading` names in `markdown` — `#` +
 *  DOM_ID_PREFIX + its id — or null when the note has no such heading. A
 *  heading is named by its text (case-insensitive, as Obsidian reads
 *  `[[Note#Goals]]`) or by its id (`#goals-1`, the second "Goals"); the first
 *  match wins. Over BLOCK_PARSE_MAX, where the headings are not read, the
 *  heading's own slug (right for the first heading with that text). */
export function headingFragment(markdown: string, heading: string): string | null {
  const wanted = normalizeText(heading).replace(/\s+/g, " ").trim();
  if (!wanted) return null;
  if (markdown.length > BLOCK_PARSE_MAX) return anchorHref(headingSlug(wanted));
  const anchors = headingAnchors(markdown);
  const key = wanted.toLowerCase();
  const slug = headingSlug(wanted);
  const found = anchors.find((a) => a.text.toLowerCase() === key) ?? anchors.find((a) => a.id === wanted || a.id === slug);
  return found ? anchorHref(found.id) : null;
}

// ── the walk ─────────────────────────────────────────────────────────────

const NON_SLUG_CHAR = new RegExp(`[^${WORD_CHARS}_\\- ]`, "gu");

/** A heading's text as an id: NFC, lower case, letters / marks / digits of
 *  any script, `_` and `-` kept, each space a `-` (GitHub's rule, over
 *  WORD_CHARS); "heading" when nothing is left. */
function headingSlug(text: string): string {
  return normalizeText(text).toLowerCase().replace(/\s/g, " ").replace(NON_SLUG_CHAR, "").replace(/ /g, "-") || "heading";
}

/** Linear pre-check: some `#`, or a line that could underline a setext
 *  heading. Most short notes without headings skip the parse. */
function mayHaveHeadings(markdown: string): boolean {
  return markdown.includes("#") || /^[ \t]*(?:=+|-+)[ \t]*$/m.test(markdown);
}

/** Every heading the page shows in `tree` (parsed from `source`), with its
 *  anchor: one walk, ids de-duplicated in document order. */
function treeHeadings(tree: Root, source: string): Array<{ node: Heading; anchor: HeadingAnchor }> {
  const hidden = source.includes("::") ? standaloneAttributeLines(source) : null;
  const seen = new Map<string, number>();
  const out: Array<{ node: Heading; anchor: HeadingAnchor }> = [];
  // An explicit stack: a note of 2,000 nested `>` must not overflow it.
  const stack: RootContent[] = [...tree.children].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === "heading") {
      if (hidden && allHidden(node, hidden)) continue;
      const text = headingText(node, source, hidden);
      out.push({ node, anchor: { depth: node.depth, text, id: unique(headingSlug(text), seen) } });
    } else if (node.type !== "paragraph" && node.type !== "table" && "children" in node) {
      const kids = (node as Parent).children as RootContent[];
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
    }
  }
  return out;
}

/** GitHub's de-duplication: the second `a` is `a-1`, skipping a suffix an
 *  earlier heading already took. */
function unique(slug: string, seen: Map<string, number>): string {
  let count = seen.get(slug);
  if (count === undefined) { seen.set(slug, 0); return slug; }
  let id: string;
  do id = `${slug}-${++count}`; while (seen.has(id));
  seen.set(slug, count);
  seen.set(id, 0);
  return id;
}

/** A heading the renderer drops: every line of its text a hidden
 *  `key:: value` (a setext heading's underline is not text). */
function allHidden(node: Heading, hidden: Set<number>): boolean {
  const first = node.children[0], last = node.children[node.children.length - 1];
  if (!first || !last) return false;
  for (let line = first.position!.start.line; line <= last.position!.end.line; line++) if (!hidden.has(line)) return false;
  return true;
}

/** The heading's plain text up to its markers. Code and text read as their
 *  value; math and [[links]] as written (whether the parse had their syntax
 *  or not, the same characters), then a link as its label. A setext
 *  heading's hidden `key:: value` lines are left out, as on the page. */
function headingText(heading: Heading, source: string, hidden: Set<number> | null): string {
  const end = headingTextEnd(source, heading);
  let text = "";
  const stack: RootContent[] = [...heading.children].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    const from = node.position?.start.offset ?? 0;
    const to = node.position?.end.offset ?? from;
    if (from >= end) continue;
    const lines = node.position && hidden ? { first: node.position.start.line, last: node.position.end.line } : null;
    if (lines && lines.first === lines.last && hidden!.has(lines.first)) continue;
    // inlineMath / wikiLink come from syntax plugins mdast's types don't list.
    const type: string = node.type;
    if (type === "text") {
      const { value } = node as { value: string };
      const cut = to > end ? cutTail(value, source.slice(end, to)) : value;
      text += lines && lines.first !== lines.last ? visibleLines(cut, lines.first, hidden!) : cut;
    } else if (type === "inlineCode") text += (node as { value: string }).value;
    else if (type === "inlineMath" || type === "wikiLink") text += source.slice(from, Math.min(to, end));
    else if (type === "image") text += (node as { alt?: string | null }).alt ?? "";
    else if (type === "break") text += " ";
    else if (type !== "html" && type !== "footnoteReference" && "children" in node) {
      const kids = (node as Parent).children as RootContent[];
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
    }
  }
  return replaceWikilinks(text, (body) => { const { target, alias } = splitWikilink(body); return alias ?? target; }).replace(/\s+/g, " ").trim();
}

/** The lines of a text starting on line `first` that are not hidden. */
function visibleLines(value: string, first: number, hidden: Set<number>): string {
  return value.split(/\r\n?|\n/).filter((_, i) => !hidden.has(first + i)).join("\n");
}

/** `value` without `tail`, the markers after the heading's text. The value
 *  is the source with escapes resolved, so it ends with the tail unless the
 *  tail held an escape; then cut at the marker's own first character. */
function cutTail(value: string, tail: string): string {
  if (value.endsWith(tail)) return value.slice(0, value.length - tail.length);
  const marker = tail.trimStart()[0];
  const at = marker ? value.lastIndexOf(marker) : -1;
  return at === -1 ? value : value.slice(0, at);
}
