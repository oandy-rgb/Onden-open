import { describe, it, expect } from "vitest";
import { containsTitle, matchTitle, rankByTitle } from "../lib/noteSearch";
import { filterTagTree, tagTreeRows } from "../lib/tagTree";
import { skillRows } from "../lib/agentMentions";

// The one title-matching rule every picker uses ([[, /, ⌘K, the sidebar).

describe("matchTitle", () => {
  it("ignores case and accents, and highlights the original characters", () => {
    expect(matchTitle("cafe", "Le Café")).toEqual({ ranges: [[3, 7]], contiguous: true });
    expect(matchTitle("CAFÉ", "cafe noir")).toEqual({ ranges: [[0, 4]], contiguous: true });
  });

  it("falls back to the query's characters in order", () => {
    expect(matchTitle("h2", "Heading 2")).toEqual({ ranges: [[0, 1], [8, 9]], contiguous: false });
    expect(matchTitle("tbl", "Table")).toEqual({ ranges: [[0, 1], [2, 4]], contiguous: false });
  });

  it("matches Chinese titles by substring and by characters in order", () => {
    expect(matchTitle("報告", "期末報告大綱")).toEqual({ ranges: [[2, 4]], contiguous: true });
    expect(matchTitle("期綱", "期末報告大綱")?.contiguous).toBe(false);
    expect(matchTitle("綱期", "期末報告大綱")).toBeNull();
  });

  it("an empty query matches everything without highlights", () => {
    expect(matchTitle("  ", "Anything")).toEqual({ ranges: [], contiguous: true });
  });
});

describe("rankByTitle", () => {
  it("puts contiguous matches first (a title starting with the text before one containing it), keeps order within each group, and caps", () => {
    const rows = [{ t: "Thesis bibliography" }, { t: "Bib notes" }, { t: "Big Bang" }, { t: "Unrelated" }];
    const ranked = rankByTitle("bib", rows, (r) => r.t);
    expect(ranked.map((r) => r.t)).toEqual(["Bib notes", "Thesis bibliography", "Big Bang"]);
    expect(rankByTitle("bib", rows, (r) => r.t, 1).map((r) => r.t)).toEqual(["Bib notes"]);
  });
});

describe("rankByTitle tiers", () => {
  const titles = (query: string, rows: string[]) => rankByTitle(query, rows.map((t) => ({ t })), (r) => r.t).map((r) => r.t);
  it("exact title, then starts with, then contains, then the characters in order", () => {
    expect(titles("Note 7", ["Note 70", "Note 76", "Draft of Note 7", "N o t e 7", "Note 7", "note 7 "])).toEqual(
      ["Note 7", "note 7 ", "Note 70", "Note 76", "Draft of Note 7", "N o t e 7"]);
  });
  it("the exact note leads a long list, whatever its place in it", () => {
    const rows = [...Array.from({ length: 12 }, (_, i) => `Note 7${i}`), "Note 7"];
    expect(rankByTitle("Note 7", rows.map((t) => ({ t })), (r) => r.t, 8)[0]!.t).toBe("Note 7");
  });
  it("an empty query keeps the list order", () => {
    expect(titles("", ["b", "a"])).toEqual(["b", "a"]);
  });
});

// Lists that filter (and often cap) their rows ask for a CONTIGUOUS match: letters that merely
// appear in order are not a hit, or they crowd the real title out of the first rows.
describe("containsTitle", () => {
  const scattered = "make every event task item new goal"; // m-e-e-t-i-n-g, in order, never together

  it("is matchTitle's folding and highlighting, minus the scattered fallback", () => {
    expect(matchTitle("meeting", scattered)).not.toBeNull();
    expect(containsTitle("meeting", scattered)).toBeNull();
    expect(containsTitle("CAFÉ", "Le cafe")).toEqual({ ranges: [[3, 7]], contiguous: true });
    expect(containsTitle("ａ１", "A1 notes")).toEqual({ ranges: [[0, 2]], contiguous: true });
    expect(containsTitle("  ", "Anything")).toEqual({ ranges: [], contiguous: true });
    expect(containsTitle("期綱", "期末報告大綱")).toBeNull();
  });

  it("tag lists, skill lists and block kinds do not match scattered letters", () => {
    const tags = [{ id: "1", name: scattered, parent_id: null }, { id: "2", name: "Meeting", parent_id: null }];
    expect(filterTagTree(tagTreeRows(tags), "#meeting").map((r) => r.tag.id)).toEqual(["2"]);
    const skill = (name: string) => ({ id: name, name, description: "", appliesTo: [] });
    expect(skillRows("meeting", [skill(scattered), skill("Meeting notes")]).map((r) => r.kind === "skill" && r.title)).toEqual(["Meeting notes"]);
  });
});
