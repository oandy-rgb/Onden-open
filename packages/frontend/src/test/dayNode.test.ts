import { describe, it, expect } from "vitest";
import { hasOwnNotes } from "../lib/dayNode";
import { dayNoteDate } from "@onden/markdown";
import { todayId } from "../lib/localDate";

describe("todayId", () => {
  it("formats an injected date as LOCAL YYYY-MM-DD (zero-padded)", () => {
    // constructed with local components → reads back the same local day
    expect(todayId(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(todayId(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
  it("uses the local calendar day, not UTC", () => {
    // late-evening local time can be the next UTC day; the id must stay local
    const d = new Date(2026, 5, 13, 23, 30); // local 2026-06-13 23:30
    expect(todayId(d)).toBe("2026-06-13");
  });
});

// Day-node detection must mirror the Today button's open-or-create convention
// (title or slug === YYYY-MM-DD, non-hidden) — see useNodeCreation.openDailyNote.

describe("dayNoteDate", () => {
  it("detects a day node by title", () => {
    expect(dayNoteDate({ title: "2026-06-11", slug: "2026-06-11" })).toBe("2026-06-11");
  });

  it("detects a day node by slug when the title was renamed", () => {
    expect(dayNoteDate({ title: "Morning thoughts", slug: "2026-06-11" })).toBe("2026-06-11");
  });

  it("prefers the title's date over the slug's", () => {
    expect(dayNoteDate({ title: "2026-06-10", slug: "2026-06-11" })).toBe("2026-06-10");
  });

  it("returns null for ordinary notes", () => {
    expect(dayNoteDate({ title: "Project Apollo", slug: "project-apollo" })).toBeNull();
  });

  it("returns null for null/undefined and hidden nodes", () => {
    expect(dayNoteDate(null)).toBeNull();
    expect(dayNoteDate(undefined)).toBeNull();
    expect(dayNoteDate({ title: "2026-06-11", slug: "2026-06-11", hidden: true })).toBeNull();
  });

  it("rejects date-shaped strings that are not real calendar dates", () => {
    expect(dayNoteDate({ title: "2026-13-40", slug: "x" })).toBeNull();
    expect(dayNoteDate({ title: "2026-02-31", slug: "x" })).toBeNull();
  });

  it("rejects near-misses (prefixes, suffixes, other formats)", () => {
    expect(dayNoteDate({ title: "Notes 2026-06-11", slug: "notes-2026-06-11" })).toBeNull();
    expect(dayNoteDate({ title: "2026-06-11 meeting", slug: "y" })).toBeNull();
    expect(dayNoteDate({ title: "2026/06/11", slug: "z" })).toBeNull();
  });

  it("accepts leap days only in leap years", () => {
    expect(dayNoteDate({ title: "2024-02-29", slug: "a" })).toBe("2024-02-29");
    expect(dayNoteDate({ title: "2025-02-29", slug: "b" })).toBeNull();
  });
});

describe("hasOwnNotes (first-run welcome gate)", () => {
  it("a workspace with only day notes and tags is still new", () => {
    expect(hasOwnNotes([])).toBe(false);
    expect(hasOwnNotes([
      { node_type: "content", title: "2026-10-11" },
      { node_type: "class_tag", title: "gt" },
      { node_type: "content", title: "Draft", hidden: true },
      { node_type: "content", title: "Gone", deleted_at: "2026-10-01T00:00:00Z" },
    ])).toBe(false);
  });

  it("any visible note or canvas of the user's own means it is not", () => {
    expect(hasOwnNotes([{ node_type: "content", title: "2026-10-11" }, { node_type: "content", title: "Handwritten note" }])).toBe(true);
    expect(hasOwnNotes([{ node_type: "canvas", title: "Untitled Canvas" }])).toBe(true);
  });
});
