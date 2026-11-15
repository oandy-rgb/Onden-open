import { describe, it, expect } from "vitest";
import { shapeOf } from "./helpers/wireShape.js";

// The recorder behind the API contract file (apiContract.integration.test.ts):
// shapes carry keys and kinds, never values, and merge several samples.
describe("wireShape", () => {
  it("records kinds, not values", () => {
    expect(shapeOf({ id: "a", n: 1, ok: true, gone: null })).toEqual({ gone: "null", id: "string", n: "number", ok: "boolean" });
  });

  it("merges samples: a key missing from one is optional, differing kinds union", () => {
    expect(shapeOf({ id: "a", parent: null }, { id: "b", parent: "x", note: "n" }))
      .toEqual({ id: "string", "note?": "string", parent: "null|string" });
  });

  it("merges array elements and marks an empty array as unknown", () => {
    expect(shapeOf({ rows: [{ a: 1 }, { a: 2, b: "x" }], none: [] })).toEqual({ none: ["unknown"], rows: [{ a: "number", "b?": "string" }] });
  });

  it("is independent of key order and of the values", () => {
    expect(shapeOf({ b: 1, a: "x" })).toEqual(shapeOf({ a: "other", b: 2 }));
    expect(JSON.stringify(shapeOf({ b: 1, a: "x" }))).toBe(JSON.stringify(shapeOf({ a: "y", b: 3 })));
  });

  it("keeps a nullable object, and collapses data-keyed maps", () => {
    expect(shapeOf({ tag_schema: null }, { tag_schema: { fields: [] } })).toMatchObject({ tag_schema: { $kinds: "null|object" } });
    const a = shapeOf({ attrs: { alpha: "1" }, buckets: { "0a": 1 }, byId: { "11111111-1111-1111-1111-111111111111": { x: 1 } } });
    const b = shapeOf({ attrs: { beta: "2", gamma: "3" }, buckets: { ff: 2 }, byId: { "22222222-2222-2222-2222-222222222222": { x: 2 } } });
    expect(a).toEqual(b);
  });
});
