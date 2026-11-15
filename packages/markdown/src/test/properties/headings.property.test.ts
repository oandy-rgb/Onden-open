// Property tests for heading anchors (headingAnchors.ts) through the package
// entry. DB-free; seed and run count from PROPS_SEED / PROPS_RUNS.
//
// The notes are built from a model (a list of headings, fences, math blocks,
// paragraphs), so the expected headings are known without reading the parser.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig.js";
import { headingAnchors, headingAnchorLines } from "../../index.js";

const fcOpts = { seed: PROPS_SEED, numRuns: PROPS_RUNS };

// A small word pool, so equal headings (and `a` / `a-1` clashes) are common.
const word = fc.constantFrom("a", "a-1", "1", "Goals", "目標", "日本語", "한글", "😀", "🇹🇼", "é", "A_b", "!!!", "x​y");
const headingText = fc.array(word, { minLength: 1, maxLength: 3 }).map((w) => w.join(" "));

type Item =
  | { kind: "heading"; depth: number; text: string }
  | { kind: "code" | "math" | "paragraph"; lines: string[] };

// Lines that look like headings, inside something that makes them text.
const lookalike = fc.constantFrom("# not a heading", "## 目標", "### a", "#", "###### x", "# a-1", "# 😀");
const item: fc.Arbitrary<Item> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("heading" as const), depth: fc.integer({ min: 1, max: 6 }), text: headingText }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("code" as const), lines: fc.array(lookalike, { maxLength: 4 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("math" as const), lines: fc.array(lookalike, { minLength: 1, maxLength: 3 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("paragraph" as const), lines: fc.array(word.map((w) => `p ${w}`), { minLength: 1, maxLength: 3 }) }) },
);

const render = (items: Item[], fence: string, crlf: boolean, frontmatter: boolean): string => {
  const blocks = items.map((it) => {
    if (it.kind === "heading") return `${"#".repeat(it.depth)} ${it.text}`;
    if (it.kind === "code") return [fence, ...it.lines, fence].join("\n");
    if (it.kind === "math") return ["$$", ...it.lines, "$$"].join("\n");
    return it.lines.join("\n");
  });
  const body = blocks.join("\n\n") + (blocks.length ? "\n" : "");
  const head = frontmatter ? "---\ntitle: T\n# a yaml comment\n---\n\n" : "";
  const text = head + body;
  return crlf ? text.replace(/\n/g, "\r\n") : text;
};

const note = fc.record({
  items: fc.array(item, { maxLength: 10 }),
  fence: fc.constantFrom("```", "~~~", "````"),
  crlf: fc.boolean(),
  frontmatter: fc.boolean(),
}).map((n) => ({ ...n, text: render(n.items, n.fence, n.crlf, n.frontmatter) }));

const headingsOf = (items: Item[]) => items.flatMap((i) => (i.kind === "heading" ? [i] : []));

describe("headingAnchors / headingAnchorLines", () => {
  it("lists exactly the real headings, in order: lookalikes in code fences and `$$` math are not headings", () => {
    fc.assert(fc.property(note, ({ items, text }) => {
      expect(headingAnchors(text).map((h) => h.depth)).toEqual(headingsOf(items).map((h) => h.depth));
    }), fcOpts);
  });

  it("the two entries agree: same anchors, one line each", () => {
    fc.assert(fc.property(note, ({ text }) => {
      expect(headingAnchorLines(text).map((h) => h.anchor)).toEqual(headingAnchors(text));
    }), fcOpts);
  });

  it("anchor ids are never repeated, never empty", () => {
    fc.assert(fc.property(note, ({ text }) => {
      const ids = headingAnchors(text).map((h) => h.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).not.toBe("");
    }), fcOpts);
  });

  it("the returned line is the heading's own line, and lines increase", () => {
    fc.assert(fc.property(note, ({ items, text }) => {
      const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
      const found = headingAnchorLines(text);
      let previous = -1;
      found.forEach(({ anchor, line }, i) => {
        expect(lines[line]).toMatch(new RegExp(`^#{${anchor.depth}} `));
        expect(lines[line]).toBe(`${"#".repeat(anchor.depth)} ${headingsOf(items)[i]!.text}`);
        expect(line).toBeGreaterThan(previous);
        previous = line;
      });
    }), fcOpts);
  });

  it("adding a paragraph or a fenced block of lookalikes changes no anchor", () => {
    fc.assert(fc.property(note, fc.array(lookalike, { minLength: 1, maxLength: 3 }), fc.constantFrom("```", "~~~"), ({ text }, lines, fence) => {
      const eol = text.includes("\r\n") ? "\r\n" : "\n";
      const extra = [fence, ...lines, fence].join(eol);
      expect(headingAnchors(`${text}${eol}${extra}${eol}`)).toEqual(headingAnchors(text));
      expect(headingAnchors(`${text}${eol}$$${eol}${lines.join(eol)}${eol}$$${eol}`)).toEqual(headingAnchors(text));
    }), fcOpts);
  });
});
