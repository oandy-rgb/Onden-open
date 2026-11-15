import { describe, expect, it } from "vitest";
import { blockHistory, headingAbove, type BlockSourceVersion } from "../lib/history";
import { splitParagraphs } from "@onden/markdown";
import { describeChange } from "../lib/history";

let n = 0;
const v = (markdown: string, actor: string | null = "Ann", type: string | null = "user"): BlockSourceVersion =>
  ({ id: `v${++n}`, markdown, changed_at: `2026-10-0${(n % 9) + 1}T02:10:00Z`, actor_name: actor, actor_type: type });
/** Newest first, as the server sends them. */
const feed = (...oldestFirst: BlockSourceVersion[]) => [...oldestFirst].reverse();
const at = (doc: string, needle: string) => doc.indexOf(needle) + 1;
const texts = (h: ReturnType<typeof blockHistory>) => h.map((e) => e.text);

describe("block paragraphs", () => {
  // The cut itself is @onden/markdown's (paragraphs.test.ts); what block history relies on:
  it("gives a ^id-free body whose range the editor can swap", () => {
    const doc = "intro\n\nhello world ^abc12";
    const [, p] = splitParagraphs(doc);
    expect(p.blockId).toBe("abc12");
    expect(p.body).toBe("hello world");
    expect(doc.slice(p.start, p.bodyEnd)).toBe("hello world");
  });
  it("does not track the frontmatter block", () => {
    const doc = "---\ntitle: x\n---\n\nafter";
    expect(blockHistory([], { markdown: doc, offset: 2 })).toEqual([]);
  });
});

describe("blockHistory", () => {
  it("follows a paragraph by its ^id through edits", () => {
    const v1 = "A\n\nBeta one ^b1\n\nC";
    const v2 = "A\n\nBeta two ^b1\n\nC";
    const now = "A\n\nBeta three ^b1\n\nC";
    const h = blockHistory(feed(v(v1), v(v2)), { markdown: now, offset: at(now, "Beta") });
    expect(texts(h)).toEqual(["Beta one", "Beta two", "Beta three"]);
    expect(h[0].created).toBe(true);
    expect(h[2].current).toBe(true);
    expect(h[2].changedAt).toBeNull(); // not saved yet
  });

  it("follows a paragraph across the save that moved its ^id out of the text (migration 180)", () => {
    // Short paragraphs among others: once the id is gone the two wordings are only alike, and not alike enough.
    const before = "第一段 ^a1b2c3\n\n第二段 ^d4e5f6\n\n第三段";
    const v1 = "第一段 ^a1b2c3\n\n舊的第二段 ^d4e5f6\n\n第三段";
    const now = "第一段\n\n第二段\n\n第三段";
    const h = blockHistory(feed(v(v1), v(before), v(now)), { markdown: now, offset: at(now, "第二段") });
    expect(texts(h)).toEqual(["舊的第二段", "第二段"]);
    expect(h[0].created).toBe(true);
  });

  it("follows a paragraph that had no ^id by position and likeness", () => {
    const v1 = "Intro\n\nThe cat sat on the mat today";
    const v2 = "Intro\n\nThe cat sat on the red mat today";
    const now = "Intro\n\nExtra paragraph\n\nThe cat sat on the red mat all day";
    const h = blockHistory(feed(v(v1), v(v2)), { markdown: now, offset: at(now, "The cat") });
    expect(texts(h)).toEqual(["The cat sat on the mat today", "The cat sat on the red mat today", "The cat sat on the red mat all day"]);
  });

  it("finds a paragraph that moved", () => {
    const v1 = "Alpha paragraph here\n\nBeta paragraph there\n\nGamma paragraph everywhere";
    const now = "Gamma paragraph everywhere\n\nAlpha paragraph here\n\nBeta paragraph there, changed";
    const h = blockHistory(feed(v(v1)), { markdown: now, offset: at(now, "Beta") });
    expect(texts(h)).toEqual(["Beta paragraph there", "Beta paragraph there, changed"]);
  });

  it("merges consecutive saves with the same wording and credits the first one", () => {
    const a = v("Same\n\nOld wording of it", "Ann");
    const b = v("Same\n\nNew wording of it", "Bot", "ai_agent");
    const c = v("Same\n\nNew wording of it\n\nTail", "Cy");
    const now = "Same\n\nNew wording of it\n\nTail";
    const h = blockHistory(feed(a, b, c), { markdown: now, offset: at(now, "New") });
    expect(texts(h)).toEqual(["Old wording of it", "New wording of it"]);
    expect(h[1]).toMatchObject({ actorName: "Bot", actorType: "ai_agent", versionId: b.id, current: true });
  });

  it("stops at 建立 for a paragraph added later", () => {
    const v1 = "Only this one here";
    const v2 = "Only this one here\n\nBrand new paragraph text";
    const now = "Only this one here\n\nBrand new paragraph text, edited";
    const h = blockHistory(feed(v(v1), v(v2)), { markdown: now, offset: at(now, "Brand") });
    expect(texts(h)).toEqual(["Brand new paragraph text", "Brand new paragraph text, edited"]);
    expect(h[0].created).toBe(true);
  });

  it("treats a paragraph deleted and added back as created again", () => {
    const v1 = "Keep me\n\nComes and goes and comes back";
    const v2 = "Keep me";
    const v3 = "Keep me\n\nComes and goes and comes back";
    const now = v3;
    const h = blockHistory(feed(v(v1), v(v2), v(v3)), { markdown: now, offset: at(now, "Comes") });
    expect(texts(h)).toEqual(["Comes and goes and comes back"]);
    expect(h[0]).toMatchObject({ created: true, current: true });
  });

  it("is not 'created' when the feed is capped and the paragraph runs to its end", () => {
    const rows = Array.from({ length: 50 }, (_, i) => v(`Steady paragraph ${i % 2 ? "" : ""}text`));
    const h = blockHistory(rows, { markdown: "Steady paragraph text", offset: 1 });
    expect(h).toHaveLength(1);
    expect(h[0].created).toBe(false);
  });

  it("handles CRLF in saved versions and in the target", () => {
    const v1 = "Head\r\n\r\nSome line one\r\n\r\nTail";
    const now = "Head\r\n\r\nSome line two\r\n\r\nTail";
    const h = blockHistory(feed(v(v1)), { markdown: now, offset: now.indexOf("Some") + 2 });
    expect(texts(h)).toEqual(["Some line one", "Some line two"]);
  });

  it("returns nothing when the offset is in front matter", () => {
    expect(blockHistory([], { markdown: "---\na: b\n---\n\ntext", offset: 2 })).toEqual([]);
  });
});

describe("headingAbove", () => {
  it("names the nearest heading above, or null", () => {
    const doc = "intro\n\n# Plans\n\n## Week 3 ##\n\ntarget";
    expect(headingAbove(doc, doc.indexOf("target"))).toBe("Week 3");
    expect(headingAbove(doc, 1)).toBeNull();
  });
});

describe("describeChange", () => {
  it("reports what the current text added or lost", () => {
    expect(describeChange("a b c", "a b c")).toEqual({ kind: "same" });
    expect(describeChange("Buy milk today", "Buy milk and eggs today")).toEqual({ kind: "added", added: "and eggs" });
    expect(describeChange("Buy milk and eggs today", "Buy milk today")).toEqual({ kind: "removed", removed: "and eggs" });
    expect(describeChange("Buy milk today", "Buy oat milk today")).toMatchObject({ kind: "added" });
    expect(describeChange("Buy milk today now", "Buy tea today now")).toMatchObject({ kind: "both", added: "tea", removed: "milk" });
    expect(describeChange("completely different", "nothing alike!!")).toEqual({ kind: "rewritten" });
  });
});
