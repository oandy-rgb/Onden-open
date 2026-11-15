// remark plugin that hides standalone `key:: value` lines from rendered
// output. The server indexes them into node_attributes (backend utils.ts
// extractAttributes); both read the lines with attributeLines, so a line is
// hidden exactly when it is indexed as a standalone attribute.
//
// Only those LINES go: CommonMark joins adjacent lines into one paragraph, so
// in "due:: 2026-10-20\nCall the lawyer." the second line is the same
// paragraph's text and must stay (before D34 the whole paragraph was dropped).
// Lines are found by source position, so a value with markup (`due:: **x**`)
// goes as a whole; a paragraph left empty is removed.
//
// Bracketed `[key:: value]` and `#key=value` stay visible: they sit in prose.

import type { Plugin } from "unified";
import type { Root, Paragraph, Heading, PhrasingContent, Parent, RootContent } from "mdast";
import { standaloneAttributeLines } from "./attributeLines.js";

export const remarkInlineAttrs: Plugin<[], Root> = () => (tree, file) => {
  const source = String(file?.value ?? "");
  if (!source.includes("::")) return;
  const hidden = standaloneAttributeLines(source);
  if (hidden.size === 0) return;
  pruneParagraphs(tree, hidden);
};

/** Strip hidden lines from every paragraph and heading under `parent` (lazy
 *  continuation lines of a list item or quote start in the first column too);
 *  drop the ones left empty. */
function pruneParagraphs(parent: Parent, hidden: Set<number>): void {
  const kept: RootContent[] = [];
  for (const node of parent.children as RootContent[]) {
    // A setext heading's text is lines too (`due:: x` above `---`).
    if (node.type === "paragraph" || node.type === "heading") {
      if (!touches(node, hidden)) { kept.push(node); continue; }
      node.children = stripLines(node.children, hidden);
      trimTrailingNewline(node);
      if (!isBlank(node)) kept.push(node);
      continue;
    }
    if ("children" in node) pruneParagraphs(node as Parent, hidden);
    kept.push(node);
  }
  parent.children = kept as Parent["children"];
}

function touches(node: { position?: { start: { line: number }; end: { line: number } } }, hidden: Set<number>): boolean {
  const pos = node.position;
  if (!pos) return false;
  for (let l = pos.start.line; l <= pos.end.line; l++) if (hidden.has(l)) return true;
  return false;
}

/** Inline content without the hidden lines. A text node is cut by its line
 *  breaks (its first segment is on its start line); a hidden line goes with
 *  the break after it. Other nodes belong to the line they start on unless
 *  they span several lines, then their children are cut instead. */
function stripLines(children: PhrasingContent[], hidden: Set<number>): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (const child of children) {
    const pos = child.position;
    if (!pos || !touches(child, hidden)) { out.push(child); continue; }
    if (child.type === "text") {
      // [line, break, line, break, …, line]: a break goes with the line before it.
      const parts = child.value.split(/(\r\n?|\n)/);
      let value = "";
      for (let i = 0; i < parts.length; i += 2) {
        if (!hidden.has(pos.start.line + i / 2)) value += parts[i]! + (parts[i + 1] ?? "");
      }
      if (value) out.push({ ...child, value });
      continue;
    }
    if (pos.start.line !== pos.end.line && "children" in child) {
      const inner = stripLines(child.children as PhrasingContent[], hidden);
      if (inner.length) out.push({ ...child, children: inner } as PhrasingContent);
      continue;
    }
    if (!hidden.has(pos.start.line)) out.push(child);
  }
  return out;
}

/** A line removed from the end leaves the previous line's break behind. */
function trimTrailingNewline(p: Paragraph | Heading): void {
  let node: PhrasingContent | undefined = p.children[p.children.length - 1];
  let owner: { children: PhrasingContent[] } = p;
  while (node && node.type !== "text" && "children" in node && node.children.length) {
    owner = node as { children: PhrasingContent[] };
    node = node.children[node.children.length - 1] as PhrasingContent;
  }
  if (node?.type !== "text") return;
  node.value = node.value.replace(/[\r\n]+$/, "");
  if (!node.value) owner.children.pop();
}

function isBlank(p: Paragraph | Heading): boolean {
  return p.children.every((c) => c.type === "text" ? !c.value.trim() : c.type === "break");
}
