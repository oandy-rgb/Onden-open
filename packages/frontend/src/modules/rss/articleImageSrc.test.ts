import { describe, expect, it } from "vitest";
import { articleImageSrc } from "./RssReaderPanel";

describe("articleImageSrc", () => {
  it("resolves a relative image against the article, not our host", () => {
    expect(articleImageSrc("/assets/images/wrong.png", "https://wiwi.blog/blog/wrong-word-order"))
      .toBe("https://wiwi.blog/assets/images/wrong.png");
    expect(articleImageSrc("img/a.png", "https://blog.test/posts/entry/")).toBe("https://blog.test/posts/entry/img/a.png");
  });

  it("leaves absolute, protocol-relative and data images alone, and anything without an article url", () => {
    expect(articleImageSrc("https://cdn.test/a.png", "https://blog.test/p")).toBe("https://cdn.test/a.png");
    expect(articleImageSrc("//cdn.test/a.png", "https://blog.test/p")).toBe("//cdn.test/a.png");
    expect(articleImageSrc("data:image/png;base64,AA", "https://blog.test/p")).toBe("data:image/png;base64,AA");
    expect(articleImageSrc("/a.png", null)).toBe("/a.png");
  });
});
