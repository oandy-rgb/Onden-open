// services/linkIndexLookup.ts: the link index rows a batched relinkTarget read once, looked up per batch of targets (review of PR #1941, round 3).
// 1. The rule is indexRowsNaming's `&&` (a row names a target when a link key equals one of the target's keys, or a link slug equals its slug),
//    compared with that rule written out directly over random rows and targets.
// 2. The work is in proportion to rows plus targets: counted as reads of the rows' key arrays, not as time. Comparing every row with every batch read
//    each row once per batch (a change bundle of 20,000 notes: 400 batches × 20,000 rows).
import { describe, expect, it } from "vitest";
import { linkIndexLookup, type LinkIndexRow } from "../services/linkIndexLookup.js";
import fc from "fast-check";
import { check } from "./helpers/propsConfig.js";

const BATCH = 50; // services/wikilinkEdges.ts RELINK_BATCH

/** The keys a target is named by (linkIndexLookup's argument). */
type NamedTarget = Parameters<ReturnType<typeof linkIndexLookup>["notesNaming"]>[0][number];

/** The `&&` rule, written out. */
const names = (row: LinkIndexRow, t: NamedTarget) => row.link_lc.some((k) => t.lc.includes(k)) || row.link_slug.includes(t.slug);

describe("linkIndexLookup", () => {
  it("names the notes the && rule names, each once (random rows and targets)", () => {
    const key = fc.constantFrom("a", "b", "c", "café", "cafe\u0301", "onden://node/x", "", "β");
    const keys = fc.array(key, { maxLength: 3 });
    check(fc.property(
      fc.array(fc.record({ link_lc: keys, link_slug: keys }), { maxLength: 12 }),
      fc.array(fc.record({ lc: keys, slug: key }), { maxLength: 5 }),
      (raw, targets) => {
        const rows: LinkIndexRow[] = raw.map((r, i) => ({ note_id: `n${i}`, ...r }));
        const want = rows.filter((row) => targets.some((t) => names(row, t))).map((row) => row.note_id);
        expect(linkIndexLookup(rows).notesNaming(targets).sort()).toEqual(want.sort());
      },
    ));
  });

  it("four times the rows and targets, looked up a batch at a time, read the rows' keys at most 4.6 times as often", () => {
    /** `n` rows each naming its own target (by key, or by slug for every third), looked up in batches of BATCH; how many times a row's keys were read. */
    const reads = (n: number) => {
      let count = 0;
      const rows: LinkIndexRow[] = Array.from({ length: n }, (_, i) => {
        const lc = i % 3 === 0 ? [] : [`k${i}`];
        const slug = i % 3 === 0 ? [`s${i}`] : [];
        return { note_id: `n${i}`, get link_lc() { count++; return lc; }, get link_slug() { count++; return slug; } };
      });
      const targets: NamedTarget[] = Array.from({ length: n }, (_, i) => ({ lc: [`k${i}`, `other${i}`], slug: `s${i}` }));
      const lookup = linkIndexLookup(rows);
      let found = 0;
      for (let i = 0; i < n; i += BATCH) found += lookup.notesNaming(targets.slice(i, i + BATCH)).length;
      expect(found).toBe(n);
      return count;
    };
    const small = reads(1000);
    const large = reads(4000);
    expect(large / small, `row key reads: ${small} for 1,000, ${large} for 4,000`).toBeLessThanOrEqual(4.6);
  });
});
