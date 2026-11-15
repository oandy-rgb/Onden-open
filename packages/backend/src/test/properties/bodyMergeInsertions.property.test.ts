// Property tests of what the note-body merge does with two additions at the
// same place (bodyMerge.ts): separate paragraphs stay separate, and typing that one
// side continues is still taken whole.
// DB-free. Run count and seed: PROPS_RUNS / PROPS_SEED (helpers/propsConfig.ts), e.g.
//   PROPS_SEED=7 PROPS_RUNS=5000 npx vitest run src/test/properties/bodyMergeInsertions.property.test.ts

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { threeWayMergeBody } from "../../services/eventLog/bodyMerge.js";
import { check } from "../helpers/propsConfig.js";

const both = (base: string, ours: string, theirs: string) => ({
  r: threeWayMergeBody(base, ours, theirs),
  back: threeWayMergeBody(base, theirs, ours),
});

// ── Paragraphs ───────────────────────────────────────────────────────────────

// Kinds of blocks a note holds; every one has a unique tag so it can be found again.
const blockOf = (kind: number, tag: string, eol: string): string =>
  [`para ${tag}`, `- item ${tag}`, `# head ${tag}`, ["```", `code ${tag}`, "```"].join(eol), `> quote ${tag}`, `1. step ${tag}`][kind % 6]!;

const paragraphDoc = fc.record({
  kinds: fc.array(fc.nat(5), { minLength: 1, maxLength: 6 }),
  eol: fc.constantFrom("\n", "\r\n"),
  final: fc.boolean(),
  at: fc.nat(6), // where both writers add (a gap between blocks, 0 = before the first)
  kindA: fc.nat(5), kindB: fc.nat(5),
  lenA: fc.integer({ min: 1, max: 2 }), lenB: fc.integer({ min: 1, max: 2 }),
});

describe("two paragraphs added at one gap", () => {
  it("1. both stay, each its own paragraph, in a fixed order; either order of merging gives the same body", () => {
    check(fc.property(paragraphDoc, (d) => {
      const blocks = d.kinds.map((k, i) => blockOf(k, `base${i}`, d.eol));
      const at = d.at % (blocks.length + 1);
      // Known limit: a code block added next to another code block. The line diff may read the
      // neighbour's fence as the added block's fence (the lines are equal), so both writers'
      // code then land in one fence. Nothing is lost; the paragraphs property is not claimed.
      const fenceNeighbour = [d.kinds[at - 1], d.kinds[at]].some((k) => k !== undefined && k % 6 === 3);
      fc.pre(!(fenceNeighbour && (d.kindA % 6 === 3 || d.kindB % 6 === 3)));
      const written = (tag: string, kind: number, len: number) =>
        // A block of `len` lines for a plain paragraph; fenced code and others are whole already.
        len === 2 && kind % 6 === 0 ? `para ins-${tag}${d.eol}more ins-${tag}` : blockOf(kind, `ins-${tag}`, d.eol);
      const A = written("A", d.kindA, d.lenA);
      const B = written("B", d.kindB, d.lenB);
      const join = (parts: string[]) => parts.join(`${d.eol}${d.eol}`) + (d.final ? d.eol : "");
      const withBlock = (extra: string) => join([...blocks.slice(0, at), extra, ...blocks.slice(at)]);
      const base = join(blocks);
      const norm = (text: string) => text.replace(/\r\n/g, "\n");
      const ours = withBlock(A), theirs = withBlock(B);
      const { r, back } = both(base, ours, theirs);
      expect(r).toMatchObject({ clean: true, conflicts: [] });
      expect(back.merged).toBe(r.merged);
      // Each writer's block and every base block is a paragraph of its own, base blocks in order.
      const paragraphs = norm(r.merged).replace(/\n$/, "").split("\n\n");
      expect(paragraphs.filter((p) => p === norm(A))).toHaveLength(1);
      expect(paragraphs.filter((p) => p === norm(B))).toHaveLength(1);
      expect(paragraphs.filter((p) => !p.includes("ins-"))).toEqual(blocks.map(norm));
      // The line ending is the note's own.
      if (d.eol === "\r\n") expect(r.merged.replace(/\r\n/g, "")).not.toContain("\n");
    }));
  });
});

// ── One line (unchanged behaviour: continued typing) ─────────────────────────

const words = ["alpha", "beta", "gamma", "delta", "一行文字", "x", "yy"];
const pieces = ["Q", "zz", " Z", "! ", "- ", " w ", "字", "s", "ed", "?"];

it("2. typing that one side continues is not a conflict: a prefix of what the other wrote lands as the longer text", () => {
  check(fc.property(fc.constantFrom(...words), fc.nat(40), fc.array(fc.constantFrom("Q", "Z", "!", "-", "7"), { minLength: 2, maxLength: 8 }).map((c) => c.join("")), fc.nat(8), (word, at, typed, cut) => {
    const p = at % (word.length + 1);
    const insert = (t: string) => `${word.slice(0, p)}${t}${word.slice(p)}\n`;
    const shorter = typed.slice(0, 1 + (cut % (typed.length - 1)));
    const base = `${word}\n`;
    for (const [ours, theirs] of [[insert(typed), insert(shorter)], [insert(shorter), insert(typed)]] as const) {
      expect(threeWayMergeBody(base, ours, theirs)).toMatchObject({ clean: true, merged: insert(typed) });
    }
  }));
});

it("3. a line only one writer changed lands whole, whatever the other did elsewhere", () => {
  check(fc.property(fc.array(fc.constantFrom(...words), { minLength: 2, maxLength: 5 }), fc.constantFrom(...pieces), (ws, piece) => {
    const base = ["first", ...ws, "last"].join("\n") + "\n";
    const ours = ["first", ...ws, "last"].join("\n").replace("first", `first${piece}`) + "\n";
    const theirs = base.replace(/last\n$/, "last end\n");
    const r = threeWayMergeBody(base, ours, theirs);
    expect(r.clean).toBe(true);
    expect(r.merged).toBe(ours.replace(/last\n$/, "last end\n"));
  }));
});
