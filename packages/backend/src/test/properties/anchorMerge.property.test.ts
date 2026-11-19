// The anchors of a body the merge core makes from several heads (spine/stampedMerge/body.ts `mergeAnchors`, `resolveBodyAnchors`; anchors proposal 2026-11-16 §3.1,
// step 3). The same algebra the unit merge claims (stampedMergeAlgebra.test.ts), on random notes: every order of the heads and any of them twice give the same anchor rows,
// byte for byte; the function is pure and leaves its inputs as they were; with one side unchanged the result is the other side's anchors unchanged; and when ONE head's
// text wins outright its anchors are taken as they are, without moving anything. DB-free. Run count and seed: helpers/propsConfig.ts.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { dice } from "../../services/blockAnchors/similarity.js";
import { mergeBody } from "../../services/eventLog/bodyMergeMoves.js";
import { canonical, type Cell } from "../../spine/stampedMerge/unit.js";
import { anchorsOfVersion, mergeAnchors, resolveBodyAnchors, type AnchorFact, type BodyVersion, type MoveAnchorsFn } from "../../spine/stampedMerge/body.js";
import { chooseAnchorHead, parseAnchorUnit } from "../../spine/stampedMerge/anchorUnit.js";
/** spine/stampedMerge/anchorUnit.ts ANCHOR_UNIT_BYTES_MAX (migration 215 anchor_unit_bytes_max): the largest unit a node takes, in bytes of its text. */
const ANCHOR_UNIT_BYTES_MAX = 16_000_000;
import { anchorUnitJson } from "../helpers/anchorUnitText.js";
const unitText = (h: string, a: Record<string, unknown[]>) => anchorUnitJson({ h, a });
import { anchorOn, walk } from "../helpers/anchorPath.js";
import { factOf, factsOf, moveFacts } from "../helpers/anchorFacts.js";
import { check } from "../helpers/propsConfig.js";

const CHARS = Array.from("甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地玄黃宇宙洪荒日月盈昃辰宿列張寒來暑往秋收冬藏");
const sentence = fc.array(fc.constantFrom(...CHARS), { minLength: 5, maxLength: 12 }).map((cs) => cs.join("") + "。");
const paragraph = fc.array(sentence, { minLength: 2, maxLength: 4 });
const docOf = (ps: string[][]) => ps.map((p) => p.join("")).join("\n\n");
const distinct = (ps: string[][]) => ps.every((p, i) => ps.slice(i + 1).every((q) => dice(p.join(""), q.join("")) < 0.3));
type Edit = { para: number; sentence: number; text: string } | { insertAfter: number; text: string[] };
const edit: fc.Arbitrary<Edit> = fc.oneof(
  fc.record({ para: fc.nat({ max: 9 }), sentence: fc.nat({ max: 3 }), text: sentence }),
  fc.record({ insertAfter: fc.nat({ max: 9 }), text: paragraph }),
);
const apply = (ps: string[][], e: Edit): string[][] => {
  if ("insertAfter" in e) { const at = e.insertAfter % (ps.length + 1); return [...ps.slice(0, at), e.text, ...ps.slice(at)]; }
  const i = e.para % ps.length;
  return ps.map((p, k) => (k === i ? p.map((s, j) => (j === e.sentence % p.length ? e.text : s)) : p));
};
/** A note, its anchors (one per paragraph), and 2-4 heads: each made by its writer's own saves from the base (zero edits = a head that did not change the text). */
const scenario = fc.integer({ min: 3, max: 6 }).chain((n) => fc.record({
  paras: fc.array(paragraph, { minLength: n, maxLength: n }).filter(distinct),
  heads: fc.array(fc.array(edit, { maxLength: 3 }), { minLength: 2, maxLength: 4 }),
}));

function build(s: { paras: string[][]; heads: Edit[][] }): { base: BodyVersion; heads: BodyVersion[]; merged: string } {
  const d0 = docOf(s.paras);
  const start = s.paras.map((p, i) => anchorOn(d0, p.join(""), `a${i}`)).map((a) => ({ ...a, atBody: d0 }));
  const base: BodyVersion = { text: d0, anchors: factsOf(start) };
  const heads = s.heads.map((edits) => {
    let ps = s.paras; const versions = [d0];
    for (const e of edits) { ps = apply(ps, e); versions.push(docOf(ps)); }
    const text = versions[versions.length - 1]!;
    const walked = factsOf(walk(start, versions)); // the writer's own path: one save per edit
    // a paragraph this head inserted gets an anchor only this head holds (review point 14)
    const added = edits.flatMap((e, k) => ("insertAfter" in e && text.includes(e.text.join("")) ? [factOf(anchorOn(text, e.text.join(""), `n${s.heads.indexOf(edits)}x${k}`))] : []));
    return { text, anchors: [...walked, ...added] };
  });
  // the merged text as the core makes it (resolveBody: folded in stamp order); the anchors must not depend on that order, only on the set
  const cells: Cell[] = heads.map((h, i) => ({ stamp: { origin: `n${i}`, seq: 1, wall: 1_700_000_000_000 + i, counter: 0, author: null, device: null }, saw: {}, deleted: false, value: h.text }));
  const merged = resolveBodyAnchors(cells, base, mergeBody, () => [], moveFacts).text;
  return { base, heads, merged };
}
const text = (xs: readonly AnchorFact[]) => canonical(xs);
const permutations = <T,>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
const deepFreeze = <T,>(v: T): T => { if (v && typeof v === "object") { Object.values(v as object).forEach(deepFreeze); Object.freeze(v); } return v; };

describe("the anchors of a merged body (mergeAnchors)", () => {
  it("every order of the heads, and any head given twice, gives the same anchor rows, byte for byte", () => {
    check(fc.property(scenario, (s) => {
      const { base, heads, merged } = build(s);
      const reference = text(mergeAnchors({ base, heads, merged }, moveFacts));
      for (const order of permutations(heads)) expect(text(mergeAnchors({ base, heads: order, merged }, moveFacts))).toBe(reference);
      for (const h of heads) expect(text(mergeAnchors({ base, heads: [...heads, h], merged }, moveFacts)), "a head twice").toBe(reference);
      // grouping: the heads arrive in two groups (the core merges units, so what reaches this function is the union)
      for (let cut = 1; cut < heads.length; cut++) expect(text(mergeAnchors({ base, heads: [...heads.slice(cut), ...heads.slice(0, cut)], merged }, moveFacts))).toBe(reference);
    }), 150);
  });

  it("is pure: frozen inputs, the same answer twice, and the inputs are as they were", () => {
    check(fc.property(scenario, (s) => {
      const input = build(s);
      const before = canonical(input);
      deepFreeze(input);
      const one = mergeAnchors(input, moveFacts), two = mergeAnchors(input, moveFacts);
      expect(text(one)).toBe(text(two));
      expect(canonical(input)).toBe(before);
    }), 100);
  });

  it("with one side unchanged (its text is the base), the result is the other side's anchors, unchanged", () => {
    check(fc.property(scenario, (s) => {
      const { base, heads } = build(s);
      const x = heads[0]!;
      const merged = mergeBody(base.text, x.text, base.text).merged;
      expect(merged).toBe(x.text);
      expect(text(mergeAnchors({ base, heads: [x, base], merged }, moveFacts))).toBe(text(x.anchors));
      expect(text(mergeAnchors({ base, heads: [base, x], merged }, moveFacts))).toBe(text(x.anchors));
    }), 150);
  });

  it("every anchor of every head is in the result, at most once, and a valid one stands inside the merged text", () => {
    check(fc.property(scenario, (s) => {
      const { base, heads, merged } = build(s);
      const out = mergeAnchors({ base, heads, merged }, moveFacts);
      expect(out.map((a) => a.anchorId)).toEqual([...new Set(heads.flatMap((h) => h.anchors.map((a) => a.anchorId)))].sort());
      for (const a of out) if (a.status === "valid") expect(a.to <= merged.length && a.from < a.to).toBe(true); else expect([a.from, a.to]).toEqual([0, 0]);
    }), 150);
  });
});

describe("one head's text wins outright: its anchors are taken as they are (resolveBodyAnchors)", () => {
  const refuse: MoveAnchorsFn = () => { throw new Error("nothing may be moved when one head's text is the answer"); };
  it("a single head, or the same text from several heads, is adopted without moving anything", () => {
    check(fc.property(scenario, (s) => {
      const { base, heads } = build(s);
      const h = heads[0]!;
      const cell = (o: string, wall: number): Cell => ({ stamp: { origin: o, seq: 1, wall, counter: 0, author: null, device: null }, saw: {}, deleted: false, value: h.text });
      for (const unit of [[cell("n0", 1)], [cell("n0", 1), cell("n1", 2)]]) {
        const r = resolveBodyAnchors(unit, base, mergeBody, () => h.anchors, refuse);
        expect(r.kind).toBe("single");
        expect(text(r.anchors)).toBe(text(h.anchors));
      }
    }), 100);
  });
  it("two texts and no base (kept as a decision): the shown text keeps its own anchors, the one left out keeps its own", () => {
    check(fc.property(scenario, (s) => {
      const { heads } = build(s);
      const [x, y] = [heads[0]!, heads[1]!];
      if (x.text === y.text) return;
      const cells: Cell[] = [x, y].map((h, i) => ({ stamp: { origin: `n${i}`, seq: 1, wall: 1 + i, counter: 0, author: null, device: null }, saw: {}, deleted: false, value: h.text }));
      const anchorsOf = (c: Cell) => (c.value === x.text ? x.anchors : y.anchors);
      const r = resolveBodyAnchors(cells, null, mergeBody, anchorsOf, refuse);
      expect(r.kind).toBe("needs-decision");
      expect(text(r.anchors)).toBe(text(y.anchors)); // the newer stamp's text is shown
      expect(r.offeredAnchors.map(text)).toEqual([text(x.anchors)]);
    }), 100);
  });
});

// review of PR #1853, point 14: the property must reach the rules it states, not only pass
describe("the scenarios reach the branches of the rule", () => {
  it("anchors only one head holds, and anchors two writers place differently (the `maybe` rule), both occur", () => {
    let single = 0, disagree = 0;
    check(fc.property(scenario, (s) => {
      const { base, heads, merged } = build(s);
      const out = new Map(mergeAnchors({ base, heads, merged }, moveFacts).map((a) => [a.anchorId, a] as const));
      const writers = heads.filter((h) => h.text !== base.text);
      for (const id of out.keys()) {
        const holders = heads.filter((h) => h.anchors.some((a) => a.anchorId === id));
        if (holders.length === 1) single++;
        const says = new Set(writers.filter((h) => h.anchors.some((a) => a.anchorId === id))
          .map((h) => canonical((h.text === merged ? h.anchors : moveFacts(h.anchors, h.text, merged)).find((a) => a.anchorId === id))));
        const placeSays = new Set([...says].map((t) => { const x = JSON.parse(t) as AnchorFact; return canonical({ s: x.status, f: x.from, t: x.to, c: x.candidate }); }));
        if (placeSays.size > 1) { disagree++; expect(out.get(id)!.status).toBe("maybe"); expect([out.get(id)!.from, out.get(id)!.to]).toEqual([0, 0]); }
      }
    }), 150);
    expect(single, "no scenario had an anchor only one head holds").toBeGreaterThan(0);
    expect(disagree, "no scenario reached the disagreement rule").toBeGreaterThan(0);
  });
});

// review point 5: every value from the outside goes through one check; a bad one is left out, nothing throws, and the answer does not depend on where it stood
describe("unusable values are left out, never thrown on", () => {
  const junk = fc.oneof(
    fc.constant(null), fc.constant(undefined), fc.integer(), fc.string(), fc.constant({}),
    fc.record({ anchorId: fc.oneof(fc.string(), fc.constant("a0")), status: fc.oneof(fc.constant("valid"), fc.string()), from: fc.oneof(fc.double(), fc.integer({ min: -5, max: 5 })),
      to: fc.oneof(fc.double(), fc.integer({ min: -5, max: 5 })), candidate: fc.oneof(fc.constant(undefined), fc.constant(null), fc.record({ from: fc.double(), to: fc.integer() })),
      quote: fc.oneof(fc.string(), fc.integer()), prefix: fc.string(), suffix: fc.string(), recoveryPending: fc.oneof(fc.boolean(), fc.constant("no")) }, { requiredKeys: [] }),
  );
  it("mergeAnchors with junk among the facts: no throw, the same answer in any order, and the same as without the junk", () => {
    check(fc.property(scenario, fc.array(junk, { maxLength: 4 }), (s, bad) => {
      const { base, heads, merged } = build(s);
      const spoiled = heads.map((h, i) => ({ text: h.text, anchors: [...(bad.slice(i) as AnchorFact[]), ...h.anchors, ...(bad.slice(0, i) as AnchorFact[]), ...h.anchors.slice(0, 1)] }));
      const one = canonical(mergeAnchors({ base, heads: spoiled, merged }, moveFacts));
      expect(canonical(mergeAnchors({ base, heads: [...spoiled].reverse(), merged }, moveFacts))).toBe(one);
      // the junk changed nothing: the same as without it (a fact given twice in one head counts once)
      expect(one).toBe(canonical(mergeAnchors({ base, heads, merged }, moveFacts)));
    }), 100);
  });
  it("parseAnchorUnit and anchorsOfVersion: any text, any JSON, missing or mistyped fields — a reason, never a throw; the head measured on the body is still found", () => {
    const H = "a".repeat(64), OTHER = "c".repeat(64);
    const unitOf = (h: string, entry: unknown[]) => unitText(h, { a1: entry });
    const good = unitOf(H, [1, 4, "valid", null, null, false, "q", "", ""]);
    check(fc.property(fc.array(fc.oneof(fc.string(), fc.constant("null"), fc.constant("[]"), fc.json(), fc.constant(unitOf(H, ["x", 4, "valid", null, null, false, "q", "", ""])),
      fc.constant(good.replace(H, "zz")), fc.constant(unitOf(H, [1.5, 4, "valid", null, null, false, "q", "", ""])), fc.constant(unitOf(H, [-1, 4, "valid", null, null, false, "q", "", ""])),
      fc.constant(unitOf(H, [1, 4, "valid", 3, null, false, "q", "", ""])), fc.constant(unitOf(H, [1, 4]))), { maxLength: 5 }), (texts) => {
      for (const t of texts) expect(() => parseAnchorUnit(t)).not.toThrow();
      const cell = (v: unknown, wall: number) => ({ stamp: { origin: "n", seq: wall, wall, counter: 0, author: null, device: null }, saw: {}, deleted: false, value: v as string });
      // the usable head of another body is newer: it must not show with this body
      const unit = [...texts.map((t, i) => cell(t, i + 1)), cell(good, 0), cell(unitOf(OTHER, [0, 0, "lost", null, null, false, "q", "", ""]), 99)];
      const r = anchorsOfVersion(unit, H, 10);
      expect(r.map((a) => [a.anchorId, a.status, a.from, a.to])).toEqual([["a1", "valid", 1, 4]]);
      expect(canonical(anchorsOfVersion([...unit].reverse(), H, 10))).toBe(canonical(r));
      expect(chooseAnchorHead(unit, "d".repeat(64), 10)).toMatchObject({ text: null, hash: OTHER }); // no head on that body: the newest usable head's body
      expect(anchorsOfVersion(unit, H, 3)).toEqual([]); // the head on that body stands past its end: not chosen (it was not bounded when it arrived)
    }), 200);
  });
});

// review point 18 (and 5.3 question 1): fixed inputs, fixed outputs. A dependency upgrade (the diff library, @codemirror/state) that changes what the merge answers turns this
// red; that is when SYNC_DATA_SHAPE_VERSION goes up (spine/syncDataShape.ts), not before.
describe("fixed inputs, fixed outputs", () => {
  const base = "One paragraph about apples.\n\nTwo paragraph about pears.\n\nThree paragraph about plums.\n";
  const at = (text: string, para: string, id: string): AnchorFact => factOf(anchorOn(text, para, id));
  const a = "One paragraph about apples, edited by A.\n\nTwo paragraph about pears.\n\nThree paragraph about plums.\n";
  const b = "One paragraph about apples.\n\nTwo paragraph about pears.\n\nThree paragraph about plums, edited by B.\n\nFour, added by B.\n";
  const merged = mergeBody(base, b, a).merged;
  const heads: BodyVersion[] = [
    { text: a, anchors: [at(a, "One paragraph about apples, edited by A.", "p1"), at(a, "Two paragraph about pears.", "p2"), at(a, "Three paragraph about plums.", "p3")] },
    { text: b, anchors: [at(b, "One paragraph about apples.", "p1"), at(b, "Two paragraph about pears.", "p2"), at(b, "Three paragraph about plums, edited by B.", "p3"), at(b, "Four, added by B.", "p4")] },
  ];
  it("mergeAnchors", () => {
    expect(merged).toBe("One paragraph about apples, edited by A.\n\nTwo paragraph about pears.\n\nThree paragraph about plums, edited by B.\n\nFour, added by B.\n");
    expect(mergeAnchors({ base: { text: base, anchors: [] }, heads, merged }, moveFacts).map((x) => `${x.anchorId} ${x.status} ${x.from}-${x.to} ${x.candidate ? `${x.candidate.from}-${x.candidate.to}` : "-"}`)).toEqual(GOLDEN);
  });
  it("parseAnchorUnit", () => {
    const h = "b".repeat(64);
    expect(parseAnchorUnit(unitText(h, { p2: [0, 0, "maybe", 1, 2, true, "Two", "", "x"], p1: [0, 3, "valid", null, null, false, "One", "", "", "e".repeat(64)] })))
      .toEqual({ ok: true, unit: { hash: h, anchors: [
        { anchorId: "p1", status: "valid", from: 0, to: 3, candidate: null, quote: "One", prefix: "", suffix: "", recoveryPending: false, ownHash: "e".repeat(64) },
        { anchorId: "p2", status: "maybe", from: 0, to: 0, candidate: { from: 1, to: 2 }, quote: "Two", prefix: "", suffix: "x", recoveryPending: true, ownHash: null },
      ] } });
    expect(parseAnchorUnit(unitText(h, { p1: [3, 0, "valid", null, null, false, "", "", ""] }))).toEqual({ ok: false, reason: "position" });
    // round 3, points 3 and 4: one text per unit (the database's own), the two keys and nothing else, a text the database holds, a status its place agrees with, a size
    const ok = unitText(h, { p1: [0, 3, "valid", null, null, false, "One", "", ""] });
    expect(parseAnchorUnit(ok).ok).toBe(true);
    expect(parseAnchorUnit(ok.replace("[0, 3,", "[0, 3.0,"))).toEqual({ ok: false, reason: "not written as the database writes it" });
    expect(parseAnchorUnit(ok.replace("[0, 3,", "[0,3,"))).toEqual({ ok: false, reason: "not written as the database writes it" });
    expect(parseAnchorUnit(JSON.stringify({ h, a: { p1: [0, 3, "valid", null, null, false, "One", "", ""] } }))).toEqual({ ok: false, reason: "not written as the database writes it" });
    expect(parseAnchorUnit(unitText(h, {}))).toEqual({ ok: false, reason: "no anchors" }); // round 4, point 7: a writer removes an empty unit
    expect(parseAnchorUnit(ok.replace(`"h": "${h}"}`, `"h": "${h}", "x": 1}`))).toEqual({ ok: false, reason: "keys" });
    expect(parseAnchorUnit(unitText(h, { p1: [0, 3, "valid", null, null, false, "a\u0000b", "", ""] }))).toEqual({ ok: false, reason: "a text the database cannot hold" });
    expect(parseAnchorUnit(unitText(h, { p1: [0, 3, "valid", 0, 1, false, "One", "", ""] }))).toEqual({ ok: false, reason: "status and position" });
    expect(parseAnchorUnit(unitText(h, { p1: [0, 3, "valid", null, null, true, "One", "", ""] }))).toEqual({ ok: false, reason: "status and position" });
    expect(parseAnchorUnit(unitText(h, { p1: [0, 3, "lost", null, null, false, "One", "", ""] }))).toEqual({ ok: false, reason: "status and position" });
    expect(parseAnchorUnit(unitText(h, { p1: [0, 3, "valid", null, null, false, "One", "", "", h] }))).toEqual({ ok: false, reason: "an anchor's own body hash" });
    expect(parseAnchorUnit(unitText(h, { p1: [0, 3, "valid", null, null, false, "One", ""] }))).toEqual({ ok: false, reason: "an anchor's entry" });
    expect(parseAnchorUnit(unitText(h, { p1: [0, 3, "valid", null, null, false, "One", "", "", h, h] }))).toEqual({ ok: false, reason: "an anchor's entry" });
    expect(parseAnchorUnit(unitText(h, { "bad id!": [0, 3, "valid", null, null, false, "One", "", ""] }))).toEqual({ ok: false, reason: "anchor id" });
    // round 4, point 3: the bound is in bytes of the text (UTF-8), as the database counts them: a unit of exactly the bound is taken, one byte more is not
    const base = unitText(h, { p1: [0, 0, "lost", null, null, false, "", "", ""] }).length;
    const exactly = unitText(h, { p1: [0, 0, "lost", null, null, false, "x".repeat(ANCHOR_UNIT_BYTES_MAX - base), "", ""] });
    expect(new TextEncoder().encode(exactly).length).toBe(ANCHOR_UNIT_BYTES_MAX);
    expect(parseAnchorUnit(exactly).ok).toBe(true);
    expect(parseAnchorUnit(exactly.replace('"x', '"xx'))).toEqual({ ok: false, reason: "larger than a unit may be" });
    // three bytes a character: a third of the bound in characters is already over it
    expect(parseAnchorUnit(unitText(h, { p1: [0, 0, "lost", null, null, false, "語".repeat(Math.ceil(ANCHOR_UNIT_BYTES_MAX / 3)), "", ""] }))).toEqual({ ok: false, reason: "larger than a unit may be" });
    expect(parseAnchorUnit("nope")).toEqual({ ok: false, reason: "not JSON" });
  });

});
// p3: carried from A's text onto the merged one, A's anchor is only `maybe` there (B's words at the paragraph's end make the text differ from A's quote; its candidate is 70-111);
// B's own anchor is `valid` at 70-111. Two different answers, so `maybe`, candidate 70-111.
const GOLDEN: string[] = ["p1 valid 0-40 -", "p2 valid 42-68 -", "p3 maybe 0-0 70-111", "p4 valid 113-130 -"];
