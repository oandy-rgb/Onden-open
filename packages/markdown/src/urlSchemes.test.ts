import { describe, expect, it } from "vitest";
import { hasSafeLinkScheme, isHttpUrl, isSafeImageSrc, isSafeLinkHref, urlScheme } from "./urlSchemes.js";
import { sanitizeSchema } from "./sanitizeSchema.js";

describe("urlScheme", () => {
  it("reads the scheme the way a browser does", () => {
    expect(urlScheme("HTTPS://x")).toBe("https");
    expect(urlScheme(" java\tscript:x")).toBe("javascript");
    expect(urlScheme("\u0000javascript:x")).toBe("javascript");
    expect(urlScheme("/a:b")).toBeUndefined();
    expect(urlScheme("#frag")).toBeUndefined();
    expect(urlScheme("note.md")).toBeUndefined();
  });
});

describe("what a link may point at", () => {
  it("allows no scheme, http, https, mailto and tel — the same everywhere", () => {
    for (const url of ["/p", "#h", "a.md", "//host/x", "http://a", "https://a", "mailto:a@b", "tel:0912345678", "TEL:1"]) {
      expect(isSafeLinkHref(url), url).toBe(true);
    }
  });

  it("refuses every other scheme, however it is spelled", () => {
    for (const url of ["javascript:x", " JaVa\tScRiPt:x", "java\nscript:x", "\u0000javascript:x", "data:text/html,x", "vbscript:x", "ftp://a", "irc://a", "xmpp:a@b"]) {
      expect(isSafeLinkHref(url), url).toBe(false);
    }
  });

  it("hasSafeLinkScheme is true only for an explicit allowed scheme", () => {
    expect(hasSafeLinkScheme("tel:1")).toBe(true);
    expect(hasSafeLinkScheme("/p")).toBe(false);
    expect(hasSafeLinkScheme("data:image/png;base64,x")).toBe(false);
  });

  it("the sanitize schema offers links exactly these schemes", () => {
    expect(sanitizeSchema.protocols?.href).toEqual(["http", "https", "mailto", "tel"]);
    expect(sanitizeSchema.protocols?.src).toEqual(["http", "https", "data"]);
  });
});

describe("what a page may load as an image", () => {
  it("allows http(s) addresses and site-relative paths", () => {
    for (const url of ["http://a/x.png", "https://a/x.png", " /api/media/a.png ", "/x"]) expect(isSafeImageSrc(url), url).toBe(true);
  });

  it("refuses protocol-relative, other schemes, spaces inside and bare words", () => {
    for (const url of ["//host/x.png", "javascript:x", "data:image/png;base64,x", "https://a/x y.png", "x.png", "", "https://"]) {
      expect(isSafeImageSrc(url), url).toBe(false);
    }
  });

  it("isHttpUrl wants the // after the scheme", () => {
    expect(isHttpUrl(" https://a")).toBe(true);
    expect(isHttpUrl("https:a")).toBe(false);
    expect(isHttpUrl("ftp://a")).toBe(false);
  });
});
