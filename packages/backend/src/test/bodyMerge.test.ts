import { describe, expect, it } from "vitest";
import { threeWayMergeBody } from "../services/eventLog/bodyMerge.js";

// The line-based body merge (services/eventLog/bodyMerge.ts). The previous
// character-based fuzzy merge reported cases 2 and 3 as clean and dropped the
// other writer's word.
describe("three-way body merge", () => {
  it("edits on different lines both land", () => {
    expect(threeWayMergeBody("A\nB\nC\n", "A1\nB\nC\n", "A\nB\nC2\n"))
      .toEqual({ merged: "A1\nB\nC2\n", clean: true, conflicts: [] });
  });

  it("both writers changing the same word is a conflict, and the incoming text stays", () => {
    const r = threeWayMergeBody("清單\n買牛奶\n結束\n", "清單\n買豆漿\n結束\n", "清單\n買咖啡\n結束\n");
    expect(r.clean).toBe(false);
    expect(r.merged).toBe("清單\n買豆漿\n結束\n");
    expect(r.conflicts).toEqual([{
      base: "買牛奶\n", incoming: "買豆漿\n", current: "買咖啡\n", before: "清單\n", after: "結束\n",
    }]);
  });

  it("two different changes to one sentence conflict", () => {
    const r = threeWayMergeBody("會議在星期一下午三點", "會議在星期二下午三點", "會議在星期三下午三點");
    expect(r.clean).toBe(false);
    expect(r.merged).toBe("會議在星期二下午三點");
    expect(r.conflicts[0]).toMatchObject({ incoming: "會議在星期二下午三點", current: "會議在星期三下午三點", before: "", after: "" });
  });

  it("a line inserted above an edited line is not a conflict", () => {
    const r = threeWayMergeBody("- [ ] 任務\n- [ ] 任務\n", "- [x] 任務\n- [ ] 任務\n", "- [ ] 新的\n- [ ] 任務\n- [ ] 任務\n");
    expect(r).toEqual({ merged: "- [ ] 新的\n- [x] 任務\n- [ ] 任務\n", clean: true, conflicts: [] });
  });

  it("an edit to a line the other writer deleted is a conflict that keeps the edit", () => {
    const r = threeWayMergeBody("第一段\n要刪的句子\n第三段\n", "第一段\n要刪的句子，補充\n第三段\n", "第一段\n第三段\n");
    expect(r.clean).toBe(false);
    expect(r.merged).toBe("第一段\n要刪的句子，補充\n第三段\n");
    expect(r.conflicts[0]).toMatchObject({ incoming: "要刪的句子，補充\n", current: "" });
  });

  it("the same change on both sides lands once", () => {
    expect(threeWayMergeBody("A\nB\n", "A\nX\n", "A\nX\n")).toEqual({ merged: "A\nX\n", clean: true, conflicts: [] });
    expect(threeWayMergeBody("A\nB\nC\nD\nE\n", "A\nX\nC\nD\nE2\n", "A\nX\nC\nD1\nE\n"))
      .toEqual({ merged: "A\nX\nC\nD1\nE2\n", clean: true, conflicts: [] });
  });

  it("changes to adjacent lines that join into one changed run conflict, as in git", () => {
    expect(threeWayMergeBody("A\nB\nC\n", "A\nX\nC2\n", "A1\nX\nC\n").clean).toBe(false);
  });

  it("two different insertions at the same point both land, in a fixed order", () => {
    expect(threeWayMergeBody("A\nB\n", "A\nmine\nB\n", "A\ntheirs\nB\n"))
      .toEqual({ merged: "A\nmine\ntheirs\nB\n", clean: true, conflicts: [] });
    expect(threeWayMergeBody("A\nB\n", "A\ntheirs\nB\n", "A\nmine\nB\n").merged).toBe("A\nmine\ntheirs\nB\n");
  });

  it("text added to a line and a rewrite of the same line conflict", () => {
    const r = threeWayMergeBody("x 一 y\n", "x 一 y!\n", "x 二 y\n");
    expect(r.clean).toBe(false);
    expect(r.merged).toBe("x 一 y!\n");
  });

  it("appending to a body with no final newline does not conflict with an edit to its last line", () => {
    expect(threeWayMergeBody("A\nB", "A\nB\nC", "A\nB2")).toEqual({ merged: "A\nB2\nC", clean: true, conflicts: [] });
    expect(threeWayMergeBody("A\nB", "A1\nB", "A\nB\n")).toEqual({ merged: "A1\nB\n", clean: true, conflicts: [] });
  });

  it("a conflict on the last line carries no added newline", () => {
    const r = threeWayMergeBody("A\nB", "A\nC", "A\nD");
    expect(r.merged).toBe("A\nC");
    expect(r.conflicts[0]).toMatchObject({ incoming: "C", current: "D", before: "A\n", after: "" });
    const s = threeWayMergeBody("A\nB", "X1\nB", "X2\nB");
    expect(s.conflicts[0]).toMatchObject({ incoming: "X1\n", current: "X2\n", before: "", after: "B" });
  });

  it("disjoint edits around a conflict still land", () => {
    const r = threeWayMergeBody("1\n2\n3\n4\n5\n", "1m\n2\nm\n4\n5\n", "1\n2\nt\n4\n5t\n");
    expect(r.merged).toBe("1m\n2\nm\n4\n5t\n");
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatchObject({ incoming: "m\n", current: "t\n", before: "2\n", after: "4\n" });
  });
});
