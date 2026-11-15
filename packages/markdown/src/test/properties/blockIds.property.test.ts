// Property tests for the block ids' move out of the text (blocks.ts, legacyBlockIds.ts) through the package entry.
// DB-free; seed and run count from PROPS_SEED / PROPS_RUNS.
//
// Notes are built from a model of blocks with unique labels (`b0`, `b1`, …), so "the same block" is known without
// reading the parser. The model writes the OLD `^id` marks: they are what the migration reads, and what a note must
// never be read from again.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig.js";
import { parseBlocks, parseLegacyBlocks, stripLegacyIds, writeLegacyIds, hasLegacyIds, BLOCK_ID } from "../../index.js";

const fcOpts = { seed: PROPS_SEED, numRuns: PROPS_RUNS };

// A small id pool, so duplicates are common; one id at the length limit.
const ids = fc.constantFrom("a", "b", "c", "a-1", "A", "n0", "n1", "x".repeat(64));
type Spec = { kind: "paragraph" | "heading" | "listItem"; tagged: boolean; id: string | null; tail: string };
const spec: fc.Arbitrary<Spec> = fc.record({
  kind: fc.constantFrom("paragraph", "heading", "listItem"),
  tagged: fc.boolean(),
  id: fc.option(ids, { nil: null }),
  tail: fc.constantFrom("", " 字", " 😀", "​"),
});

const lineOf = (s: Spec, i: number, label = `b${i}`, withId = true): string => {
  const text = `${label}${s.tail}`;
  const tags = s.tagged ? " {#t}" : "";
  const id = withId && s.id ? ` ^${s.id}` : "";
  return s.kind === "heading" ? `## ${text}${tags}${id}` : s.kind === "listItem" ? `- ${text}${tags}${id}` : `${text}${tags}${id}`;
};
// Separate list items by a paragraph so no two items are one list (an anchor on a list's only item reads as the list's).
const join = (lines: string[], crlf: boolean) => lines.join(crlf ? "\r\n\r\n" : "\n\n") + (lines.length ? "\n" : "");
const note = fc.record({ specs: fc.array(spec, { maxLength: 10 }), crlf: fc.boolean() })
  .map(({ specs, crlf }) => ({
    specs,
    text: join(specs.map((s, i) => lineOf(s, i)), crlf),
    clean: join(specs.map((s, i) => lineOf(s, i, `b${i}`, false)), crlf),
  }));

const convert = (text: string) => {
  const out = stripLegacyIds(text);
  if ("refused" in out) throw new Error(`refused: ${out.refused} for ${JSON.stringify(text)}`);
  return out;
};
const shape = (md: string) => parseBlocks(md).map((b) => [b.kind, b.tags.join(","), b.parent, b.start] as const);

describe("a `^id` in the text is not read", () => {
  it("parseBlocks gives no block a ref, whatever ids the text carries", () => {
    fc.assert(fc.property(note, ({ text }) => {
      for (const b of parseBlocks(text)) expect(b.ref).toBeNull();
    }), fcOpts);
  });

  it("an id written after a block's text changes nothing about the blocks that have none", () => {
    fc.assert(fc.property(note, ({ specs, text, clean }) => {
      // Only the untagged lines: a `^id` after a `{tag}` ends the line with something else, so that block is gone (tested apart).
      const partial = join(specs.map((s, i) => lineOf({ ...s, tagged: false, id: s.id ?? "z9" }, i)), text.includes("\r\n"));
      const plain = join(specs.map((s, i) => lineOf({ ...s, tagged: false }, i, `b${i}`, false)), clean.includes("\r\n"));
      expect(shape(partial).map(([kind, tags, parent]) => [kind, tags, parent])).toEqual(shape(plain).map(([kind, tags, parent]) => [kind, tags, parent]));
    }), fcOpts);
  });

  it("an id after a block's `{tags}` makes the line stop ending with them: the block is no block node", () => {
    expect(parseBlocks("text {重要} ^ab12").length).toBe(0);
    expect(parseBlocks("text {重要}").length).toBe(1);
  });
});

describe("stripLegacyIds / writeLegacyIds (the way out and back)", () => {
  it("the stripped text is the text without its ids, and carries no id any more", () => {
    fc.assert(fc.property(note, ({ text, clean }) => {
      const out = convert(text);
      expect(out.markdown).toBe(clean);
      expect(hasLegacyIds(out.markdown)).toBe(false);
    }), fcOpts);
  });

  it("every id the note wrote is anchored once; a repeat is flagged, not anchored twice", () => {
    fc.assert(fc.property(note, ({ specs, text }) => {
      const { anchors } = convert(text);
      const written = specs.filter((s) => s.id).map((s) => s.id!);
      expect(anchors.map((a) => a.id)).toEqual(written);
      const seen = new Set<string>();
      for (const a of anchors) { expect(a.repeat).toBe(seen.has(a.id)); seen.add(a.id); expect(BLOCK_ID.test(a.id)).toBe(true); }
    }), fcOpts);
  });

  it("a block node keeps the id its mark had, through the anchor (an id written once)", () => {
    fc.assert(fc.property(note, ({ specs, text }) => {
      const out = convert(text);
      const first = out.anchors.filter((a) => !a.repeat).map(({ id, from }) => ({ id, from }));
      const legacy = parseLegacyBlocks(text);
      const now = parseBlocks(out.markdown, first);
      expect(now.map((b) => b.label)).toEqual(legacy.map((b) => b.label));
      const written = specs.flatMap((s) => (s.id ? [s.id] : []));
      now.forEach((b, i) => {
        const was = legacy[i]!.ref;
        if (was !== null && written.filter((id) => id === was).length === 1) expect(b.ref).toBe(was);
      });
    }), fcOpts);
  });

  // LF only: writeLegacyIds does not write into CRLF text (it skips those anchors, never a guess), see the report.
  it("writing the ids back and stripping them again gives the same text and the same anchors", () => {
    fc.assert(fc.property(note.filter(({ text }) => !text.includes("\r")), ({ text }) => {
      const out = convert(text);
      const anchors = out.anchors.filter((a) => !a.repeat).map(({ id, from, to }) => ({ id, from, to }));
      const written = writeLegacyIds(out.markdown, anchors);
      expect(written.skipped).toEqual([]);
      const again = convert(written.markdown);
      expect(again.markdown).toBe(out.markdown);
      expect(again.anchors.map((a) => [a.id, a.from])).toEqual(anchors.map((a) => [a.id, a.from]));
    }), fcOpts);
  });
});
