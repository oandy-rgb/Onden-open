import { describe, expect, it } from "vitest";
import { articlePrefix, withinPrefix } from "./articlePrefix.js";

describe("a source's article prefix", () => {
  it("is the path every article shares, on the origin most use", () => {
    expect(articlePrefix(["https://medium.com/@alice/one-1a", "https://medium.com/@alice/two-2b"])).toBe("https://medium.com/@alice/");
    expect(articlePrefix(["https://ex.com/2024/05/a", "https://ex.com/2023/11/b"])).toBe("https://ex.com/");
    expect(articlePrefix(["https://al.substack.com/p/a", "https://al.substack.com/p/b", "https://other.com/x/y"])).toBe("https://al.substack.com/p/");
  });

  it("one article: its directory; none readable: null", () => {
    expect(articlePrefix(["https://ex.com/blog/post"])).toBe("https://ex.com/blog/");
    expect(articlePrefix(["https://ex.com/post"])).toBe("https://ex.com/");
    expect(articlePrefix(["mailto:a@b.c", "not a url"])).toBeNull();
    expect(articlePrefix([])).toBeNull();
  });

  it("a link is the source's when it starts with the prefix; another writer on the platform is not", () => {
    const prefix = articlePrefix(["https://medium.com/@alice/one", "https://medium.com/@alice/two"]);
    expect(withinPrefix("https://medium.com/@alice/three#part", prefix)).toBe(true);
    expect(withinPrefix("https://medium.com/@bob/three", prefix)).toBe(false);
    expect(withinPrefix("https://evil.com/@alice/three", prefix)).toBe(false);
    expect(withinPrefix("javascript:alert(1)", prefix)).toBe(false);
    expect(withinPrefix("https://medium.com/@alice/x", null)).toBe(false);
  });
});
