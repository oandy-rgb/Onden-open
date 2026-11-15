// Generators of a note and an AI's rewrite of it, shared by the property tests of AI suggestions
// (properties/aiSuggestionApply.property.test.ts, properties/aiSuggestionAccept.property.integration.test.ts).

import fc from "fast-check";

// ── Generators ───────────────────────────────────────────────────────────────

type Kind = "text" | "heading" | "list" | "quote" | "table" | "fence" | "rule";
type Block = { kind: Kind; text: string };

const word = fc.oneof(
  { weight: 3, arbitrary: fc.stringMatching(/^[a-z]{1,8}$/) },
  { weight: 2, arbitrary: fc.stringMatching(/^[一-龥]{1,6}$/) },
  { weight: 1, arbitrary: fc.constantFrom("「幻覺」", "ＡＩ 工具", "（備註）", "a-b", "x*y") },
);
const sentence = fc.array(word, { minLength: 1, maxLength: 4 }).map((w) => w.join(" "));
const blockId = fc.stringMatching(/^[a-z0-9]{6}$/).map((s) => ` ^${s}`);

// A text may hold a hard line break (two spaces at the end of a line): that is not a trailing space to ignore.
const textBlock = fc.tuple(sentence, fc.option(blockId, { nil: "" }), fc.option(sentence, { nil: undefined })).map(([s, id, more]): Block => ({ kind: "text", text: more ? `${s}  \n${more}${id}` : s + id }));
const headingBlock = fc.tuple(fc.integer({ min: 1, max: 4 }), sentence).map(([n, s]): Block => ({ kind: "heading", text: `${"#".repeat(n)} ${s}` }));
const listItem = fc.tuple(
  fc.constantFrom("- ", "* ", "1. ", "2. ", "- [ ] ", "- [x] "), sentence,
  fc.option(sentence, { nil: undefined }),
).map(([mark, s, nested]): Block => ({ kind: "list", text: `${mark}${s}${nested ? `\n  - ${nested}` : ""}` }));
const quoteBlock = fc.array(sentence, { minLength: 1, maxLength: 2 }).map((l): Block => ({ kind: "quote", text: l.map((s) => `> ${s}`).join("\n") }));
const tableBlock = fc.tuple(sentence, sentence).map(([a, b]): Block => ({ kind: "table", text: `| ${a} | ${b} |\n| --- | --- |\n| 1 | 2 |` }));
const fenceBlock = fc.tuple(sentence, sentence, fc.constantFrom("", "  ", "    ")).map(([a, b, indent]): Block => ({ kind: "fence", text: `\`\`\`ts\n${indent}${a}\n\n${b}\n\`\`\`` }));
const ruleBlock = fc.constant<Block>({ kind: "rule", text: "***" });

const block = fc.oneof(
  { weight: 4, arbitrary: textBlock }, { weight: 2, arbitrary: headingBlock }, { weight: 6, arbitrary: listItem },
  { weight: 1, arbitrary: quoteBlock }, { weight: 1, arbitrary: tableBlock }, { weight: 1, arbitrary: fenceBlock }, { weight: 1, arbitrary: ruleBlock },
);

/** The separators a text may have between two blocks: with or without a blank line. A list's items are tight or
 *  loose; a text line right after a list item or quote is a lazy line of it, or a paragraph of its own; a heading
 *  or a code block may be followed (or preceded) directly by the next block. (One blank line against two is not a
 *  place and is not generated.) */
function separators(prev: Block, next: Block): readonly string[] {
  const touching = prev.kind === "heading" || prev.kind === "fence" || next.kind === "heading" || next.kind === "fence";
  return (prev.kind === "list" && next.kind === "list") || ((prev.kind === "list" || prev.kind === "quote") && next.kind === "text") || touching
    ? ["\n", "\n\n"] : ["\n\n"];
}

export type Doc = { blocks: Block[]; choices: number[] };
export const render = ({ blocks, choices }: Doc): string => {
  let out = "";
  blocks.forEach((b, i) => {
    out += b.text;
    if (i < blocks.length - 1) {
      const options = separators(b, blocks[i + 1]!);
      out += options[choices[i]! % options.length];
    }
  });
  return blocks.length ? out + "\n" : "";
};

const choices = fc.array(fc.nat(1), { minLength: 40, maxLength: 40 });
export const doc = fc.record({ blocks: fc.array(block, { minLength: 1, maxLength: 12 }), choices });

export type Pair = { base: string; proposed: string };

/** A proposal made from the note: some blocks kept, some rewritten, some dropped, some
 *  new, and the separators redrawn: what an AI sending back "the whole new text" does. */
const edited: fc.Arbitrary<Pair> = fc.tuple(doc, fc.array(fc.nat(9), { minLength: 12, maxLength: 12 }), fc.array(block, { minLength: 0, maxLength: 3 }), choices, fc.boolean())
  .map(([base, actions, extra, newChoices, redraw]) => {
    const blocks: Block[] = [];
    const moved: Block[] = [];
    base.blocks.forEach((b, i) => {
      const a = actions[i]!;
      if (a === 0) return; // dropped
      if (a === 4) { moved.push(b); return; } // taken out of its place and put elsewhere
      // 3: only the layout changes: indentation of code, a hard line break, a list item nested one level
      const relaid = a === 3 ? { ...b, text: b.kind === "fence" ? b.text.replace("\n", "\n    ") : b.kind === "list" ? `  ${b.text}` : b.text.includes("  \n") ? b.text.replace("  \n", "\n") : b.text } : b;
      blocks.push(a === 1 ? { ...b, text: `${b.text} 改` } : relaid);
      if (a === 2 && extra.length) blocks.push(extra[i % extra.length]!);
    });
    for (const e of extra.slice(0, 1)) blocks.splice(Math.min(blocks.length, actions[11]! % 4), 0, e);
    // moved blocks go to the top or the bottom (a paragraph carrying a `^id` moved up is the owner's case)
    if (actions[10]! % 2 === 0) blocks.push(...moved); else blocks.unshift(...moved);
    if (blocks.length === 0) blocks.push(base.blocks[0]!); // a note emptied out is not a text of blocks
    return { base: render(base), proposed: render({ blocks, choices: redraw ? newChoices : base.choices }) };
  });

const unrelated: fc.Arbitrary<Pair> = fc.tuple(doc, doc).map(([a, b]) => ({ base: render(a), proposed: render(b) }));
export const pair = fc.oneof({ weight: 4, arbitrary: edited }, { weight: 1, arbitrary: unrelated });

