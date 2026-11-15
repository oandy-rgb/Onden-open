import { describe, expect, it } from "vitest";
import {
  servedPartLink, bindingKey, blockLinkShown, blockLinkText, blockLinkWords, hasLinkPath, linkPathReadings, matchParts, readBlockLink,
  type AnchorFacts, type BlockLinkEnv, type LinkNote,
} from "./index.js";

const note = (id: string, title: string, markdown: string | null): LinkNote => ({ id, title, markdown });
const MEAL = note("n1", "吃飯紀錄", "# 晚餐\n\n17:45–21:15 吃飯，很久。\n\n## 結論\n\n下次少點一道菜。\n\n17:50 另一件事\n");
const OTHER = note("n2", "寫作", "17:45 寫作\n");

function envOf(opts: { notes?: LinkNote[]; unreadable?: string[]; bindings?: Record<string, string>; anchors?: AnchorFacts[] } = {}): BlockLinkEnv {
  const notes = opts.notes ?? [MEAL, OTHER];
  return {
    findNote: (name) => notes.find((n) => n.title === name) ?? null,
    note: (id) => (opts.unreadable?.includes(id) ? "unreadable" : notes.find((n) => n.id === id) ?? null),
    binding: (src, key) => opts.bindings?.[`${src}|${key}`] ?? null,
    anchor: (id) => opts.anchors?.find((a) => a.anchorId === id) ?? null,
  };
}
const anchor = (over: Partial<AnchorFacts> = {}): AnchorFacts => ({
  anchorId: "a1", noteId: "n1", from: 6, to: 21, status: "valid", candidate: null, quote: "17:45–21:15 吃飯，很久。", ...over,
});

describe("link path", () => {
  it("only a / makes a path; urls are not", () => {
    expect(hasLinkPath("筆記")).toBe(false);
    expect(hasLinkPath("筆記/段")).toBe(true);
    expect(hasLinkPath("https://a/b")).toBe(false);
  });
  it("reads a/b/c as the longest note name first, [[/x]] as this note", () => {
    expect(linkPathReadings("a/b/c")).toEqual([{ note: "a/b", segments: ["c"] }, { note: "a", segments: ["b", "c"] }]);
    expect(linkPathReadings("/文字")).toEqual([{ note: "", segments: ["文字"] }]);
    expect(linkPathReadings("/")).toEqual([]);
    expect(linkPathReadings("筆記")).toEqual([]);
  });
  it("link text never holds / | [ ] or line breaks", () => {
    expect(blockLinkText("a/b|c]]\n d")).toBe("a b c d");
    expect(blockLinkText("長".repeat(60)).length).toBe(40);
  });
  it("the key is NFC and single spaced", () => {
    expect(bindingKey("  筆記/ 開頭   x ")).toBe("筆記/ 開頭 x");
  });
});

describe("matchParts", () => {
  it("a paragraph by its start, a heading by its text", () => {
    expect(matchParts(MEAL.markdown!, ["17:45"])).toMatchObject({ found: "one" });
    expect(matchParts(MEAL.markdown!, ["結論"])).toMatchObject({ found: "one", target: { kind: "heading" } });
  });
  it("several fits are many; none is none", () => {
    expect(matchParts(MEAL.markdown!, ["17:"])).toMatchObject({ found: "many" });
    expect(matchParts(MEAL.markdown!, ["不存在"])).toEqual({ found: "none" });
  });
  it("a deeper level is looked for inside the heading's section", () => {
    expect(matchParts(MEAL.markdown!, ["晚餐", "下次"])).toMatchObject({ found: "one" });
    expect(matchParts(MEAL.markdown!, ["結論", "17:45"])).toEqual({ found: "none" });
  });
  it("an exact match beats a start-of-text match", () => {
    expect(matchParts("甲乙\n\n甲乙丙\n", ["甲乙"])).toMatchObject({ found: "one", target: { text: "甲乙" } });
  });
});

describe("readBlockLink", () => {
  it("a note name that exists is not a part link, even with a / in it", () => {
    const slashy = note("n3", "a/b", "x");
    expect(readBlockLink(envOf({ notes: [slashy] }), "n9", "a/b")).toEqual({ kind: "not-a-part" });
  });
  it("a hand-typed link is found by its text; no id is involved", () => {
    const r = readBlockLink(envOf(), "n9", "吃飯紀錄/結論");
    expect(r).toMatchObject({ kind: "part", anchorId: null, anchored: false, part: { noteTitle: "吃飯紀錄", excerpt: "結論" } });
    expect(blockLinkShown(r, "n9")).toBe("吃飯紀錄 › 結論");
  });
  it("[[/x]] is the note the link is in, and reads without the note's name", () => {
    const r = readBlockLink(envOf(), "n1", "/下次");
    expect(blockLinkShown(r, "n1")).toBe("下次少點一道菜。");
  });
  it("a bound link follows the paragraph by identity though its words changed", () => {
    const md = "# 晚餐\n\n（已改寫）17:45–21:15 吃飯，很久。\n";
    const n = note("n1", "吃飯紀錄", md);
    const r = readBlockLink(envOf({ notes: [n], bindings: { "n9|吃飯紀錄/17:45": "a1" }, anchors: [anchor({ from: 6, to: md.length - 1, quote: "（已改寫）17:45–21:15 吃飯，很久。" })] }), "n9", "吃飯紀錄/17:45");
    expect(r).toMatchObject({ kind: "part", anchorId: "a1", anchored: true });
    expect(blockLinkShown(r, "n9")).toBe("吃飯紀錄 › （已改寫）17:45–21:15 吃飯，…");
  });
  it("shows the part as it stands now when words were added at the end of its first line", () => {
    const md = "# 演算法與資料結構\n\n內文。\n";
    const r = readBlockLink(envOf({ notes: [note("n1", "吃飯紀錄", md)], bindings: { "n9|吃飯紀錄/演算法": "a1" }, anchors: [anchor({ from: 0, to: "# 演算法".length, quote: "# 演算法" })] }), "n9", "吃飯紀錄/演算法");
    expect(blockLinkShown(r, "n9")).toBe("吃飯紀錄 › 演算法與資料結構");
  });
  it("a stale link text with a correct binding still arrives (name out of date, id right)", () => {
    const r = readBlockLink(envOf({ bindings: { "n9|吃飯紀錄/舊的開頭": "a1" }, anchors: [anchor()] }), "n9", "吃飯紀錄/舊的開頭");
    expect(r.kind).toBe("part");
  });
  it("maybe offers the candidate; lost falls back to the note; deleted shows the old words", () => {
    const bindings = { "n9|吃飯紀錄/x": "a1" };
    expect(readBlockLink(envOf({ bindings, anchors: [anchor({ status: "maybe", candidate: { from: 6, to: 21 } })] }), "n9", "吃飯紀錄/x")).toMatchObject({ kind: "maybe", anchorId: "a1" });
    expect(readBlockLink(envOf({ bindings, anchors: [anchor({ status: "lost" })] }), "n9", "吃飯紀錄/x")).toMatchObject({ kind: "lost", noteTitle: "吃飯紀錄", guess: null });
    expect(readBlockLink(envOf({ notes: [OTHER], bindings, anchors: [anchor()] }), "n9", "吃飯紀錄/x")).toEqual({ kind: "erased", quote: "17:45–21:15 吃飯，很久。" });
  });
  it("an unreadable target says nothing: no name, no words, no comparison", () => {
    const env = envOf({ unreadable: ["n1"], bindings: { "n9|吃飯紀錄/x": "a1" }, anchors: [anchor()] });
    const r = readBlockLink(env, "n9", "吃飯紀錄/x");
    expect(r).toEqual({ kind: "unavailable" });
    expect(JSON.stringify(r)).not.toContain("吃飯");
  });
  it("a note whose text is not downloaded reads as the note's name, never as deleted", () => {
    const slim = note("n1", "吃飯紀錄", null);
    expect(readBlockLink(envOf({ notes: [slim] }), "n9", "吃飯紀錄/結論")).toMatchObject({ kind: "pending", noteTitle: "吃飯紀錄" });
    const r = readBlockLink(envOf({ notes: [slim], bindings: { "n9|吃飯紀錄/x": "a1" }, anchors: [anchor()] }), "n9", "吃飯紀錄/x");
    expect(r.kind).toBe("pending");
  });
  it("several fits ask the reader; no fit is no-such-part", () => {
    expect(readBlockLink(envOf(), "n9", "吃飯紀錄/17:")).toMatchObject({ kind: "ambiguous" });
    expect(readBlockLink(envOf(), "n9", "吃飯紀錄/沒有")).toMatchObject({ kind: "no-such-part" });
  });
  it("a Folder/Note that names no note and no part of Folder is shown as typed (a click still makes the note)", () => {
    const r = readBlockLink(envOf(), "n9", "吃飯紀錄/沒有");
    expect(r.kind).toBe("no-such-part");
    expect(blockLinkShown(r, "n9")).toBeNull();
  });
  it("words: the note's name, an arrow, the start", () => {
    expect(blockLinkWords("筆記", "開頭")).toBe("筆記 › 開頭");
    expect(blockLinkWords(null, "開頭")).toBe("開頭");
  });
});

describe("the published site reads a part link by its words, the same way the app reads one nobody bound", () => {
  const pages = [{ id: "n1", slug: "meal", title: "吃飯紀錄", markdown: MEAL.markdown! }, { id: "n9", slug: "src", title: "來源", markdown: "" }];

  it("says the same words as the app and opens the page", () => {
    for (const target of ["吃飯紀錄/結論", "吃飯紀錄/下次", "吃飯紀錄/晚餐/下次"]) {
      const app = blockLinkShown(readBlockLink(envOf(), "n9", target), "n9");
      const site = servedPartLink(target, pages, "n9");
      expect(site?.words, target).toBe(app);
      expect(site?.page.id).toBe("n1");
    }
  });

  it("a heading opens at the heading; several fits open the page and read as its title; no fit is left as typed", () => {
    expect(servedPartLink("吃飯紀錄/結論", pages, "n9")?.heading).toBe("結論");
    expect(servedPartLink("吃飯紀錄/17:", pages, "n9")).toMatchObject({ words: "吃飯紀錄", heading: null });
    expect(servedPartLink("吃飯紀錄/沒有", pages, "n9")).toBeNull();
  });

  it("[[/words]] is the page the link is in; a whole title that exists is not a part link; an unserved note names nothing", () => {
    expect(servedPartLink("/結論", [{ ...pages[0]! }], "n1")?.words).toBe("結論");
    expect(servedPartLink("吃飯紀錄", pages, "n9")).toBeNull();
    expect(servedPartLink("私人筆記/段落", pages, "n9")).toBeNull();
  });
});
