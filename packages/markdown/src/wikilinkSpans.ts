// The [[wikilinks]] of a note exactly as the renderer reads them: parsed by
// the pipeline's own syntax (GFM, math, remark-wiki-link with the core's
// options), so a `[[…]]` inside inline code, a code fence or `$math$` is not
// one, as it renders as text there. text.ts's scanWikilinks scans the raw
// text instead (every `[[…]]`, code included) — right for edges and
// redaction, which must not miss one; this is for rewriting a link in place
// without touching the text around it. The two disagree only inside code;
// pick by what a miss costs: scanWikilinks may over-find, drawnWikilinks may
// under-find (a link the page does not draw).

import { visit } from "unist-util-visit";
import { parserFor } from "./parsers.js";
import { frontmatterLength } from "./frontmatter.js";
import type { WikilinkMatch } from "./text.js";

// Looked up per call, not at import: a module-level parserFor() keeps unified and micromark in any bundle that imports this file.
const parser = { parse: (text: string) => parserFor("drawnLinks").parse(text) };

type Positioned = { type: string; position?: { start: { offset?: number }; end: { offset?: number } } };

/** Only the `[[…]]` links the renderer DRAWS in `markdown` (math on, as on the
 *  site and in the exports): code and math are excluded, unlike scanWikilinks.
 *  Each comes with its span in `markdown` (frontmatter included) and the body
 *  between the brackets. */
export function drawnWikilinks(markdown: string): WikilinkMatch[] {
  if (typeof markdown !== "string" || !markdown.includes("[[")) return [];
  const offset = frontmatterLength(markdown);
  const body = markdown.slice(offset);
  const tree = parser.parse(body);
  const out: WikilinkMatch[] = [];
  visit(tree, (node) => (node as Positioned).type === "wikiLink", (node) => {
    const start = (node as Positioned).position?.start.offset;
    const end = (node as Positioned).position?.end.offset;
    if (start === undefined || end === undefined) return;
    const text = body.slice(start, end);
    if (!text.startsWith("[[") || !text.endsWith("]]")) return;
    out.push({ start: start + offset, end: end + offset, body: text.slice(2, -2) });
  });
  return out.sort((a, b) => a.start - b.start);
}

