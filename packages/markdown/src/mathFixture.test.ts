import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { visit } from "unist-util-visit";
import { ondenMarkdown } from "./full.js";
import fixture from "./fixtures/math.json";

// The renderer's side of the math parity fixture. The editor's grammar
// (packages/frontend/src/lib/editorMathSyntax.ts) is tested against the same
// file, so "which spans are math" has one definition: whatever remark-math
// does. If a remark-math upgrade changes it, this test fails first and the
// fixture — and then the editor — follow.
// The whole remark chain of the app profile, so a plugin that rewrote text
// before remark-math would show up here.
const parser = unified().use(remarkParse).use(ondenMarkdown({ profile: "app" }).remarkPlugins);

function mathSpans(markdown: string): string[] {
  const spans: string[] = [];
  visit(parser.parse(markdown), (node) => {
    if ((node.type === "inlineMath" || node.type === "math") && node.position) {
      spans.push(markdown.slice(node.position.start.offset, node.position.end.offset));
    }
  });
  return spans;
}

describe("math parity fixture (remark-math)", () => {
  for (const c of fixture) {
    it(c.name, () => expect(mathSpans(c.markdown)).toEqual(c.math));
  }
});
