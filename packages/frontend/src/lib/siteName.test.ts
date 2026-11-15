import { describe, expect, it } from "vitest";
import { siteName } from "./siteName";

describe("siteName", () => {
  it("prefers the brand", () => expect(siteName("My site", "Published title")).toBe("My site"));
  it("an empty or blank brand falls back to the published title (the empty-site <title> bug)", () => {
    expect(siteName("", "H07 Site")).toBe("H07 Site");
    expect(siteName("   ", "H07 Site")).toBe("H07 Site");
  });
  it("an absent brand and title fall back to Onden", () => {
    expect(siteName(undefined, "")).toBe("Onden");
    expect(siteName(null, undefined)).toBe("Onden");
  });
});
