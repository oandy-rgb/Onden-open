import { describe, expect, it } from "vitest";
import { bundleMedia, isMediaId, mediaRefs, mediaSrc, mediaUrl, rewriteMediaRefs } from "./mediaRefs.js";

const ID = "0123456789abcdef0123456789abcdef.webp";

describe("mediaRefs", () => {
  it("finds every distinct id in markdown, JSON and HTML", () => {
    const text = `![a](/api/media/${ID}) {"src":"/api/media/b.png"} <img src="/api/media/${ID}">`;
    expect(mediaRefs(text)).toEqual([ID, "b.png"]);
  });

  it("keeps older upload names", () => {
    expect(mediaRefs("/api/media/1700000000000-photo_1.jpg")).toEqual(["1700000000000-photo_1.jpg"]);
  });

  it("never yields an id that leaves the media directory", () => {
    for (const hostile of ["/api/media/../x", "/api/media/..", "/api/media/.", "/api/media/./x",
      "/api/media/.import-1.tmp", "/api/media/..%2Fx", "/api/media/%2e%2e", "/api/media/"]) {
      expect(mediaRefs(hostile), hostile).toEqual([]);
    }
    expect(mediaRefs("/api/media/a/../../etc/passwd")).toEqual(["a"]);
  });

  it("stops the id at a query, fragment, quote or sentence end", () => {
    expect(mediaRefs("/api/media/a.png?w=100")).toEqual(["a.png"]);
    expect(mediaRefs("/api/media/a.png#page=2")).toEqual(["a.png"]);
    expect(mediaRefs(`"/api/media/a.png"`)).toEqual(["a.png"]);
    expect(mediaRefs("see /api/media/a.png.")).toEqual(["a.png"]);
    expect(mediaRefs("(/api/media/a.png)")).toEqual(["a.png"]);
  });

  it("reads references behind an origin", () => {
    expect(mediaRefs("https://notes.example:8443/api/media/a.png")).toEqual(["a.png"]);
    expect(mediaRefs("http://[::1]/api/media/a.png")).toEqual(["a.png"]);
    expect(mediaRefs("//notes.example/api/media/a.png")).toEqual(["a.png"]);
    expect(mediaRefs("https://user@notes.example/api/media/a.png")).toEqual(["a.png"]);
  });

  it("does not read /api/media/ inside a longer path or after a partial origin", () => {
    for (const text of ["https://h/sub/api/media/a.png", "./api/media/a.png", "x/api/media/a.png",
      "ftp://h/api/media/a.png", "xhttps://h/api/media/a.png"]) {
      expect(mediaRefs(text), text).toEqual([]);
    }
  });

  it("ignores look-alikes", () => {
    expect(mediaRefs("/api/mediax/a.png /api/Media/a.png api/media/a.png")).toEqual([]);
  });
});

describe("rewriteMediaRefs", () => {
  it("replaces each reference, origin included, and leaves the query", () => {
    const text = "![](https://host/api/media/a.png?w=1) ![](/api/media/b.png)";
    expect(rewriteMediaRefs(text, (id) => `media/${id}`)).toBe("![](media/a.png?w=1) ![](media/b.png)");
  });

  it("replaces a scheme-relative or userinfo URL whole, and leaves a sub-path URL alone", () => {
    const bundle = (text: string) => rewriteMediaRefs(text, (id) => `media/${id}`);
    expect(bundle("![](//h/api/media/a.png)")).toBe("![](media/a.png)");
    expect(bundle("![](https://u@h/api/media/a.png)")).toBe("![](media/a.png)");
    expect(bundle("![](https://h/sub/api/media/a.png)")).toBe("![](https://h/sub/api/media/a.png)");
  });

  it("leaves hostile references untouched", () => {
    const text = "![](/api/media/../secret) ![](/api/media/.hidden)";
    expect(rewriteMediaRefs(text, (id) => `./attachments/${id}`)).toBe(text);
  });

  it("keeps a reference when the callback returns the match", () => {
    const text = "x /api/media/a.png y";
    expect(rewriteMediaRefs(text, (_id, match) => match)).toBe(text);
  });
});

describe("bundleMedia", () => {
  it("rewrites every reference, frontmatter included, and lists each id once", () => {
    const text = "---\ncover: \"/api/media/a.png\"\n---\n![](/api/media/a.png) [paper](https://h/api/media/b.pdf)";
    expect(bundleMedia(text, (id) => `./attachments/${id}`)).toEqual({
      content: "---\ncover: \"./attachments/a.png\"\n---\n![](./attachments/a.png) [paper](./attachments/b.pdf)",
      ids: ["a.png", "b.pdf"],
    });
  });
});

describe("isMediaId / mediaUrl", () => {
  it("accepts minted and older names, refuses paths", () => {
    expect(isMediaId(ID)).toBe(true);
    expect(isMediaId("1700-a_b.png")).toBe(true);
    for (const bad of ["", ".", "..", "../x", "a/b", ".hidden", "a.png.", "a b.png", "a.png?x"]) {
      expect(isMediaId(bad), bad).toBe(false);
    }
    expect(mediaUrl(ID)).toBe(`/api/media/${ID}`);
  });
});

describe("mediaSrc", () => {
  it("passes through absolute, site-relative and safe inline values", () => {
    expect(mediaSrc("https://cdn.example/a.png")).toBe("https://cdn.example/a.png");
    expect(mediaSrc("http://cdn.example/a.png", { apiBase: "https://api" })).toBe("http://cdn.example/a.png");
    expect(mediaSrc("/api/media/a.png", { apiBase: "https://api" })).toBe("/api/media/a.png");
    expect(mediaSrc("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(mediaSrc("blob:https://x/1")).toBe("blob:https://x/1");
  });

  it("serves a bare id through the API", () => {
    expect(mediaSrc("a.png")).toBe("/api/media/a.png");
    expect(mediaSrc(" a.png ", { apiBase: "https://api.example" })).toBe("https://api.example/api/media/a.png");
    expect(mediaSrc("a.pdf#page=2")).toBe("/api/media/a.pdf#page=2");
  });

  it("reads a bundle path against the bundle, or as the id it names", () => {
    expect(mediaSrc("media/a.png", { bundle: "https://site.example/proj/page/" }))
      .toBe("https://site.example/proj/page/media/a.png");
    expect(mediaSrc("media/a.png", { apiBase: "https://api" })).toBe("https://api/api/media/a.png");
  });

  it("refuses values that are not media", () => {
    for (const bad of ["", "   ", "javascript:alert(1)", "data:text/html,<script>", "../x.png",
      "./a.png", "a/b.png", "media/../x", ".hidden", "vbscript:x", "//evil.com/x.png", "/\\evil.com/x.png"]) {
      expect(mediaSrc(bad, { apiBase: "https://api", bundle: "https://site/" }), bad).toBe("");
    }
  });
});
