import { describe, expect, it } from "vitest";
import { groupStories, sameStory, storyKey } from "./storyGroups";

const at = (hoursAgo: number) => new Date(Date.parse("2026-11-02T12:00:00Z") - hoursAgo * 3_600_000).toISOString();
const item = (id: string, title: string, source_id: string, hoursAgo = 0) => ({ id, title, source_id, published_at: at(hoursAgo), fetched_at: at(hoursAgo) });

describe("storyKey", () => {
  it("drops punctuation, case and a short outlet suffix", () => {
    expect(storyKey("Apple Unveils: The New iPhone 17! - The Verge")).toBe("appleunveilsthenewiphone17");
    expect(storyKey("央行宣布升息一碼｜聯合新聞網")).toBe("央行宣布升息一碼");
  });
  it("keeps a long dash clause (it is the headline, not an outlet)", () => {
    expect(storyKey("Why it matters - a long explanation of the whole situation here")).toContain("explanation");
  });
});

describe("sameStory", () => {
  it("merges the same English headline from two feeds", () => {
    expect(sameStory(item("a", "Apple unveils the new iPhone 17 lineup", "s1"), item("b", "Apple unveils new iPhone 17 lineup - The Verge", "s2", 3))).toBe(true);
  });
  it("merges the same Chinese headline (no spaces) from two feeds", () => {
    expect(sameStory(item("a", "央行宣布升息一碼 房貸族壓力增", "s1"), item("b", "央行宣布升息一碼，房貸族壓力增加", "s2", 5))).toBe(true);
  });
  it("does not merge the same feed with itself", () => {
    expect(sameStory(item("a", "Apple unveils the new iPhone 17 lineup", "s1"), item("b", "Apple unveils the new iPhone 17 lineup", "s1", 1))).toBe(false);
  });
  it("does not merge different numbers", () => {
    expect(sameStory(item("a", "Apple unveils the new iPhone 16 lineup", "s1"), item("b", "Apple unveils the new iPhone 17 lineup", "s2"))).toBe(false);
  });
  it("does not merge articles more than two days apart", () => {
    expect(sameStory(item("a", "Apple unveils the new iPhone 17 lineup", "s1"), item("b", "Apple unveils the new iPhone 17 lineup", "s2", 60))).toBe(false);
  });
  it("does not merge headlines that only share a shape", () => {
    expect(sameStory(item("a", "Fed raises interest rates again", "s1"), item("b", "Fed cuts interest rates sharply", "s2"))).toBe(false);
    expect(sameStory(item("a", "央行宣布升息一碼", "s1"), item("b", "央行宣布降息兩碼", "s2"))).toBe(false);
  });
  it("does not merge short titles", () => {
    expect(sameStory(item("a", "Update", "s1"), item("b", "Update", "s2"))).toBe(false);
    expect(sameStory(item("a", "週報", "s1"), item("b", "週報", "s2"))).toBe(false);
  });
});

describe("groupStories", () => {
  it("keeps the list's order and puts a story where its first article is", () => {
    const rows = [
      item("a", "Apple unveils the new iPhone 17 lineup", "s1"),
      item("x", "Totally different local news about the weather today", "s3", 1),
      item("b", "Apple unveils new iPhone 17 lineup", "s2", 2),
      item("c", "Apple unveils the new iPhone 17 lineup!", "s3", 3),
    ];
    const stories = groupStories(rows);
    expect(stories.map((s) => s.lead.id)).toEqual(["a", "x"]);
    expect(stories[0]!.others.map((o) => o.id)).toEqual(["b", "c"]);
  });
  it("never puts two articles of one feed in the same story", () => {
    const rows = [
      item("a", "Apple unveils the new iPhone 17 lineup", "s1"),
      item("b", "Apple unveils the new iPhone 17 lineup", "s2", 1),
      item("c", "Apple unveils new iPhone 17 lineup", "s2", 2),
    ];
    const stories = groupStories(rows);
    expect(stories.map((s) => [s.lead.id, s.others.map((o) => o.id)])).toEqual([["a", ["b"]], ["c", []]]);
  });
});
