// Moved paragraphs in the body merge (services/eventLog/bodyMergeMoves.ts, mergeBody): a paragraph or list
// item moved by one writer follows the other writer's edit of it; two writers moving the same one to different
// places is a conflict that drops nothing. Two writers changing the same sentence is still a conflict.
import { describe, expect, it } from "vitest";
import { threeWayMergeBody } from "../services/eventLog/bodyMerge.js";
import { mergeBody } from "../services/eventLog/bodyMergeMoves.js";
import { mergeLossProblems } from "../services/eventLog/bodyMergeLoss.js";
import { BODY_MERGE_RULE_VERSION } from "../distributedSync/types.js";

const P = {
  a: "甲段的第一句。甲段的第二句。",
  b: "乙段的第一句。乙段的第二句。",
  c: "丙段的第一句。丙段的第二句。",
  d: "丁段的第一句。丁段的第二句。",
};
const doc = (...paras: string[]) => paras.join("\n\n") + "\n";
const base = doc(P.a, P.b, P.c, P.d);

describe("mergeBody: a moved paragraph and an edit of it", () => {
  it("lands both when one writer moves a paragraph and the other edits it", () => {
    const moved = doc(P.a, P.c, P.d, P.b);
    const edited = doc(P.a, P.b.replace("第一句", "第一句（改）"), P.c, P.d);
    const expected = doc(P.a, P.c, P.d, P.b.replace("第一句", "第一句（改）"));
    for (const [incoming, current] of [[moved, edited], [edited, moved]] as const) {
      const r = mergeBody(base, incoming, current);
      expect(r).toEqual({ merged: expected, clean: true, conflicts: [] });
    }
  });

  it("lands both when a list item is moved and the other writer edits that item", () => {
    const list = (...items: string[]) => items.map((i) => `- ${i}`).join("\n") + "\n";
    const b = list("寄包裹", "買牛奶", "繳電費", "洗衣服");
    const moved = list("繳電費", "寄包裹", "買牛奶", "洗衣服");
    const edited = list("寄包裹", "買牛奶", "繳電費（要帶身分證）", "洗衣服");
    const expected = list("繳電費（要帶身分證）", "寄包裹", "買牛奶", "洗衣服");
    expect(mergeBody(b, moved, edited)).toEqual({ merged: expected, clean: true, conflicts: [] });
    expect(mergeBody(b, edited, moved)).toEqual({ merged: expected, clean: true, conflicts: [] });
  });

  it("keeps a paragraph the other writer inserted elsewhere while one is moved and edited by the two writers", () => {
    const moved = doc(P.d, P.a, P.b, P.c);
    const edited = doc(P.a, P.b, P.c.replace("第二句", "第二句（改）"), P.d);
    const r = mergeBody(base, moved, edited);
    expect(r.clean).toBe(true);
    expect(r.merged).toBe(doc(P.d, P.a, P.b, P.c.replace("第二句", "第二句（改）")));
  });

  it("is still a conflict when both writers change the same sentence, whatever else moved", () => {
    const incoming = doc(P.a, P.b.replace("乙段的第一句", "我改成這句"), P.d, P.c);
    const current = doc(P.a, P.b.replace("乙段的第一句", "他改成那句"), P.c, P.d);
    const r = mergeBody(base, incoming, current);
    expect(r.clean).toBe(false);
    expect(r.merged).toContain("我改成這句");
    expect(r.conflicts.some((c) => c.current.includes("他改成那句"))).toBe(true);
  });

  it("leaves a conflict alone when no moved paragraph explains it: two rewrites of one short paragraph are not both kept", () => {
    // Nothing moved. The units cannot tell "Q1" and "Q2" are rewrites of "B" (too short to compare), and merging them as
    // two added paragraphs would keep both rewrites where the writers disagree.
    const b = "A\n\nB\n\nC\n";
    const incoming = "A2\n\nQ2\n\nC\n", current = "A\n\nQ1\n\nC1\n";
    expect(mergeBody(b, incoming, current)).toEqual(threeWayMergeBody(b, incoming, current));
    expect(mergeBody(b, incoming, current).clean).toBe(false);
  });

  it("gives the line merge's own result when it was already clean or the units cannot help", () => {
    const incoming = doc(P.a, P.b.replace("第一句", "第一句（改）"), P.c, P.d);
    const current = doc(P.a, P.b, P.c, P.d + "\n\n戊段。");
    expect(mergeBody(base, incoming, current)).toEqual(threeWayMergeBody(base, incoming, current));
  });
});

describe("mergeBody: two writers move the same paragraph to different places", () => {
  const first = doc(P.b, P.a, P.c, P.d); // b to the top
  const second = doc(P.a, P.c, P.d, P.b); // b to the end

  it("is a conflict, which the line merge calls clean", () => {
    // The line merge keeps one writer's move (or holds the paragraph twice) and says nothing.
    expect(threeWayMergeBody(base, first, second).clean).toBe(true);
    const r = mergeBody(base, first, second);
    expect(r.clean).toBe(false);
    expect(r.conflicts).toHaveLength(1);
  });

  it("keeps the incoming writer's text in the body and offers the other writer's whole text back, dropping nothing", () => {
    const r = mergeBody(base, first, second);
    expect(r.merged).toBe(first);
    expect(r.conflicts[0]).toEqual({ base, incoming: first, current: second, before: "", after: "" });
    const swapped = mergeBody(base, second, first);
    expect(swapped.merged).toBe(second);
    expect(swapped.conflicts[0]!.current).toBe(first);
  });

  it("is a conflict for list items too", () => {
    const list = (...items: string[]) => items.map((i) => `- ${i}`).join("\n") + "\n";
    const b = list("一", "二", "三", "四");
    expect(mergeBody(b, list("三", "一", "二", "四"), list("一", "二", "四", "三")).clean).toBe(false);
  });

  it("is not a conflict when they move different paragraphs, or the same one to the same place", () => {
    expect(mergeBody(base, doc(P.b, P.a, P.c, P.d), doc(P.a, P.b, P.d, P.c)).clean).toBe(true);
    expect(mergeBody(base, first, doc(P.b, P.a, P.c, P.d + "（改）")).clean).toBe(true);
  });
});

describe("mergeLossProblems: the line count that guards a rescued merge", () => {
  const b = "甲\n乙\n丙\n";
  it("passes a merge that holds every line once", () => {
    expect(mergeLossProblems(b, "乙\n甲\n丙\n", "甲\n乙\n丙\n丁\n", "乙\n甲\n丙\n丁\n")).toEqual([]);
  });
  it("flags a line that is held twice", () => {
    expect(mergeLossProblems(b, "乙\n甲\n丙\n", "甲\n乙\n丙\n", "乙\n甲\n乙\n丙\n").map((p) => p.kind)).toContain("doubled");
  });
  it("flags a line a writer newly wrote that is gone", () => {
    expect(mergeLossProblems(b, "甲\n乙\n丙\n新寫的一整行內容在這裡\n", "甲\n乙\n丙\n", "甲\n乙\n丙\n").map((p) => p.kind)).toContain("dropped");
  });
  it("flags a line both writers kept that is gone", () => {
    expect(mergeLossProblems(b, "甲\n乙\n丙\n", "甲\n乙\n丙\n", "甲\n丙\n").map((p) => p.kind)).toContain("left-out");
  });
  it("flags a line nobody wrote", () => {
    expect(mergeLossProblems(b, "甲\n乙\n丙\n丁\n", "甲\n乙\n丙\n", "甲\n乙\n丙\n丁\n沒有人寫過的一行\n").map((p) => p.kind)).toContain("invented");
  });
});

describe("merge rule version", () => {
  it("is 2: the line merge was version 1, mergeBody's moved-paragraph handling is the change", () => {
    expect(BODY_MERGE_RULE_VERSION).toBe(2);
  });
});

describe("known line-merge defect (not fixed here)", () => {
  // threeWayMergeBody, character level: one writer edits a paragraph's last line, the other edits it too and adds a paragraph
  // after it. The shared "。" ending lets the character merge splice the first writer's edit into the NEW paragraph, text
  // neither wrote ("新增（我）。"). About 60 in 20000 random merges. mergeBody keeps the line merge's result. Pinned with
  // it.fails so it is tracked: when the line merge is fixed this starts passing and `it.fails` must become `it`.
  it.fails("does not splice one writer's edit into a paragraph the other writer added after it", () => {
    const r = mergeBody("段落。\n", "段落（我）。\n", "段落（他）。\n\n新增。\n");
    expect(r.merged).not.toContain("新增（我）");
  });
});
