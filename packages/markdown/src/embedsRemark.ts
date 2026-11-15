// The remark plugin of embeds (embeds.ts finds them in text). Its own file so the
// `unist-util-visit` chain it needs stays in the Markdown pipeline and out of the
// boot JS, which only reads embeds from text (embeds.ts).
import { visit } from "unist-util-visit";
import { EMBED_SRC_PREFIX, embedLabel, embedMatches } from "./embeds.js";

type TextNode = { type: "text"; value: string };
type ImageNode = { type: "image"; url: string; alt: string; title: null };
type Parent = { children: Array<TextNode | ImageNode | { type: string }> };

/** remark plugin: each `![[…]]` in text becomes an image node with an
 *  `#embed:<body>` src (relative, so it survives sanitize) and the embed's
 *  label as alt. Not in code: code and inline code are not text nodes. */
export function remarkEmbeds() {
  return (tree: import("mdast").Root) => {
    visit(tree, "text", (node, index, parent) => {
      if (!parent || index === undefined) return;
      const text = (node as TextNode).value;
      const matches = embedMatches(text);
      if (matches.length === 0) return;
      const out: Array<TextNode | ImageNode> = [];
      let last = 0;
      for (const m of matches) {
        if (m.start > last) out.push({ type: "text", value: text.slice(last, m.start) });
        out.push({ type: "image", url: EMBED_SRC_PREFIX + encodeURIComponent(m.body), alt: embedLabel(m), title: null });
        last = m.end;
      }
      if (last < text.length) out.push({ type: "text", value: text.slice(last) });
      (parent as unknown as Parent).children.splice(index, 1, ...out);
      return index + out.length;
    });
  };
}
