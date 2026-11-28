// A row's `*` sent again by a node that holds it (issue #2019; README of spine/stampedMerge 「筆記以同一個 id 重建時，握有掛在它上面的列的節點把它們再送出」), in the pure
// core: a re-send is a copy of the row's presence BESIDE its heads that covers nothing, ranks below every head that is not a re-send, and that nothing follows. Each rule
// with a control that shows the rule is what decides (the same cell without the `resent` mark). No database.
import { describe, expect, it } from "vitest";
import { type Cell, type Json, type Stamp, type Unit, conflictsOf, isResent, maximalHeads, mergeUnit, rejectReason, writeUnit } from "../spine/stampedMerge/unit.js";
import { mergeRow, type RowState } from "../spine/stampedMerge/rows.js";

const T0 = 1_700_000_000_000;
const st = (origin: string, seq: number, wall = T0 + seq): Stamp => ({ origin, seq, wall, counter: 0, author: null, device: null });
const made = (stamp: Stamp, saw: Record<string, number> = {}): Cell => ({ stamp, saw, deleted: false, value: {} });
const resent = (stamp: Stamp): Cell => ({ stamp, saw: {}, deleted: false, value: {}, meta: { resent: true } });
const tomb = (stamp: Stamp, saw: Record<string, number> = {}): Cell => ({ stamp, saw, deleted: true, value: null });
const names = (u: Unit) => u.map((c) => `${c.stamp.origin}:${c.stamp.seq}${c.deleted ? " deleted" : ""}${isResent(c) ? " resent" : ""}`);

describe("a re-sent `*`", () => {
  // B made the row (B:1); A deleted it after taking B's first re-send (A:5 saw B:1 and B:2); C sent it again later, not having seen A's delete (C:9, the latest clock)
  const creation = made(st("B", 1)), firstResend = resent(st("B", 2)), deleteAfter = tomb(st("A", 5), { B: 2 }), laterResend = resent(st("C", 9));

  it("never shows the row over a delete it had not seen, whatever the order the two meet in", () => {
    for (const [x, y] of [[[deleteAfter], [laterResend]], [[laterResend], [deleteAfter]]] as const) {
      const u = mergeUnit(x as Unit, y as Unit).unit;
      expect(names(u), "the delete is the head shown, the re-send stays beside it").toEqual(["A:5 deleted", "C:9 resent"]);
    }
  });
  it("control: the same cell WITHOUT the mark is a creation, and as the later stamp it shows the row again", () => {
    const plain = made(st("C", 9));
    expect(names(mergeUnit([deleteAfter], [plain]).unit)[0]).toBe("C:9");
  });
  it("ranks below a creation that is not one, even an earlier one, and two re-sends of a creation leave the creation shown", () => {
    expect(names(maximalHeads([creation, firstResend, laterResend]))).toEqual(["B:1", "C:9 resent", "B:2 resent"]);
    // and a delete that saw the creation and the re-sends it held covers them: the re-send it had not seen stays beside it, never shown
    expect(names(maximalHeads([creation, firstResend, deleteAfter, laterResend]))).toEqual(["A:5 deleted", "C:9 resent"]);
  });
  it("covers nothing and is never a tombstone or genesis: refused otherwise (a re-send settles nothing)", () => {
    expect(rejectReason(laterResend), "the re-send as written").toBeNull();
    expect(rejectReason({ ...laterResend, saw: { B: 1 } }), "one that covers a head").toBe("malformed");
    expect(rejectReason({ ...laterResend, deleted: true, value: null }), "one that deletes").toBe("malformed");
    expect(rejectReason({ ...made(st("C", 9), { B: 1 }) }), "control: a creation may cover what it saw").toBeNull();
  });
  // Review of PR #2024, round 2, point 1: beside a later delete the re-send is no other value (it says nothing of its own), so a system or AI write to the row is
  // taken, not refused until a person writes it. Migration 240 sync_stamp_put_over skips it the same way (stampedRowsOnRemadeNote.integration.test.ts).
  it("is no conflict beside a later delete: no other value to see, and a system write to the row is taken", () => {
    const u = mergeUnit([deleteAfter], [laterResend]).unit;
    expect(conflictsOf(u), "nothing for a person to choose").toEqual([]);
    const w = writeUnit(u, st("A", 6), { value: {} }, "system");
    expect(names(w), "the system's write replaced both heads").toEqual(["A:6"]);
    expect(w[0]!.saw, "and says it saw both").toMatchObject({ A: 5, C: 9 });
  });
  // The control is a plain creation at C:4, not C:9 (review of PR #2024, round 3, point 4): unmarked, C:9 has the later clock and would be the head shown over the
  // delete (the second control above), a unit of another shape. C:4 is earlier than A:5 and A:5 had not seen it (saw B:2 only), so the unit has the shape of the
  // test above (the delete shown, one head of C beside it, concurrent) and differs from it only in that head being a creation instead of a re-send.
  it("control: a creation (no mark) beside the delete, the delete still shown, is a conflict, and the system write is refused", () => {
    const u = mergeUnit([deleteAfter], [made(st("C", 4))]).unit;
    expect(names(u), "the delete shown, the creation beside it").toEqual(["A:5 deleted", "C:4"]);
    expect(conflictsOf(u).length).toBe(1);
    expect(writeUnit(u, st("A", 6), { value: {} }, "system"), "the unit comes back unchanged").toBe(u);
  });
});

describe("nothing follows a re-sent `*`", () => {
  // the row as a node holds it: B made it (title "T" follows the creation), B sent it again (B:4); D's write to the title had seen the creation (D:2 saw B:1)
  const state = (star: Cell[], own: Map<string, Unit> = new Map()): RowState => ({ star, own, creation: new Map([["title", "T"]]) });
  const titleWrite = new Map<string, Unit>([["title", [{ stamp: st("D", 2), saw: { B: 1 }, deleted: false, value: "D's" }]]]);

  it("a field without a unit of its own follows the creation, not the re-send: a write that saw the creation is the field's only head", () => {
    const m = mergeRow(state([made(st("B", 1)), resent(st("B", 4))]), state([made(st("B", 1))], titleWrite));
    if ("rejected" in m) throw new Error("refused");
    expect(m.exists).toBe(true);
    expect(m.fields.get("title")!.map((c) => `${c.stamp.origin}:${c.stamp.seq}=${String(c.value as Json)}`), "D's write, no conflict").toEqual(["D:2=D's"]);
  });
  it("control: if the copy were followed (a creation, no mark), the same write would meet a creation value it had not seen: a conflict", () => {
    const m = mergeRow(state([made(st("B", 1)), made(st("B", 4))]), state([made(st("B", 1))], titleWrite));
    if ("rejected" in m) throw new Error("refused");
    expect(m.fields.get("title")!.length, "two heads").toBe(2);
  });
});

// Review of PR #2024, round 1, and the coordinator's point 3: the owner's 甲 reads "make the rows again under the same key" (a creation that covers the heads of `*`).
// Two cases where that cannot be done without losing a value or making a conflict nobody wrote, each against the re-send as it is (beside the heads). Kept for the
// owner's decision (README 「接上傳輸前必須完成」, the first item); they show what the merge core does with each kind of write, nothing is pinned as wrong.
describe("a re-send beside the heads against a re-creation that covers them (the owner decides)", () => {
  // C made the day's note again with a body ("again", a creation value); B, offline, had written the old note's body ("B's words", saw only the old creation O:1).
  // What A holds (it took C's creation, and B's write never reached it while A had no note), and what B sends (its re-send or its re-creation).
  const remade = made(st("C", 9, T0 + 100), { O: 1, A: 5 });
  const bBody = new Map<string, Unit>([["body", [{ stamp: st("B", 3, T0 + 50), saw: { O: 1 }, deleted: false, value: "B's words" }]]]);
  const onA: RowState = { star: [remade], own: new Map(), creation: new Map([["body", "again"], ["title", "The same day again"]]) };
  const shown = (m: ReturnType<typeof mergeRow>, f: string) => { if ("rejected" in m) throw new Error("refused"); return m.fields.get(f)!.map((c) => String(c.value as Json)).sort(); };

  it("(1) B wrote the body offline: covered, C's creation value is gone on every node; beside, both stay as the conflict B holds", () => {
    const cover = mergeRow(onA, { star: [made(st("B", 10, T0 + 100), { C: 9, O: 1, A: 5 })], own: bBody, creation: new Map([["title", "The same day again"]]) });
    expect(shown(cover, "body"), "a re-creation that covers C's creation").toEqual(["B's words"]);
    const beside = mergeRow(onA, { star: [remade, resent(st("B", 10, T0 + 100))], own: bBody, creation: new Map([["title", "The same day again"]]) });
    expect(shown(beside, "body"), "the re-send beside it").toEqual(["B's words", "again"]);
  });

  it("(2) A edited the title after taking C's creation, before B's re-creation came: covered, a title conflict nobody wrote; beside, A's title alone", () => {
    const aTitle: RowState = { ...onA, own: new Map([["title", [{ stamp: st("A", 7, T0 + 200), saw: { C: 9 }, deleted: false, value: "A's title" }]]]) };
    const cover = mergeRow(aTitle, { star: [made(st("B", 10, T0 + 100), { C: 9, O: 1, A: 5 })], own: new Map(), creation: new Map([["title", "The same day again"], ["body", "again"]]) });
    expect(shown(cover, "title"), "A's write had not seen B's re-creation, which the title now follows").toEqual(["A's title", "The same day again"]);
    const beside = mergeRow(aTitle, { star: [remade, resent(st("B", 10, T0 + 100))], own: new Map(), creation: new Map([["title", "The same day again"], ["body", "again"]]) });
    expect(shown(beside, "title")).toEqual(["A's title"]);
  });
});
