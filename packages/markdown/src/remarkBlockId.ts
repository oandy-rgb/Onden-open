// remark plugin that tags each block a paragraph anchor starts (`data-block-id="id"`: the scroll target of a link to
// the paragraph and the badge of how many notes cite it) and hides the block's `{tag, …}` mark from rendered output.
// The anchors are block_anchors rows of the note being rendered (the text carries no `^id`), passed as the plugin's
// option; blocks.ts reads the tree remark already parsed, so the page, the block preview (extractBlock) and block
// nodes agree on which block an anchor is: a paragraph, heading, list item, quote, list or table.
//
// The `{a, b}` at the end of a block's line is cut by the same scan (blocks.ts treeMarks: escaped, in code or a link,
// empty and `{key: value}` braces stay as written), and the block gets `data-block-tags="a,b"` for styling. The
// names are not shown: a published site must not expose a private tag. The marks stay in the markdown source (so
// round-trip is safe); only the visible HTML omits them.

import type { Plugin } from "unified";
import type { Root, Parent, RootContent, Text } from "mdast";
import { treeAnchorTargets, treeMarks } from "./blocks.js";
import type { Span } from "./blocks.js";

type HProps = { data?: { hProperties?: Record<string, unknown> } };
// mdast's types leave out the hast data path; remark-rehype reads it
// (`<li data-block-id="xxx">`).
function setProps(target: Parent, props: Record<string, string>): void {
  const holder = target as HProps;
  const data = (holder.data ??= {});
  data.hProperties = { ...(data.hProperties ?? {}), ...props };
}

export type BlockAnchorRange = { id: string; from: number; to: number };

export const remarkBlockId: Plugin<[{ anchors?: readonly BlockAnchorRange[] }?], Root> = (options) => (tree, file) => {
  const source = String(file.value ?? "");
  for (const { id, target } of treeAnchorTargets(tree, source, options?.anchors ?? [])) setProps(target, { "data-block-id": id });
  const { tagMarks } = treeMarks(tree, source);
  for (const { tags, mark, target, markIn } of tagMarks) {
    setProps(target, { "data-block-tags": tags.join(",") });
    // No braces inside a mark, so the last `{` opens it.
    hideMark(markIn, mark, (value) => {
      const open = value.lastIndexOf("{");
      return value.endsWith("}") && open >= 0 ? open : null;
    });
  }
};

/** Cut a mark at `mark` from the end of the text that holds it, inside
 *  `container`; `startIn(value)` is where the mark starts in the text's
 *  trimmed value, or null when it does not end it. A paragraph left empty (a
 *  marker on its own line) goes too. */
function hideMark(container: Parent, mark: Span, startIn: (trimmedValue: string) => number | null): void {
  const path: Parent[] = [];
  let node: Parent | RootContent = container;
  for (;;) {
    if (node.type === "text") break;
    if (!("children" in node)) return;
    path.push(node as Parent);
    const kids = (node as Parent).children as RootContent[];
    const hit = kids.find((k) => k.position && k.position.start.offset! <= mark.from && mark.from < k.position.end.offset!);
    if (!hit) return;
    node = hit;
  }
  const text = node as Text;
  let end = text.value.length;
  while (end > 0 && /\s/.test(text.value[end - 1]!)) end--;
  const cut = startIn(text.value.slice(0, end));
  if (cut === null) return;
  let start = cut;
  while (start > 0 && /\s/.test(text.value[start - 1]!)) start--;
  text.value = text.value.slice(0, start);
  // Drop what the cut left empty, up to the first container still holding
  // something (never `container` itself, a block that is tagged).
  let empty: Parent | RootContent = text;
  for (let i = path.length - 1; i >= 0; i--) {
    const parent = path[i]!;
    const isEmpty = empty.type === "text" ? (empty as Text).value === "" : (empty as Parent).children.length === 0;
    if (!isEmpty || (empty.type !== "text" && empty.type !== "paragraph")) return;
    parent.children.splice(parent.children.indexOf(empty as never), 1);
    empty = parent;
    if (parent === container) return;
  }
}
