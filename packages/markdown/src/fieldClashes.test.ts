import { describe, expect, it } from "vitest";
import { fieldNameClashes, newFieldNameClashes, type FieldClashRow } from "./fieldClashes.js";

const row = (id: string, names: Array<string | { name: string; label?: string }>, parent_id: string | null = null, ext: string[] = []): FieldClashRow =>
  ({ id, parent_id, extends: ext, fields: names.map((n) => (typeof n === "string" ? { name: n, type: "text" } : { ...n, type: "text" })) });

describe("fieldNameClashes", () => {
  it("names only: a shared label is no clash", () => {
    expect(fieldNameClashes([row("book", [{ name: "author", label: "作者" }]), row("novel", [{ name: "writer", label: "作者" }], "book")])).toEqual([]);
  });

  it("a name a parent, a function or a legacy extends gives, at any depth, nearest first", () => {
    const rows = [
      row("root", ["pages"]), row("book", ["pages"], "root"), row("calendar", ["date"]),
      row("novel", ["pages", "date", "plot"], "book", ["calendar"]),
    ];
    expect(fieldNameClashes(rows)).toEqual([
      { tag: "book", field: "pages", from: "root" },
      { tag: "novel", field: "pages", from: "book" },
      { tag: "novel", field: "date", from: "calendar" },
    ]);
  });

  it("missing tags, non-lists and cycles add nothing", () => {
    expect(fieldNameClashes([
      { id: "a", parent_id: "b", extends: "junk", fields: [{ name: "x" }, { label: "no name" }, null] },
      { id: "b", parent_id: "a", extends: ["gone"], fields: "junk" },
    ])).toEqual([]);
  });
});

describe("newFieldNameClashes", () => {
  const book = row("book", ["pages"]);
  it("refuses only what the write adds; a stored clash is tolerated", () => {
    const legacy = row("novel", ["pages"], "book");
    expect(newFieldNameClashes([book, legacy], [book, row("novel", ["pages", "plot"], "book")])).toEqual([]);
    expect(newFieldNameClashes([book, row("novel", ["plot"], "book")], [book, row("novel", ["plot", "pages"], "book")]))
      .toEqual([{ tag: "novel", field: "pages", from: "book" }]);
  });

  it("a tag missing from before is a new one", () => {
    expect(newFieldNameClashes([book], [book, row("novel", ["pages"], "book")])).toEqual([{ tag: "novel", field: "pages", from: "book" }]);
  });
});
