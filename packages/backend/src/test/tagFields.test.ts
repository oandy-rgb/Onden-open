// Field inheritance (services/tagFields.ts): a tag's own fields, then those of
// the tags it extends, nearest first; a name the tag (or a nearer tag) declares
// is not taken again. Cycles and missing tags add nothing.
import { describe, expect, it } from "vitest";
import { effectiveTagFields, fieldNameClashes } from "../services/tagFields.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const D = "00000000-0000-4000-8000-00000000000d";

describe("effectiveTagFields", () => {
  it("own first, then inherited by distance; the nearest declaration of a name wins", () => {
    const rows = [
      { id: A, extends: [B], fields: [{ name: "title2", type: "text" }] },
      { id: B, extends: [C], fields: [{ name: "finished", type: "date" }, { name: "rating", type: "number" }] },
      { id: C, extends: [], fields: [{ name: "rating", type: "rating" }, { name: "author", type: "text" }] },
    ];
    expect(effectiveTagFields(rows).get(A)).toEqual([
      { name: "title2", type: "text" },
      { name: "finished", type: "date", inherited_from: B },
      { name: "rating", type: "number", inherited_from: B },
      { name: "author", type: "text", inherited_from: C },
    ]);
  });

  it("a tag's own field overrides an inherited one of the same name", () => {
    const rows = [
      { id: A, extends: [B], fields: [{ name: "status", type: "select", options: ["x"] }] },
      { id: B, extends: [], fields: [{ name: "status", type: "text" }] },
    ];
    expect(effectiveTagFields(rows).get(A)).toEqual([{ name: "status", type: "select", options: ["x"] }]);
  });

  it("cycles, missing tags and junk add nothing", () => {
    const rows = [
      { id: A, extends: [B, D, "not-a-uuid"], fields: [{ name: "a", type: "text" }, null, { type: "text" }] },
      { id: B, extends: [A], fields: [{ name: "b", type: "text" }] },
    ];
    const map = effectiveTagFields(rows);
    expect(map.get(A)!.map((f) => f.name)).toEqual(["a", "b"]);
    expect(map.get(B)!.map((f) => f.name)).toEqual(["b", "a"]);
    expect(effectiveTagFields([{ id: C, extends: null, fields: null }]).get(C)).toEqual([]);
  });

  it("a parent tag (上層) gives its fields too, before the tags extended at the same distance", () => {
    const rows = [
      { id: A, parent_id: B, extends: [C], fields: [] },
      { id: B, parent_id: null, extends: [], fields: [{ name: "status", type: "select" }, { name: "author", type: "text" }] },
      { id: C, extends: [], fields: [{ name: "status", type: "text" }, { name: "due", type: "date" }] },
      // A parent that is not a tag (a note) is not in the rows: it adds nothing.
      { id: D, parent_id: "00000000-0000-4000-8000-0000000000ff", extends: [], fields: [] },
    ];
    const map = effectiveTagFields(rows);
    expect(map.get(A)).toEqual([
      { name: "status", type: "select", inherited_from: B },
      { name: "author", type: "text", inherited_from: B },
      { name: "due", type: "date", inherited_from: C },
    ]);
    expect(map.get(D)).toEqual([]);
  });
});

describe("fieldNameClashes", () => {
  it("reports a tag's own field that an ancestor at any depth also declares, once per field", () => {
    const rows = [
      { id: A, parent_id: null, extends: [], fields: [{ name: "pages", type: "number" }] },
      { id: B, parent_id: A, extends: [], fields: [] },
      { id: C, parent_id: null, extends: [], fields: [{ name: "pages", type: "text" }] },
      { id: D, parent_id: B, extends: [C], fields: [{ name: "pages", type: "text" }, { name: "own", type: "text" }] },
    ];
    expect(fieldNameClashes(rows)).toEqual([{ tag: D, field: "pages", from: C }]);
  });

  it("ignores cycles and missing tags", () => {
    const rows = [
      { id: A, parent_id: B, extends: ["00000000-0000-4000-8000-0000000000ff"], fields: [{ name: "x", type: "text" }] },
      { id: B, parent_id: A, extends: [], fields: [] },
    ];
    expect(fieldNameClashes(rows)).toEqual([]);
  });
});
