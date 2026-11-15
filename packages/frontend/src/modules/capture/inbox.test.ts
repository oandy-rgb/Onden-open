import { describe, expect, it, vi } from "vitest";
import type { ContentNode, Tag } from "../../lib/api";
import { capturesOnDay, inboxTagId, isPendingCapture, pendingCaptures } from "./inbox";

vi.mock("../../lib/localDate", async (original) => ({
  ...await original<typeof import("../../lib/localDate")>(),
  dateIdAt: (at: Date) => at.toISOString().slice(0, 10),
}));

const INBOX = { id: "inbox", name: "收件匣", schema_module: "capture" } as unknown as Tag;
const OTHER = { id: "other", name: "school" } as unknown as Tag;
const note = (id: string, extra: Partial<ContentNode> = {}): ContentNode =>
  ({ id, title: id, slug: id, markdown: "", source_type: "manual", node_type: "content", ...extra });

describe("the inbox", () => {
  it("knows its tag by the module, and has none before the first capture", () => {
    expect(inboxTagId([OTHER, INBOX])).toBe("inbox");
    expect(inboxTagId([OTHER])).toBeNull();
    expect(inboxTagId(undefined)).toBeNull();
  });

  it("holds the notes that carry the tag, whichever list the tag is in", () => {
    const tags = [INBOX, OTHER];
    expect(isPendingCapture(note("a", { class_tag_ids: ["inbox"] }), tags)).toBe(true);
    expect(isPendingCapture(note("b", { label_tag_ids: ["inbox"] }), tags)).toBe(true);
    expect(isPendingCapture(note("c", { class_tag_ids: ["other"] }), tags)).toBe(false);
    expect(isPendingCapture(note("d", { class_tag_ids: ["inbox"], deleted_at: "2026-10-29T00:00:00Z" }), tags)).toBe(false);
    expect(isPendingCapture(note("e", { class_tag_ids: ["inbox"] }), [OTHER])).toBe(false);
  });

  it("lists the waiting captures newest first", () => {
    const nodes = [
      note("old", { class_tag_ids: ["inbox"], created_at: "2026-10-28T08:00:00Z" }),
      note("plain", { created_at: "2026-10-29T08:00:00Z" }),
      note("new", { class_tag_ids: ["inbox"], created_at: "2026-10-29T09:00:00Z" }),
    ];
    expect(pendingCaptures(nodes, [INBOX]).map((n) => n.id)).toEqual(["new", "old"]);
  });
});

describe("what was jotted down on a day", () => {
  const nodes = [
    note("waiting", { class_tag_ids: ["inbox"], created_at: "2026-10-29T08:00:00Z" }),
    note("filed", { attrs: { _captured: "true" }, parent_id: "p", created_at: "2026-10-29T10:00:00Z" }),
    note("other day", { attrs: { _captured: "true" }, created_at: "2026-10-28T10:00:00Z" }),
    note("typed note", { created_at: "2026-10-29T11:00:00Z" }),
    note("trashed", { attrs: { _captured: "true" }, deleted_at: "2026-10-29T12:00:00Z", created_at: "2026-10-29T09:00:00Z" }),
  ];

  it("includes the filed ones, by when they were captured, newest first", () => {
    expect(capturesOnDay(nodes, [INBOX], "2026-10-29").map((n) => n.id)).toEqual(["filed", "waiting"]);
    expect(capturesOnDay(nodes, [INBOX], "2026-10-28").map((n) => n.id)).toEqual(["other day"]);
    expect(capturesOnDay(nodes, [INBOX], "2026-10-27")).toEqual([]);
  });
});
