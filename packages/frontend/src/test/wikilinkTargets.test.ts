import { describe, it, expect } from "vitest";
import { listLinkTargets } from "@onden/markdown";
import { parseTargetQuery, resolveNoteByTitle, targetRows } from "../lib/wikilinkTargets";

const notes = [{ id: "a", title: "Alpha" }, { id: "c", title: "C# notes" }, { id: "n", title: "筆記" }];
const current = { id: "cur", title: "Current" };
const resolve = (name: string) => resolveNoteByTitle(name, notes, current);
const info = { id: "a", title: "Alpha", sameNote: false, writable: true };
const md = "# Goals\n\nShip the thing early. ^ship\n\n## 目標二\n\n- first item\n- second item with detail\n\nPlain closing paragraph.";
const targets = listLinkTargets(md);

describe("parseTargetQuery", () => {
  it("reads the note, the # and the filter", () => {
    expect(parseTargetQuery("Alpha#", resolve)).toMatchObject({ note: notes[0], blocksOnly: false, filter: "", noteTyped: true });
    expect(parseTargetQuery("alpha#Goa", resolve)).toMatchObject({ note: notes[0], blocksOnly: false, filter: "Goa" });
    expect(parseTargetQuery("Alpha#^sh", resolve)).toMatchObject({ blocksOnly: true, filter: "sh" });
    expect(parseTargetQuery("筆記#^", resolve)).toMatchObject({ note: notes[2], blocksOnly: true });
  });
  it("is the same note when the name is left out", () => {
    expect(parseTargetQuery("#^", resolve)).toMatchObject({ note: current, blocksOnly: true, noteTyped: false });
    expect(parseTargetQuery("#x", resolve)).toMatchObject({ note: current, filter: "x" });
  });
  it("is not a target query without a known note, or while an alias is typed", () => {
    expect(parseTargetQuery("Nope#", resolve)).toBeNull();
    expect(parseTargetQuery("Alpha", resolve)).toBeNull();
    expect(parseTargetQuery("Alpha#x|al", resolve)).toBeNull();
  });
  it("finds a note whose title has a #", () => {
    expect(parseTargetQuery("C# notes#^", resolve)).toMatchObject({ note: notes[1], blocksOnly: true });
  });
});

describe("targetRows", () => {
  const q = (filter = "", blocksOnly = false) => ({ filter, blocksOnly, noteTyped: true });
  const names = (rows: ReturnType<typeof targetRows>) => rows.map((r) => r.target.kind === "heading" ? `h:${r.target.text}` : r.target.text);

  it("lists headings and blocks in document order", () => {
    expect(names(targetRows(q(), targets, info))).toEqual([
      "h:Goals", "Ship the thing early.", "h:目標二", "first item", "second item with detail", "Plain closing paragraph.",
    ]);
  });
  it("#^ lists only paragraphs and items", () => {
    expect(names(targetRows(q("", true), targets, info))).toEqual(["Ship the thing early.", "first item", "second item with detail", "Plain closing paragraph."]);
  });
  it("filters both kinds by a piece of their text, accents and case ignored, and a block by its id", () => {
    expect(names(targetRows(q("GOAL"), targets, info))).toEqual(["h:Goals"]);
    expect(names(targetRows(q("目標"), targets, info))).toEqual(["h:目標二"]);
    expect(names(targetRows(q("item"), targets, info))).toEqual(["first item", "second item with detail"]);
    expect(names(targetRows(q("ship", true), targets, info))).toEqual(["Ship the thing early."]);
    expect(names(targetRows(q("zzz"), targets, info))).toEqual([]);
  });
  it("matches text beyond the 60-character label, and highlights only inside the label", () => {
    const long = `${"word ".repeat(20)}needle at the end`;
    const rows = targetRows(q("needle"), listLinkTargets(long), info);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ranges).toEqual([]);
    expect(targetRows(q("word"), listLinkTargets(long), info)[0]!.ranges.length).toBeGreaterThan(0);
  });
  it("leaves out headings a link cannot name", () => {
    const odd = listLinkTargets("# C# basics\n\n## a | b\n\n## fine");
    expect(names(targetRows(q(), odd, info))).toEqual(["h:fine"]);
    expect(names(targetRows(q(), targets, { ...info, title: "C# notes" }))).not.toContain("h:Goals");
  });
});
