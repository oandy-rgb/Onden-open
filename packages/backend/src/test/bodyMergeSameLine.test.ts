import { describe, expect, it } from "vitest";
import { threeWayMergeBody } from "../services/eventLog/bodyMerge.js";

// Two writers type into the same line (F03/F04): both texts must survive.
// `current` is what the server holds (saved first), `incoming` the later save.

describe("same line, same place", () => {
  const base = "# 標題\n\n第二段 beta\n";

  it("two appends to one line both land, in a fixed order", () => {
    const r = threeWayMergeBody(base, "# 標題\n\n第二段 beta [B同段]\n", "# 標題\n\n第二段 beta [A同段]\n");
    expect(r.merged).toBe("# 標題\n\n第二段 beta [A同段] [B同段]\n");
    expect(r).toMatchObject({ clean: true, conflicts: [] });
  });

  it("the same suffix typed on a title line by both writers", () => {
    const r = threeWayMergeBody("# 標題\n", "# 標題-ByB\n", "# 標題-ByA\n");
    expect(r.merged).toBe("# 標題-ByA-ByB\n");
    expect(r.clean).toBe(true);
  });

  it("several lines typed at the end of the note by both writers", () => {
    const r = threeWayMergeBody("末\n", "末\nb1\nb2\nb3\n", "末\na1\na2\na3\n");
    expect(r.merged).toBe("末\na1\na2\na3\nb1\nb2\nb3\n");
    expect(r.clean).toBe(true);
  });

  it("appends to a last line with no final newline", () => {
    const r = threeWayMergeBody("一行", "一行B", "一行A");
    expect(r.merged).toBe("一行AB");
    expect(r.clean).toBe(true);
  });

  it("edits that rewrite characters stay conflicts: no splicing of two rewrites", () => {
    const r = threeWayMergeBody("the cat and the dog\n", "the cat and the dig\n", "the cut and the dog\n");
    expect(r.clean).toBe(false);
    expect(r.merged).toBe("the cat and the dig\n");
    expect(r.conflicts[0]!.current).toBe("the cut and the dog\n");
  });

  it("the same insertion by both lands once", () => {
    const r = threeWayMergeBody("a\n", "a X\n", "a X\n");
    expect(r.merged).toBe("a X\n");
  });

  it("is order-stable whichever way the merge is replayed: nothing typed is lost", () => {
    const a = threeWayMergeBody(base, "# 標題\n\n第二段 beta [B]\n", "# 標題\n\n第二段 beta [A]\n").merged;
    expect(a).toContain("[A]");
    expect(a).toContain("[B]");
  });
});

describe("same line, same words changed", () => {
  it("still a conflict: the later save is kept, the other text is returned", () => {
    const r = threeWayMergeBody("一\n", "三\n", "二\n");
    expect(r.merged).toBe("三\n");
    expect(r.clean).toBe(false);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatchObject({ incoming: "三\n", current: "二\n" });
  });

  it("a conflict next to a clean insertion in the same line keeps the insertion out of the conflict", () => {
    const r = threeWayMergeBody("x 一 y\n", "x 三 y!\n", "x 二 y\n");
    expect(r.clean).toBe(false);
    expect(r.conflicts[0]!.current).toBe("x 二 y\n");
  });
});
