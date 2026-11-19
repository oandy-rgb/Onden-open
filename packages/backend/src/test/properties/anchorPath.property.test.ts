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
import { FIND_BUDGET, moveAnchors, type AnchorState } from "../../services/blockAnchors/mapping.js";
import { anchorOn, csOf, diffStates, recoveryPass, save, walk, type Stored } from "../helpers/anchorPath.js";
import { lineAlign, quoteAt } from "../../services/blockAnchors/similarity.js";
import { check } from "../helpers/propsConfig.js";
import { factsOf } from "../helpers/anchorFacts.js";
import { canonical } from "../../spine/stampedMerge/unit.js";

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

  it("anchor path: edits to different paragraphs in either order end in the same state, span included — a lost anchor has no position (mapping.ts NO_POSITION), so an unrelated edit before or after the loss cannot change it", () => {
    check(fc.property(scenario, (s) => { const { a, b } = twoOrders(s); agree(a, b); }));
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

  // settle ("find again") = the first save, then the background pass until nothing is pending. The per-call budget (FIND_BUDGET) decides only how
  // many passes that takes, so the end state must not depend on it. Paragraphs here may repeat or nearly repeat (a copy with one word changed), because
  // that is where the order of lookups, and so the budget cut, could matter: which anchor claims which block.
  describe("settle does not depend on the per-round budget", () => {
    const UNLIMITED = Number.MAX_SAFE_INTEGER;
    const BUDGETS = [1, FIND_BUDGET, UNLIMITED];
    const jumbled = fc.integer({ min: FIND_BUDGET + 2, max: FIND_BUDGET + 7 }).chain((n) =>
      fc.record({
        paras: fc.array(paragraph, { minLength: n, maxLength: n }),
        order: fc.shuffledSubarray(Array.from({ length: n }, (_, i) => i), { minLength: n, maxLength: n }),
        copies: fc.array(fc.record({ from: fc.nat({ max: n - 1 }), onto: fc.nat({ max: n - 1 }), word: fc.constantFrom(...CHARS) }), { maxLength: 3 }),
        edits: edits(n),
      }));
    const anchorsAt = (d: string, ps: string[][]): Stored[] => {
      let at = 0;
      return ps.map((p, i) => {
        const text = p.join(""), start = d.indexOf(text, at);
        at = start + text.length;
        const span = lineAlign(d, { from: start, to: start + text.length });
        return { anchorId: `a${i}`, span, quote: quoteAt(d, span), status: "valid" as const, candidate: null, recoveryPending: false, atBody: d };
      });
    };
    function endStates(s: { paras: string[][]; order: number[]; copies: Array<{ from: number; onto: number; word: string }>; edits: Edit[] }) {
      const d0 = docOf(s.paras);
      let target = s.order.map((i) => s.paras[i]!);
      for (const c of s.copies) target = target.map((p, i) => (i === c.onto % target.length ? [...target[c.from % target.length]!.slice(0, 3), c.word + "，"] : p));
      for (const e of s.edits) target = apply(target, { ...e, para: e.para % target.length });
      const dT = docOf(target), start = anchorsAt(d0, s.paras);
      return BUDGETS.map((b) => recoveryPass(save(start, d0, dT, null, b), dT, b));
    }
    const settledSame = (s: Parameters<typeof endStates>[0]) => { const [one, five, all] = endStates(s); agree(one!, all!); agree(five!, all!); };
    // Find again is an ordinary stamped write any node may run (owner's answer 6): two nodes that hold the same body and anchors and settle them, one a pass of one lookup at a
    // time, the other FIND_BUDGET at a time, store the same rows, byte for byte (every column a row of block_anchors replicates, the quote and its context included).
    it("anchor path: two nodes settle the same body with different budgets and store the same anchor rows, byte for byte", () => {
      check(fc.property(jumbled, (s) => {
        const [one, five] = endStates(s);
        expect(canonical(factsOf(five!))).toBe(canonical(factsOf(one!)));
      }), 100);
    });

    // Every paragraph survives and no two look alike: each lookup ends `valid`, so nothing can be starved.
    it("anchor path: paragraphs only reordered (all distinct, all kept) settle to the same states with a budget of 1, FIND_BUDGET or no limit", () => {
      check(fc.property(jumbled.map((s) => ({ ...s, copies: [], edits: [] })).filter((s) => distinct(s.paras)), settledSame), 100);
    });

    // Paragraphs that read alike, or rewritten ones, end `maybe`/`lost`. Such an anchor used to be looked up again by every pass and spend the budget before the anchors behind it
    // got a turn (a smaller budget then left an anchor pending where a larger one settled it). An anchor is now looked up once per body, so this holds.
    it("anchor path: a jumbled note with repeated and rewritten paragraphs settles to the same states whatever the budget", () => {
      check(fc.property(jumbled, settledSame), 100);
    });

    // A `maybe` anchor used to keep the span it last had as a valid one, which depends on the saves in between (the same reason a lost one did).
    // Same start, same final text, one save vs two: where both paths end `maybe`, the span is the same (NO_POSITION; the guess is in `candidate`).
    const maybeOnBothPaths = (s: Parameters<typeof endStates>[0]) => {
      const d0 = docOf(s.paras), start = anchorsAt(d0, s.paras);
      let mid = s.order.map((i) => s.paras[i]!);
      for (const c of s.copies) mid = mid.map((p, i) => (i === c.onto % mid.length ? [...mid[c.from % mid.length]!.slice(0, 3), c.word + "，"] : p));
      let target = mid;
      for (const e of s.edits) target = apply(target, { ...e, para: e.para % target.length });
      const twoSaves = save(save(start, d0, docOf(mid)), docOf(mid), docOf(target)), oneSave = save(start, d0, docOf(target));
      return twoSaves.flatMap((a) => { const b = oneSave.find((x) => x.anchorId === a.anchorId)!; return a.status === "maybe" && b.status === "maybe" ? [[a, b] as const] : []; });
    };
    it("anchor path: an anchor that ends maybe by one save and by two saves holds the same span", () => {
      let compared = 0;
      check(fc.property(jumbled, (s) => { for (const [a, b] of maybeOnBothPaths(s)) { compared++; expect(a.span).toEqual(b.span); } }), 100);
      expect(compared, "the property saw no anchor that is maybe on both paths").toBeGreaterThan(0);
    });
    // The guess itself still differs by path: the intermediate save refreshes the quote, the one save looks for the older one (same cause as (a): KEEP_MOVED / quote refresh).
    // Steps 2-3 (migration 215) do not flip it, and by design: the quote and the position are part of the note's anchors unit (note_anchor_places) written by the writer, so every NODE holds the same guess
    // (anchorsReplicated.integration.test.ts), but two WRITERS that save the same edit in one save and in two still write different guesses. Design A keeps the writer's path
    // because it is the precision of today (proposal §3.5); making the guess independent of the writer's saves is design B (place is a function of the text), not chosen.
    it.fails("anchor path: an anchor that ends maybe by one save and by two saves holds the same candidate — the intermediate save refreshes the quote the guess is made from", () => {
      check(fc.property(jumbled, (s) => { for (const [a, b] of maybeOnBothPaths(s)) expect(a.candidate).toEqual(b.candidate); }), 100);
    });

    it("anchor path: however many anchors end maybe or lost, settle ends within as many passes as there are anchors, and one more pass changes nothing", () => {
      check(fc.property(jumbled, (s) => {
        for (const settled of endStates(s)) {
          expect(settled.filter((a) => a.recoveryPending)).toEqual([]);
          const body = settled[0]!.atBody;
          const again = moveAnchors(settled as AnchorState[], { before: null, after: body, trusted: () => false, settled: (id) => settled.find((a) => a.anchorId === id)!.atBody === body });
          expect(again.filter((m) => m.changed)).toEqual([]);
        }
      }), 100);
    });
  });
});
