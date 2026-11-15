import { describe, expect, it } from "vitest";
import { alignParagraphs, splitParagraphs, summarizeChange, planTakeBack, buildTimeline, initialIndex, scrubReducer, shown, authorKindOf } from "../lib/history";

describe("splitParagraphs", () => {
  it("splits on blank lines, and makes headings and list items their own paragraphs", () => {
    const md = "# Title\nIntro line\ncontinued\n\n- one\n- two\n  more\n- [ ] task\n\nTail";
    expect(splitParagraphs(md).map((p) => p.text)).toEqual(["# Title", "Intro line\ncontinued", "- one", "- two\n  more", "- [ ] task", "Tail"]);
  });
  it("records source ranges, sections and block ids", () => {
    const md = "## Todo\n\nBuy milk ^abc\n\n## Done\n\nShip";
    const ps = splitParagraphs(md);
    for (const p of ps) expect(md.slice(p.start, p.end)).toBe(p.text);
    expect(ps.map((p) => p.section)).toEqual(["Todo", "Todo", "Done", "Done"]);
    expect(ps[1].blockId).toBe("abc");
  });
  it("keeps a fenced block with blank lines as one paragraph", () => {
    const ps = splitParagraphs("```\na\n\nb\n```\n\nafter");
    expect(ps.map((p) => p.text)).toEqual(["```\na\n\nb\n```", "after"]);
  });
  it("is empty for blank text", () => { expect(splitParagraphs("\n\n  \n")).toEqual([]); });
});

describe("alignParagraphs", () => {
  const kinds = (a: string, b: string) => alignParagraphs(a, b).map((r) => r.kind);
  it("finds same, added, changed and removed in the new order", () => {
    expect(kinds("A one\n\nB two\n\nC three", "A one\n\nB two edited\n\nC three\n\nD four")).toEqual(["same", "changed", "same", "added"]);
    expect(kinds("A\n\nB\n\nC", "A\n\nC")).toEqual(["same", "removed", "same"]);
  });
  it("keeps a removed paragraph at its old place", () => {
    const rows = alignParagraphs("keep one\n\ngone here\n\nkeep two", "keep one\n\nkeep two");
    expect(rows.map((r) => (r.old ?? r.new)!.text)).toEqual(["keep one", "gone here", "keep two"]);
  });
  it("aligns by block id even when the text was rewritten entirely", () => {
    const rows = alignParagraphs("old words ^k1", "completely different ^k1");
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("changed");
  });
  it("treats a retitled heading as a change; a leftover between the same neighbours is rewritten in place (the server's rule)", () => {
    expect(kinds("# Plan", "# Roadmap")).toEqual(["changed"]);
    expect(kinds("a b c\n\nzzz", "a b c\n\nxxx yyy\n\nqqq")).toEqual(["same", "changed", "added"]);
  });
  it("everything is added against nothing and removed against nothing", () => {
    expect(kinds("", "a\n\nb")).toEqual(["added", "added"]);
    expect(kinds("a\n\nb", "")).toEqual(["removed", "removed"]);
  });
});

describe("summarizeChange", () => {
  it("counts and names the sections touched", () => {
    const older = "## Todo\n\nBuy milk\n\n## Notes\n\nStays";
    const newer = "## Todo\n\nBuy oat milk\n\nCall mum\n\n## Notes\n\nStays";
    expect(summarizeChange(older, newer)).toEqual({ added: 1, changed: 1, removed: 0, sections: ["Todo"] });
  });
  it("is all zero for identical text", () => {
    expect(summarizeChange("x\n\ny", "x\n\ny")).toEqual({ added: 0, changed: 0, removed: 0, sections: [] });
  });
});

describe("planTakeBack", () => {
  const then = "# Todo\n\nBuy oat milk\n\nCall mum";
  it("replaces just the matching paragraph and leaves later edits alone", () => {
    const now = "# Todo\n\nBuy milk\n\nCall mum\n\nNew later line";
    const plan = planTakeBack(now, then, 1);
    expect(plan).toMatchObject({ kind: "replace", now: "Buy milk" });
    expect(plan.kind === "replace" && plan.markdown).toBe("# Todo\n\nBuy oat milk\n\nCall mum\n\nNew later line");
  });
  it("is 'same' when the note already has it", () => { expect(planTakeBack(then, then, 2).kind).toBe("same"); });
  it("puts a missing paragraph back after its previous neighbour", () => {
    const plan = planTakeBack("# Todo\n\nCall mum", then, 1);
    expect(plan.kind === "insert" && plan.markdown).toBe("# Todo\n\nBuy oat milk\n\nCall mum");
  });
  it("puts a missing first paragraph back at the top, and joins list items with one newline", () => {
    expect(planTakeBack("Call mum", "Intro\n\nCall mum", 0)).toMatchObject({ markdown: "Intro\n\nCall mum" });
    expect(planTakeBack("- a\n- c", "- a\n- b\n- c", 1)).toMatchObject({ markdown: "- a\n- b\n- c" });
  });
  it("inserts into an empty note and reports a missing index", () => {
    expect(planTakeBack("", "Hello", 0)).toMatchObject({ kind: "insert", markdown: "Hello\n" });
    expect(planTakeBack("x", "y", 5)).toEqual({ kind: "missing" });
  });
});

describe("note timeline state", () => {
  const v = (id: string, markdown: string, extra = {}) => ({ id, title: "", markdown, changed_at: `2026-09-0${id.slice(1)}T00:00:00Z`, actor_name: "A", actor_type: "user", ...extra });
  const points = buildTimeline([v("v3", "c"), v("v2", "b"), v("v1", "a")], "now text", "");
  it("orders oldest first with 'now' last and each point's previous body", () => {
    expect(points.map((p) => p.versionId)).toEqual(["v1", "v2", "v3", null]);
    expect(points.map((p) => p.previousBody)).toEqual(["", "a", "b", "c"]);
    expect(points[3].body).toBe("now text");
  });
  it("adds no 'now' point when the text equals the newest version; that version is now", () => {
    const same = buildTimeline([v("v2", "b"), v("v1", "a")], "b", "");
    expect(same.map((p) => p.versionId)).toEqual(["v1", "v2"]);
    expect(initialIndex(same, null)).toBe(1);
    // Different text (even by whitespace) is still the editing copy on its own point.
    expect(buildTimeline([v("v2", "b"), v("v1", "a")], "b ", "").map((p) => p.versionId)).toEqual(["v1", "v2", null]);
    expect(buildTimeline([], "", "").map((p) => p.versionId)).toEqual([null]);
  });
  it("prefers the server's summary, markers and author kind when present", () => {
    const withServer = buildTimeline([v("v1", "a", { summary: { added: 9, changed: 0, removed: 0, sections: ["S"] }, markers: ["before_agent", "published:2", "bogus"], actor_kind: "agent" })], "a", "");
    expect(withServer[0].summary.added).toBe(9);
    expect(withServer[0].markers).toEqual(["before_agent", "published:2"]);
    expect(withServer[0].authorKind).toBe("agent");
    expect(authorKindOf({ actor_kind: undefined, actor_type: "ai_agent" })).toBe("agent");
  });
  it("opens on the requested version, else the newest stored one", () => {
    expect(initialIndex(points, "v1")).toBe(0);
    expect(initialIndex(points, "missing")).toBe(2);
    expect(initialIndex(buildTimeline([], "x", ""), null)).toBe(0);
  });
  it("opens on the end of a day: the last version saved on or before it", () => {
    const noon = (id: string, day: string) => ({ ...v(id, id), changed_at: `${day}T12:00:00Z` });
    const days = buildTimeline([noon("v4", "2026-09-05"), noon("v3", "2026-09-03"), noon("v2", "2026-09-03"), noon("v1", "2026-09-01")], "now", "");
    expect(initialIndex(days, undefined, "2026-09-03")).toBe(2);
    expect(initialIndex(days, undefined, "2026-09-04")).toBe(2);
    expect(initialIndex(days, undefined, "2026-08-30")).toBe(3);
    expect(initialIndex(days, "v1", "2026-09-03")).toBe(0);
  });
  it("clamps seeks and steps, and any move releases a hold", () => {
    const s0 = { index: 1, holding: true, paragraph: 2 };
    expect(scrubReducer(s0, { type: "step", delta: 9 }, 4)).toEqual({ index: 3, holding: false, paragraph: null });
    expect(scrubReducer(s0, { type: "seek", index: -3 }, 4).index).toBe(0);
    expect(scrubReducer(s0, { type: "latest" }, 4).index).toBe(3);
  });
  it("shows the present, unmarked, while holding away from now", () => {
    expect(shown(points, { index: 1, holding: false, paragraph: null })).toMatchObject({ body: "b", markAgainst: "a", isNow: false, peeking: false });
    expect(shown(points, { index: 1, holding: true, paragraph: null })).toMatchObject({ body: "now text", markAgainst: null, isNow: true, peeking: true });
    expect(shown(points, { index: 3, holding: true, paragraph: null })).toMatchObject({ markAgainst: null, peeking: false });
  });
});

describe("whitespace-only differences", () => {
  const plain = "第一段文字\n\n- 項目一\n- 項目二\n\nthe tail end";
  const spaced = "第一段文字  \r\n\r\n- 項目一\u00a0\r\n- 項目二\u3000\r\n\r\nthe  tail end ";
  it("aligns as all same, agreeing with the summary", () => {
    const rows = alignParagraphs(plain, spaced);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.kind === "same")).toBe(true);
    expect(summarizeChange(plain, spaced)).toMatchObject({ added: 0, changed: 0, removed: 0 });
  });
  it("still sees a real edit next to whitespace noise", () => {
    const rows = alignParagraphs(plain, spaced.replace("the  tail end", "the tail end changed"));
    expect(rows.filter((r) => r.kind !== "same").map((r) => r.kind)).toEqual(["changed"]);
  });
});
