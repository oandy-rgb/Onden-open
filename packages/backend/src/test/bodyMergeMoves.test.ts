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
const base4 = base;

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
  it("is 3: the line merge was 1, mergeBody's moved paragraphs 2, line-by-line characters and no doubled lines 3", () => {
    expect(BODY_MERGE_RULE_VERSION).toBe(3);
  });
});

// Rule 3 (2026-11-19). Each line of a merged body is a line of base or of a writer, or one base line with both writers'
// additions; no line is held twice. Random check: properties/bodyMergeProvenance.property.test.ts.
describe("mergeBody rule 3: an edit lands on the line it was made on", () => {
  // Base "段落。". One writer edits it; the other edits it too and adds a paragraph after it. Rules 1–2 diffed the region
  // as one string of characters: the "。" of "段落。" matched the "。" of the new paragraph "新增。", and the first
  // writer's "（我）" landed inside it, "新增（我）。", a line neither wrote. The lines are now paired first.
  const base = "段落。\n", mine = "段落（我）。\n", theirs = "段落（他）。\n\n新增。\n";

  it("keeps the other writer's new paragraph as written, in either order", () => {
    const expected = { merged: "段落（他）（我）。\n\n新增。\n", clean: true, conflicts: [] };
    expect(mergeBody(base, mine, theirs)).toEqual(expected);
    expect(mergeBody(base, theirs, mine)).toEqual(expected);
  });

  it("rule 2 still gives what it gave, so a merge made under it can be computed again", () => {
    expect(mergeBody(base, mine, theirs, 2)).toEqual({ merged: "段落（他）。\n\n新增（我）。\n", clean: true, conflicts: [] });
    expect(mergeBody(base, mine, theirs, 1)).toEqual(threeWayMergeBody(base, mine, theirs));
  });

  it("merges a line one writer split (Enter typed inside it) with the other writer's edit of it, in either order", () => {
    const expected = { merged: "一二\n三四（改）。\n", clean: true, conflicts: [] };
    expect(mergeBody("一二三四。\n", "一二\n三四。\n", "一二三四（改）。\n")).toEqual(expected);
    expect(mergeBody("一二三四。\n", "一二三四（改）。\n", "一二\n三四。\n")).toEqual(expected);
  });

  it("is a conflict when the only piece of the split line left on a line is punctuation: that line may be a new one", () => {
    // Found by the random property (bodyMergeProvenance 1, seed 1511853495). 乙 split "記得買牛奶1。" before "。" and wrote
    // a new line ending in "。"; rule 2 put 甲's "甲0很" into 乙's new line.
    const b = "記得買牛奶1。\n", x = "甲1寫的新段落。\n\n記得買牛奶1甲0很。\n", y = "記得買牛奶1\n乙0改寫的一行。\n";
    expect(mergeBody(b, x, y, 2).merged).toContain("乙0改寫的一行甲0很。");
    expect(mergeBody(b, x, y).clean).toBe(false);
    expect(mergeBody(b, y, x).clean).toBe(false);
  });

  it("is a conflict when a split line can be read two ways that put the other writer's addition on different lines", () => {
    // Found by the random property (seed 825746270): 乙 split "記得買牛奶|1。" and put a new line between the halves, which
    // also holds "1" and "。". Is 甲's "甲0很" before the "。" of the new line or of the last one?
    const b = "記得買牛奶1。\n", x = "記得\n買牛奶1甲0很。\n", y = "乙0加的一行。\n記得買牛奶\n乙1加的一行。\n1。\n";
    expect(mergeBody(b, x, y).clean).toBe(false);
    expect(mergeBody(b, y, x).clean).toBe(false);
  });

  it("leaves the common cases clean: two writers editing different paragraphs, or each adding one at the same point", () => {
    const different = mergeBody(base4, doc(P.a.replace("第一句", "第一句（甲）"), P.b, P.c, P.d), doc(P.a, P.b, P.c.replace("第二句", "第二句（乙）"), P.d));
    expect(different).toEqual({ merged: doc(P.a.replace("第一句", "第一句（甲）"), P.b, P.c.replace("第二句", "第二句（乙）"), P.d), clean: true, conflicts: [] });
    const samePoint = mergeBody(base4, doc(P.a, P.b, "甲寫的一段。", P.c, P.d), doc(P.a, P.b, "乙寫的一段。", P.c, P.d));
    expect(samePoint).toEqual({ merged: doc(P.a, P.b, "乙寫的一段。", "甲寫的一段。", P.c, P.d), clean: true, conflicts: [] });
    // Typing into one line both writers edited keeps both additions (rule F03, unchanged).
    expect(mergeBody("一行\n", "一行A\n", "一行B\n")).toEqual({ merged: "一行AB\n", clean: true, conflicts: [] });
  });
});

describe("mergeBody rule 3: lines moved by one writer while the other edited their old place are not held twice", () => {
  // The case properties/bodyMerge.property.test.ts 4b pins for the line merge. Under rule 2 mergeBody gave the line
  // merge's conflict, and its body held "moved" and "two" twice: the incoming writer's text at the old place, the
  // current writer's move at the new one.
  const base = "one\nmoved\ntwo\nthree\nfour\nfive\n";
  const ours = "one\nmoved\nours added\ntwo\nthree\nfour\nfive\n";
  const theirs = "one\nthree\nfour\nfive\nmoved\ntwo\n";
  const count = (text: string, line: string) => text.split("\n").filter((l) => l === line).length;

  it("rule 2 held them twice", () => {
    expect(count(mergeBody(base, ours, theirs, 2).merged, "moved")).toBe(2);
  });

  it("one paragraph (no unit to follow): the whole text is the conflict, nothing held twice, nothing dropped", () => {
    expect(mergeBody(base, ours, theirs)).toEqual({ merged: ours, clean: false, conflicts: [{ base, incoming: ours, current: theirs, before: "", after: "" }] });
    const swapped = mergeBody(base, theirs, ours);
    expect(swapped.clean).toBe(false);
    expect(count(swapped.merged, "moved")).toBe(1);
  });

  it("separate paragraphs: the inserted paragraph follows the moved ones, clean, in either order", () => {
    const b = "one\n\nmoved\n\ntwo\n\nthree\n\nfour\n";
    const o = "one\n\nmoved\n\nours added\n\ntwo\n\nthree\n\nfour\n";
    const t = "one\n\nthree\n\nfour\n\nmoved\n\ntwo\n";
    const expected = { merged: "one\n\nthree\n\nfour\n\nmoved\n\nours added\n\ntwo\n", clean: true, conflicts: [] };
    expect(mergeBody(b, o, t)).toEqual(expected);
    expect(mergeBody(b, t, o)).toEqual(expected);
  });

  it("both writers move one paragraph to the same place and one edits it: held once (rule 2 held it twice, clean)", () => {
    // Found by the random property (bodyMergeProvenance 4).
    const [l1, l2, l3, l4] = ["今天開會討論進度1。", "今天開會討論進度2。", "今天開會討論進度3。", "今天開會討論進度4。"];
    const b = `${l1}\n\n${l2}\n${l3}\n${l4}\n`;
    const x = `${l2}\n甲很${l3}\n${l4}\n\n${l1}\n`, y = `${l2}\n${l3}\n乙很${l4}\n\n${l1}\n`;
    expect(count(mergeBody(b, x, y, 2).merged, l1)).toBe(2);
    for (const [i, c] of [[x, y], [y, x]]) {
      expect(mergeBody(b, i!, c!)).toEqual({ merged: `${l2}\n甲很${l3}\n乙很${l4}\n\n${l1}\n`, clean: true, conflicts: [] });
    }
    // Too short for the units to recognise the edited paragraph: the whole text is the conflict, still held once.
    const r = mergeBody("今天1。\n\n今天2。\n今天3。\n今天4。\n", "今天2。\n甲很今天3。\n今天4。\n\n今天1。\n", "今天2。\n今天3。\n乙很今天4。\n\n今天1。\n");
    expect(r.clean).toBe(false);
    expect(count(r.merged, "今天1。")).toBe(1);
  });
});

describe("known same-line defect (kept: owner 2026-11-22, option A)", () => {
  // Inside ONE line both writers only added characters (rule F03: both kept). The character diff may read "乙0，然後1。乙1。"
  // as "乙0，然後1。乙" added before "1。", the same point as the other writer's "甲0!", so "乙1" is cut in two: every
  // character is still there, but "乙1" is not. Found by bodyMergeProvenance property 2 (1 in 20000 random merges). Whether
  // two additions at an ambiguous point of one line should be a conflict is the same-line question in
  // docs/architecture/proposals/body-merge-same-line-2026-11-13.md: the owner decided 2026-11-22 to keep both additions
  // (option A), so this stays as it is (decisions-core-sync.md, merge rule 3). Pinned so a change to it is seen: if it
  // ever passes, `it.fails` must become `it`.
  it.fails("does not cut one writer's addition in two with the other writer's", () => {
    const b = "下週要交報告1。\n";
    const r = mergeBody(b, "下週要交報告甲0!1。\n", "下週要交報告乙0，然後1。乙1。\n");
    expect(r.merged).toContain("乙1");
  });
});
