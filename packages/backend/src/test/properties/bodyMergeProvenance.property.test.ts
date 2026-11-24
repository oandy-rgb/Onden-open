// Where every line of a merged body comes from: properties of the product's body merge (`mergeBody`, the entry the
// writes, restore and sync call), over two writers' random edits (helpers/bodyMergeWriters.ts).
//
//   1. every merged line is a line of base or of a writer, or one base line with both writers' additions (rule F03);
//      a conflict keeps the incoming text, so this holds for conflicts too: nothing nobody wrote;
//   2. nothing a writer wrote disappears: it is in the merged body or in a conflict's text;
//   3. which writer is "incoming" does not change the outcome: both clean with the same body, or both conflicts;
//   4. no line is held twice.
//
// Each run takes a NEW seed (printed on stderr) unless PROPS_SEED is set, and PROPS_RUNS cases per property
// (default 3000). A red run is a finding: replay it with the printed line, then fix the merge or pin the shrunk
// counterexample as a literal it.fails with an explanation. Do not pin the seed back.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { mergeBody } from "../../services/eventLog/bodyMergeMoves.js";
import type { BodyMerge } from "../../services/eventLog/bodyMerge.js";
import { baseDoc, doubledLines, renderParagraphs, tagsIn, unwrittenLines, write, writerEdits } from "../helpers/bodyMergeWriters.js";

const SEED = process.env.PROPS_SEED ? Number(process.env.PROPS_SEED) | 0 : Math.floor(Math.random() * 2 ** 31);
// PROPS_RUNS is the shared run count (helpers/propsConfig.ts); unset, this file runs 3000, not the shared 200: one seed per run must find rare cases.
const RUNS = Number(process.env.PROPS_RUNS) > 0 ? Number(process.env.PROPS_RUNS) : 3000;
process.stderr.write(`[bodyMergeProvenance] seed=${SEED} runs=${RUNS} (replay: PROPS_SEED=${SEED} PROPS_RUNS=${RUNS})\n`);

const writers = fc.tuple(baseDoc, writerEdits, writerEdits).map(([doc, x, y]) => ({
  base: renderParagraphs(doc), a: renderParagraphs(write(doc, x, "甲")), b: renderParagraphs(write(doc, y, "乙")),
}));

function check(property: (c: { base: string; a: string; b: string }) => void) {
  try {
    fc.assert(fc.property(writers, property), { seed: SEED, numRuns: RUNS });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n\nreplay: PROPS_SEED=${SEED} PROPS_RUNS=${RUNS}`, { cause: error });
  }
}

const offered = (r: BodyMerge) => r.merged + r.conflicts.map((c) => c.incoming + c.current).join("");
/** KNOWN (bodyMergeMoves.test.ts, "known same-line defect"): two writers only adding characters to ONE line can have one
 *  writer's addition cut in two by the other writer's ("乙1" → "乙" + "甲0!" + "1"), every character still there. That is
 *  the same-line rule F03, which the owner chose to keep as it is on 2026-11-22 (option A; decisions-core-sync.md, merge rule 3);
 *  only exactly that is let through: inside one line, the tag's two halves around the other writer's tagged text. */
const cutByOther = (tag: string, text: string) => {
  const other = tag.startsWith("甲") ? "乙" : "甲";
  for (let k = 1; k < tag.length; k++) if (new RegExp(`${tag.slice(0, k)}${other}\\d+[^\\n]*?${tag.slice(k)}`).test(text)) return true;
  return false;
};

describe("mergeBody: every merged line was written by someone", () => {
  it("1. each line of the result is from base or a writer, or one line with both writers' additions", () => {
    check(({ base, a, b }) => {
      for (const [x, y] of [[a, b], [b, a]]) expect(unwrittenLines(base, x!, y!, mergeBody(base, x!, y!).merged)).toEqual([]);
    });
  });

  // FOUND by a fresh seed (520056918, issue #1974's full run; shrunk by fast-check), pinned: B splits base's one line in two and both writers add inside it at
  // the same place; the merge makes a line nobody wrote ("乙0很甲0很ad the p": B's first half of the split line with A's addition inside it). Not a defect of
  // the stamped merge's units; the body merge's own (README of spine/stampedMerge 「接上傳輸前必須完成」).
  it.fails("1, pinned: a writer splits the line both writers add to: no merged line is one nobody wrote", () => {
    const base = "Read the paper. 1\n", a = "Re甲0很ad the paper. 1\n", b = "Re\n乙0很ad the p\naper. 1\n";
    for (const [x, y] of [[a, b], [b, a]]) expect(unwrittenLines(base, x!, y!, mergeBody(base, x!, y!).merged)).toEqual([]);
  });

  it("2. nothing a writer wrote disappears: it is in the body or in a conflict", () => {
    check(({ base, a, b }) => {
      for (const [x, y] of [[a, b], [b, a]]) {
        const kept = offered(mergeBody(base, x!, y!));
        for (const t of [...tagsIn(a, "甲"), ...tagsIn(b, "乙")]) if (!cutByOther(t, kept)) expect(kept, `${t} is gone`).toContain(t);
      }
    });
  });

  it("3. swapping the writers gives the same clean body, or a conflict both ways", () => {
    check(({ base, a, b }) => {
      const ab = mergeBody(base, a, b), ba = mergeBody(base, b, a);
      expect(ba.clean).toBe(ab.clean);
      if (ab.clean) expect(ba.merged).toBe(ab.merged);
    });
  });

  it("4. no line is held twice", () => {
    check(({ base, a, b }) => {
      for (const [x, y] of [[a, b], [b, a]]) expect(doubledLines(base, x!, y!, mergeBody(base, x!, y!).merged)).toEqual([]);
    });
  });
});
