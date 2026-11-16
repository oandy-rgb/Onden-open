// Property test: anchor state vs the path the text took (see ../anchorPath.test.ts for the fixed minimal cases and the
// reasoning; proposal docs/architecture/proposals/anchors-deterministic-2026-11-16.md). DB-free, pure mapping.ts.
//
// Documents are paragraphs of four sentences, every sentence made of random characters (so paragraphs never look alike
// and no lookup is ever ambiguous: a difference below comes from the PATH, not from look-alike text).
// An edit rewrites one sentence. `it.fails` = a counterexample exists today (the rule that causes it is on the line);
// plain `it` = no counterexample in PROPS_RUNS runs. Run count and seed: helpers/propsConfig.ts.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { dice } from "../../services/blockAnchors/similarity.js";
import { FIND_BUDGET } from "../../services/blockAnchors/mapping.js";
import { anchorOn, csOf, diffStates, recoveryPass, save, walk, withoutLostSpan, type Stored } from "../helpers/anchorPath.js";
import { check } from "../helpers/propsConfig.js";

const CHARS = Array.from("甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地玄黃宇宙洪荒日月盈昃辰宿列張寒來暑往秋收冬藏閏餘成歲");
// Sentence 0 is long (30–40 characters), 1–3 short (4–8): rewriting sentence 0 alone already drops a paragraph below
// the "still the same block" bar (KEEP_MOVED 0.5), rewriting a short one does not — which is what makes the order matter.
const sentenceAt = (j: number) => fc.array(fc.constantFrom(...CHARS), j === 0 ? { minLength: 30, maxLength: 40 } : { minLength: 4, maxLength: 8 }).map((cs) => cs.join("") + "，");
const paragraph = fc.tuple(sentenceAt(0), sentenceAt(1), sentenceAt(2), sentenceAt(3)).map((t): string[] => t);
const docOf = (ps: string[][]) => ps.map((p) => p.join("")).join("\n\n");

type Edit = { para: number; sentence: number; text: string };
const edits = (paras: number) => fc.array(
  fc.nat({ max: 3 }).chain((j) => fc.record({ para: fc.nat({ max: paras - 1 }), sentence: fc.constant(j), text: sentenceAt(j) })), { minLength: 2, maxLength: 8 },
);
const apply = (ps: string[][], e: Edit): string[][] => ps.map((p, i) => (i === e.para ? p.map((s, j) => (j === e.sentence ? e.text : s)) : p));

// No two paragraphs may look alike (the shrinker would otherwise collapse them into copies of one text, and which copy an
// anchor lands on is a different question: findQuote's tie-break).
const distinct = (ps: string[][]) => ps.every((p, i) => ps.slice(i + 1).every((q) => dice(p.join(""), q.join("")) < 0.3));
const scenario = fc.integer({ min: 3, max: 8 }).chain((n) => fc.record({ paras: fc.array(paragraph, { minLength: n, maxLength: n }).filter(distinct), edits: edits(n) }));

/** versions[0] = start, then one body per edit; anchors on every paragraph of the start. */
function pathOf(s: { paras: string[][]; edits: Edit[] }) {
  const versions = [docOf(s.paras)];
  let cur = s.paras;
  for (const e of s.edits) { cur = apply(cur, e); versions.push(docOf(cur)); }
  const start = cur === s.paras ? [] : s.paras.map((_, i) => anchorOn(versions[0]!, s.paras[i]!.join(""), `a${i}`));
  return { versions, start };
}
const agree = (a: Stored[], b: Stored[]) => { expect(diffStates(a, b)).toEqual([]); expect(a).toEqual(b); };

describe("anchor path: properties", () => {
  it.fails("anchor path: N saves (one edit each) vs the same N edits in one save — mapping.ts KEEP_MOVED against the quote refreshed by each save", () => {
    check(fc.property(scenario, (s) => {
      const { versions, start } = pathOf(s);
      agree(walk(start, versions), walk(start, [versions[0]!, versions.at(-1)!]));
    }));
  });

  it.fails("anchor path: the same edits split into two saves at any point vs one save — same rule", () => {
    check(fc.property(scenario, fc.nat(), (s, k) => {
      const { versions, start } = pathOf(s);
      const cut = 1 + (k % (versions.length - 1));
      agree(walk(start, [versions[0]!, versions[cut]!, versions.at(-1)!]), walk(start, [versions[0]!, versions.at(-1)!]));
    }));
  });

  it.fails("anchor path: edits to different sentences of one paragraph, applied in two different orders — each save compares with the quote the previous save refreshed", () => {
    const sentences = fc.shuffledSubarray([0, 1, 2, 3], { minLength: 2, maxLength: 4 });
    check(fc.property(scenario, sentences, paragraph, fc.nat(), (s, picked, texts, k) => {
      const para = k % s.paras.length;
      const make = (order: number[]) => pathOf({ paras: s.paras, edits: order.map((j) => ({ para, sentence: j, text: texts[j]! })) });
      const first = make(picked), second = make([...picked].reverse());
      fc.pre(first.versions.at(-1) === second.versions.at(-1)); // distinct sentences: always the same final text
      agree(walk(first.start, first.versions), walk(second.start, second.versions));
    }));
  });

  const spreadEdits = (s: { edits: Edit[] }) => { const used = new Set<number>(); return s.edits.filter((e) => (used.has(e.para) ? false : (used.add(e.para), true))); };
  const twoOrders = (s: { paras: string[][]; edits: Edit[] }) => {
    const spread = spreadEdits(s);
    fc.pre(spread.length >= 2);
    const first = pathOf({ ...s, edits: spread }), second = pathOf({ ...s, edits: [...spread].reverse() });
    return { start: first.start, a: walk(first.start, first.versions), b: walk(second.start, second.versions) };
  };

  it.fails("anchor path: edits to different paragraphs in either order — a LOST anchor keeps the span it had when it was lost (mapping.ts lookup branch copies `...a`), so an unrelated edit before or after the loss changes it", () => {
    check(fc.property(scenario, (s) => { const { a, b } = twoOrders(s); agree(a, b); }));
  });

  it("anchor path: edits to different paragraphs in either order end in the same status, candidate, quote and pending flag (the span of a lost anchor aside)", () => {
    check(fc.property(scenario, (s) => { const { a, b } = twoOrders(s); expect(withoutLostSpan(a)).toEqual(withoutLostSpan(b)); }));
  });

  it("anchor path: the editor's ChangeSet vs the derived diff for ONE sentence rewritten (random text) end in the same state", () => {
    check(fc.property(scenario, (s) => {
      const e = s.edits[0]!;
      const d0 = docOf(s.paras), d1 = docOf(apply(s.paras, e));
      const start = s.paras.map((p, i) => anchorOn(d0, p.join(""), `a${i}`));
      const from = d0.indexOf(s.paras[e.para]!.join("")) + s.paras[e.para]!.slice(0, e.sentence).join("").length;
      const old = s.paras[e.para]![e.sentence]!;
      agree(save(start, d0, d1, csOf(d0, { from, to: from + old.length, insert: e.text })), save(start, d0, d1));
    }));
  });

  it("anchor path: reversing more than FIND_BUDGET paragraphs in one save, then the recovery pass, ends where moving them one step at a time ends", () => {
    check(fc.property(fc.array(paragraph, { minLength: FIND_BUDGET + 2, maxLength: FIND_BUDGET + 4 }).filter(distinct), (paras) => {
      const d0 = docOf(paras), start = paras.map((p, i) => anchorOn(d0, p.join(""), `a${i}`));
      const target = docOf([...paras].reverse());
      let cur = [...paras], anchors = start, prev = d0;
      for (let i = 0; i < cur.length; i++) for (let j = 0; j < cur.length - 1 - i; j++) {
        const n = [...cur]; [n[j], n[j + 1]] = [n[j + 1]!, n[j]!];
        anchors = save(anchors, prev, docOf(n)); prev = docOf(n); cur = n;
      }
      agree(recoveryPass(save(start, d0, target), target), anchors);
    }), 100);
  });
});
