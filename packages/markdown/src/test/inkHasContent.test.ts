import { describe, expect, it } from "vitest";
import { inkHasContent } from "../ink.js";

const base = { strokes: [] as never[], shapes: undefined as undefined | never[] };

describe("inkHasContent", () => {
  it("is false for an empty drawing, with or without a shapes array", () => {
    expect(inkHasContent(base)).toBe(false);
    expect(inkHasContent({ strokes: [], shapes: [] })).toBe(false);
  });
  it("counts strokes", () => {
    expect(inkHasContent({ strokes: [{}] as never[] })).toBe(true);
  });
  it("counts shapes on their own", () => {
    expect(inkHasContent({ strokes: [], shapes: [{}] as never[] })).toBe(true);
  });
});
