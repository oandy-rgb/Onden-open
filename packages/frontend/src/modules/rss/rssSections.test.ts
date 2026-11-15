import { describe, expect, it } from "vitest";
import { daySection, listRows } from "./rssSections";

const NOON = (d: string) => `${d}T12:00:00`; // local time, so the workspace day is unambiguous

describe("daySection", () => {
  it("cuts today, yesterday and earlier", () => {
    expect(daySection(NOON("2026-11-02"), "2026-11-02")).toBe("today");
    expect(daySection(NOON("2026-11-01"), "2026-11-02")).toBe("yesterday");
    expect(daySection(NOON("2026-10-30"), "2026-11-02")).toBe("earlier");
  });
  it("treats a time ahead of today as today and a missing or bad time as earlier", () => {
    expect(daySection(NOON("2026-11-03"), "2026-11-02")).toBe("today");
    expect(daySection(null, "2026-11-02")).toBe("earlier");
    expect(daySection("not a date", "2026-11-02")).toBe("earlier");
  });
});

describe("listRows", () => {
  const item = (id: string, d: string) => ({ id, published_at: NOON(d), fetched_at: NOON(d) });
  const items = [item("a", "2026-11-02"), item("b", "2026-11-02"), item("c", "2026-11-01"), item("d", "2026-10-20")];

  it("puts a heading where the section changes", () => {
    expect(listRows(items, "2026-11-02", null).map((r) => r.kind === "item" ? r.key : r.key))
      .toEqual(["today", "a", "b", "yesterday", "c", "earlier", "d"]);
  });
  it("draws the last-read line just above the article you were on", () => {
    const rows = listRows(items, "2026-11-02", "c");
    expect(rows.map((r) => r.kind)).toEqual(["section", "item", "item", "section", "last-read", "item", "section", "item"]);
  });
  it("draws no line above the first article, or for one that is gone", () => {
    expect(listRows(items, "2026-11-02", "a").some((r) => r.kind === "last-read")).toBe(false);
    expect(listRows(items, "2026-11-02", "zzz").some((r) => r.kind === "last-read")).toBe(false);
  });
});
