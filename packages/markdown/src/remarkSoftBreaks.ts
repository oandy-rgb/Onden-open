import { visit } from "unist-util-visit";
import type { Root, Text, Break, Parent } from "mdast";

/** One Enter, one line: a newline inside a paragraph renders as a line break,
 *  the way the editor shows it (remark-breaks behaviour; Obsidian's default
 *  with "strict line breaks" off). Code keeps its newlines as they are. */
export function remarkSoftBreaks() {
  return (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent: Parent | undefined) => {
      if (!parent || index === undefined || !node.value.includes("\n")) return;
      const parts = node.value.split(/\r?\n/);
      const replacement: Array<Text | Break> = [];
      parts.forEach((value, i) => {
        if (i > 0) replacement.push({ type: "break" });
        if (value) replacement.push({ type: "text", value });
      });
      parent.children.splice(index, 1, ...replacement);
      return index + replacement.length;
    });
  };
}
