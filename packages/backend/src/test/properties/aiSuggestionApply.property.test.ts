// Property tests of an AI suggestion's paragraph items (services/aiSuggestionBlocks):
// what proposeItems cuts a proposal into and what applyItems writes back.
//
// DB-free. Run count and seed come from PROPS_RUNS / PROPS_SEED (helpers/propsConfig.ts).
//
// The properties, for a note `base` and an AI's text `proposed`:
//   1. accept every item   → exactly `proposed`, byte for byte (tight and loose
//                            lists, heading gaps, tables, code, quotes, `^id` included);
//   2. accept none         → exactly `base`;
//   3. accept some         → every block is one of the two versions' blocks, and every
//                            separator between two blocks is the separator one of the
//                            versions had after that block: no blank line made up,
//                            no list pulled apart.
// And two whitespace rules: a tight ↔ loose change is a place (never "no change"),
// while one blank line versus two is not.
//
// Texts use the separators "\n" and "\n\n" only (the rest is the second rule).

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { splitParagraphs, type Paragraph } from "@onden/markdown";
import { applyItems, proposeItems, type ItemDraft } from "../../services/aiSuggestionBlocks.js";
import { check } from "../helpers/propsConfig.js";

import { pair, doc, render } from "../helpers/markdownDocPairs.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const apply = (base: string, items: readonly ItemDraft[]) => {
  const r = applyItems(base, items);
  expect(r.missing).toEqual([]);
  return r.markdown;
};

/** The separator each paragraph text had in `markdown` (the last one: either default). */
function afters(markdown: string, into: Map<string, Set<string>>): void {
  const ps = splitParagraphs(markdown);
  ps.forEach((p, i) => {
    for (const key of [p.text, p.body]) {
      const set = into.get(key) ?? into.set(key, new Set()).get(key)!;
      if (i < ps.length - 1) set.add(markdown.slice(p.end, ps[i + 1]!.start));
      else { set.add("\n"); set.add("\n\n"); }
    }
  });
}

describe("AI suggestion items", () => {
  it("accepting every item gives the proposal back verbatim; accepting none keeps the note", () => {
    check(fc.property(pair, ({ base, proposed }) => {
      const items = proposeItems(base, proposed);
      expect(apply(base, items)).toBe(proposed);
      expect(apply(base, [])).toBe(base);
    }));
  });

  it("a partly accepted suggestion is made of the two versions' blocks and separators only", () => {
    check(fc.property(pair, fc.array(fc.boolean(), { minLength: 200, maxLength: 200 }), ({ base, proposed }, picks) => {
      const items = proposeItems(base, proposed);
      const result = apply(base, items.filter((_, i) => picks[i]));
      // (a moved block taken at its new place only is written without its `^id`: an id names one block)
      const blocks = new Set([...splitParagraphs(base), ...splitParagraphs(proposed)].flatMap((p: Paragraph) => [p.text, p.body]));
      const separatorsOf = new Map<string, Set<string>>();
      afters(base, separatorsOf);
      afters(proposed, separatorsOf);
      const parts = splitParagraphs(result);
      // an id names one block: when neither text repeats one, a partly accepted note does not either
      const idsOf = (text: string) => splitParagraphs(text).flatMap((p) => (p.blockId ? [p.blockId] : []));
      if (new Set(idsOf(base)).size === idsOf(base).length && new Set(idsOf(proposed)).size === idsOf(proposed).length) {
        expect(new Set(idsOf(result)).size, `an id twice in ${JSON.stringify(result)}`).toBe(idsOf(result).length);
      }
      parts.forEach((p, i) => {
        expect(blocks.has(p.text), `block ${JSON.stringify(p.text)} is in neither version`).toBe(true);
        if (i < parts.length - 1) {
          const gap = result.slice(p.end, parts[i + 1]!.start);
          // The one separator not taken from a version: a blank line where a bare line break would
          // run two blocks into one paragraph (the block between them was left out), or a text line that would become part of the list item above it.
          const next = parts[i + 1]!.text;
          const joined = splitParagraphs(`${p.text}\n${next}`);
          const needed = gap === "\n\n" && (joined.length !== 2 || (joined[1]!.kind === "text" && (joined[0]!.kind === "listItem" || joined[0]!.kind === "quote")));
          expect(separatorsOf.get(p.text)!.has(gap) || needed, `separator ${JSON.stringify(gap)} after ${JSON.stringify(p.text)}`).toBe(true);
        }
      });
    }));
  });

  it("an item for each paragraph that changed, none when nothing the reader sees differs", () => {
    check(fc.property(doc, (d) => {
      const text = render(d);
      expect(proposeItems(text, text)).toEqual([]);
    }));
  });
});

describe("AI suggestion items: the AI's own example", () => {
  const base = "作者質疑兩點：\n\n- 「幻覺」這個詞，各家的定義都不一樣。\n\n- 這些工具從來沒公開過任何評測結果。\n";
  const tight = "作者質疑兩點：\n\n- 「幻覺」這個詞，各家的定義都不一樣。\n- 這些工具從來沒公開過任何評測結果。\n";

  it("a tight list the AI sent is stored as sent, item by item", () => {
    const items = proposeItems("作者質疑兩點：\n", tight);
    expect(apply("作者質疑兩點：\n", items)).toBe(tight);
  });

  it("taking one item of a tight list does not make the list loose", () => {
    const before = "intro\n\n- a\n";
    const after = "intro\n\n- a\n- b\n- c\n";
    const items = proposeItems(before, after);
    expect(items).toHaveLength(2);
    expect(apply(before, items.slice(1))).toBe("intro\n\n- a\n- c\n");
    expect(apply(before, items.slice(0, 1))).toBe("intro\n\n- a\n- b\n");
  });

  it("loose → tight is a place of its own, not 'nothing to suggest'", () => {
    const items = proposeItems(base, tight);
    expect(items).toHaveLength(1);
    expect(apply(base, items)).toBe(tight);
    expect(apply(tight, proposeItems(tight, base))).toBe(base);
  });

  it("one blank line versus two changes nothing the reader sees", () => {
    expect(proposeItems("a\n\nb\n", "a\n\n\n\nb\n")).toEqual([]);
  });
});
