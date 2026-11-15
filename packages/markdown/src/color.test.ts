import { describe, expect, it } from "vitest";
import { isHexColor, normalizeHexColor } from "./color.js";
import { TAG_NAME_MAX, VIEW_NAME_MAX, SPACE_NAME_MAX } from "./sharedContract.js";

describe("normalizeHexColor", () => {
  it("reads the 3, 4, 6 and 8 digit forms stored data may have, as full lower case", () => {
    expect(normalizeHexColor("#fff")).toBe("#ffffff");
    expect(normalizeHexColor("#F0a8")).toBe("#ff00aa88");
    expect(normalizeHexColor("#F5F1E8")).toBe("#f5f1e8");
    expect(normalizeHexColor(" #f5f1e8cc ")).toBe("#f5f1e8cc");
  });
  it("refuses everything else", () => {
    for (const bad of ["", "fff", "#ff", "#fffff", "#fffffff", "#ggg", "red", "#fff; } body{}", "#fffffffff"]) expect(normalizeHexColor(bad), bad).toBeNull();
  });
  it("isHexColor stays #rrggbb only (note, tag and edge colours)", () => {
    expect(isHexColor("#abcdef")).toBe(true);
    expect(isHexColor("#abc")).toBe(false);
    expect(isHexColor("#abcdef00")).toBe(false);
  });
});

describe("name limits", () => {
  it("a tag name may still be as long as the server has always taken; the others keep their own", () => {
    expect(TAG_NAME_MAX).toBe(200);
    expect(VIEW_NAME_MAX).toBe(80);
    expect(SPACE_NAME_MAX).toBe(80);
  });
});
