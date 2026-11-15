import { describe, expect, it } from "vitest";
import { shareImageUrl } from "./siteShareImage";

const ORIGIN = "https://example.com";

describe("shareImageUrl", () => {
  it("makes a stored media value absolute on the site's origin", () => {
    expect(shareImageUrl("/api/media/ab12.png", ORIGIN)).toBe("https://example.com/api/media/ab12.png");
    expect(shareImageUrl("ab12.png", ORIGIN)).toBe("https://example.com/api/media/ab12.png");
  });

  it("keeps an image on another host as it is", () => {
    expect(shareImageUrl("https://cdn.test/a.jpg", ORIGIN)).toBe("https://cdn.test/a.jpg");
  });

  it("gives nothing for a picture a crawler cannot load", () => {
    expect(shareImageUrl(undefined, ORIGIN)).toBeUndefined();
    expect(shareImageUrl("", ORIGIN)).toBeUndefined();
    expect(shareImageUrl("data:image/png;base64,AAAA", ORIGIN)).toBeUndefined();
    expect(shareImageUrl("blob:https://example.com/x", ORIGIN)).toBeUndefined();
    expect(shareImageUrl("javascript:alert(1)", ORIGIN)).toBeUndefined();
    expect(shareImageUrl("//evil.test/x.png", ORIGIN)).toBeUndefined();
  });
});
