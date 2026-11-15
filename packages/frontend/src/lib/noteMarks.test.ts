import { describe, expect, it } from "vitest";
import { isPinned, noteColor } from "./noteMarks";

describe("note pin and colour", () => {
  it("reads the reserved attributes the ⋯ menu writes", () => {
    expect(isPinned({ attrs: { _pinned: "true" } })).toBe(true);
    expect(isPinned({ attrs: {} })).toBe(false);
    expect(isPinned({})).toBe(false);
    expect(noteColor({ attrs: { _color: "#22c55e" } })).toBe("#22c55e");
  });
  it("ignores a colour that is not a #rrggbb swatch", () => {
    expect(noteColor({ attrs: { _color: "red" } })).toBeNull();
    expect(noteColor({ attrs: { _color: "#fff;background:url(x)" } })).toBeNull();
  });
});
