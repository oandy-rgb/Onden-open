import { describe, expect, it } from "vitest";
import { excerptBlock } from "@onden/markdown";
import { excerptsThisWeek, weekStartId } from "./weekReading";

const quote = (_id: string, feed: string | null) =>
  excerptBlock({ exact: "A line worth keeping" }, { title: "Post", url: "https://x.test/p", feed: feed ?? "" });
// The server anchors an excerpt at the start of its quote: here every note's text is one anchored block.
const anchorsOf = (noteId: string, body: string) => [{ id: `a-${noteId}`, from: 0, to: body.length }];
const dayOf = (iso: string) => iso.slice(0, 10);
const note = (over: Record<string, unknown>) => ({ node_type: "content", markdown: quote("abc123", "Blog"), ...over }) as never;

describe("weekStartId", () => {
  it("is the Monday of the week", () => {
    expect(weekStartId("2026-11-02")).toBe("2026-11-02"); // a Monday
    expect(weekStartId("2026-11-08")).toBe("2026-11-02"); // the Sunday after
    expect(weekStartId("2026-11-04")).toBe("2026-11-02");
  });
});

describe("excerptsThisWeek", () => {
  const today = "2026-11-04";
  it("counts a day note by its day and another note by its last edit", () => {
    const found = excerptsThisWeek([
      note({ id: "d1", title: "2026-11-03" }),
      note({ id: "n1", title: "Ideas", updated_at: "2026-11-02T08:00:00Z" }),
      note({ id: "old", title: "2026-10-30" }),
      note({ id: "n2", title: "Stale", updated_at: "2026-10-20T08:00:00Z" }),
    ], today, dayOf, undefined, anchorsOf);
    expect(found.map((f) => f.noteId)).toEqual(["d1", "n1"]);
  });
  it("skips excerpts without a feed, trashed notes and notes without text", () => {
    expect(excerptsThisWeek([
      note({ id: "a", title: "2026-11-03", markdown: quote("zzz999", null) }),
      note({ id: "b", title: "2026-11-03", deleted_at: "2026-11-03T00:00:00Z" }),
      note({ id: "c", title: "2026-11-03", markdown: null }),
    ], today, dayOf, undefined, anchorsOf)).toEqual([]);
  });
});
