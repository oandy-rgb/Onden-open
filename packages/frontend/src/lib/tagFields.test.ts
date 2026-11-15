import { describe, expect, it } from "vitest";
import { draftFieldClashes, namesTakenAround, tagFields } from "./tagFields";
import type { Tag } from "./api";

describe("tagFields", () => {
  it("is the server's effective list, else the tag's own (older servers), else nothing", () => {
    const own = [{ name: "pages", type: "number" as const }];
    const effective = [...own, { name: "finished", type: "date" as const, inherited_from: "b" }];
    expect(tagFields({ schema_fields: own, effective_fields: effective })).toEqual(effective);
    expect(tagFields({ schema_fields: own })).toEqual(own);
    expect(tagFields({ schema_fields: null })).toEqual([]);
  });
});

type CatalogTag = Pick<Tag, "id" | "parent_id" | "schema_extends" | "schema_fields">;
const tag = (id: string, fields: Array<{ name: string; label?: string }>, parent_id: string | null = null, schema_extends: string[] = []): CatalogTag =>
  ({ id, parent_id, schema_extends, schema_fields: fields.map((f) => ({ ...f, type: "text" as const })) });

describe("draftFieldClashes", () => {
  const book = tag("book", [{ name: "author", label: "作者" }]);
  const calendar = tag("calendar", [{ name: "date" }]);
  const novel = tag("novel", [{ name: "writer", label: "作者" }], "book", ["calendar"]);
  const short = tag("short", [{ name: "pages" }], "novel");
  const catalog = [book, calendar, novel, short];

  it("a shared label is no clash; only the name counts", () => {
    expect(draftFieldClashes(novel, [{ name: "writer" }, { name: "plot" }], catalog).size).toBe(0);
  });

  it("a name a parent or a function gives is held back, naming the tag", () => {
    const held = draftFieldClashes(novel, [{ name: "writer" }, { name: "author" }, { name: "date" }], catalog);
    expect([...held]).toEqual([["author", { other: "book", below: false }], ["date", { other: "calendar", below: false }]]);
  });

  it("a name a tag below declares is held back on the ancestor", () => {
    expect([...draftFieldClashes(book, [{ name: "author" }, { name: "pages" }], catalog)])
      .toEqual([["pages", { other: "short", below: true }]]);
  });

  it("a clash already in the catalog (legacy) stays saveable", () => {
    const legacy = tag("novel", [{ name: "author" }], "book");
    expect(draftFieldClashes(legacy, [{ name: "author" }, { name: "plot" }], [book, legacy]).size).toBe(0);
  });

  it("a field still keyed by `key` (older imports) is read by it", () => {
    expect(draftFieldClashes(novel, [{ name: "", key: "author" }], catalog).get("author")).toEqual({ other: "book", below: false });
  });
});

describe("namesTakenAround", () => {
  it("lists the names above (parents, functions) and below, not unrelated ones", () => {
    const book = tag("book", [{ name: "author" }]);
    const novel = tag("novel", [{ name: "plot" }], "book", ["calendar"]);
    const calendar = tag("calendar", [{ name: "date" }]);
    const short = tag("short", [{ name: "pages" }], "novel");
    const other = tag("film", [{ name: "director" }]);
    expect(namesTakenAround(novel, [book, novel, calendar, short, other]).sort()).toEqual(["author", "date", "pages"]);
  });
});
