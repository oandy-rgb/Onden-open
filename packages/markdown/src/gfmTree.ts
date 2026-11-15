// A note's markdown as an mdast tree, parsed the way the renderer reads it
// (remark-parse + remark-gfm). Code outside this package that needs "what does
// the renderer see here?" (task checkboxes, import link rewriting) calls this
// instead of building its own unified() parser — the lint rule on
// unified/remark-* imports keeps parsers in one place.
//
// Positions (`node.position.start.offset`) are offsets into `markdown`.
import type { Root } from "mdast";
import { parserFor } from "./parsers.js";
import { frontmatterLength } from "./frontmatter.js";

/** The GFM syntax tree of `markdown`. remark-gfm adds syntax only (no tree transforms), so parsing is all it takes. */
export function parseGfmTree(markdown: string): Root {
  return parserFor("gfmTree").parse(markdown);
}

/** The tree an export reads: the body after the frontmatter, parsed as the renderer reads it
 *  (GFM, math, `[[wikilinks]]`, CJK emphasis), so Word and the other exports agree on what is
 *  a link or math. `wikiLink` and `math`/`inlineMath` nodes come with it; positions are offsets
 *  into the returned body, not into `markdown`. */
export function parseExportTree(markdown: string): Root {
  return parserFor("drawnLinks").parse(markdown.slice(frontmatterLength(markdown)));
}
