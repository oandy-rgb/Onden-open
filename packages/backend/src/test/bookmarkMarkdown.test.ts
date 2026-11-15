// A remote page's title, description and image address must not add structure
// to the bookmark note (a hostile og:description with line breaks used to turn
// into tracking images, fake links and [[wikilinks]] in the user's note).

import { describe, it, expect } from "vitest";
import { bookmarkMarkdown, safeHttpDestination } from "../services/bookmarkMarkdown.js";

const base = { title: "T", description: "D", imageUrl: null, url: "https://example.com/a" };

describe("bookmarkMarkdown", () => {
  it("keeps the description on one quoted line", () => {
    const md = bookmarkMarkdown({ ...base, description: "first\n\n![](https://track.example/p.png)\n[[Secret]]\n# heading" });
    const quote = md.split("\n\n").filter((p) => p.startsWith(">"));
    expect(quote).toHaveLength(1);
    expect(quote[0]).not.toContain("\n");
    // Nothing in it can still parse as an image, a wikilink or a heading.
    expect(quote[0]).toContain("\\!\\[\\](https://track.example/p.png)".replace("(", "\\(").replace(")", "\\)"));
    expect(quote[0]).toContain("\\[\\[Secret\\]\\]");
    expect(quote[0]).toContain("\\# heading");
  });

  it("cannot rewrite the link through the title", () => {
    const md = bookmarkMarkdown({ ...base, title: "x](https://evil.example)[y" });
    const link = md.trim().split("\n\n").at(-1)!;
    expect(link).toBe("[x\\]\\(https://evil.example\\)\\[y](https://example.com/a)");
  });

  it("accepts an http(s) image address only, with parentheses encoded", () => {
    expect(bookmarkMarkdown({ ...base, imageUrl: "https://cdn.example/a(1).png" })).toContain("![](https://cdn.example/a%281%29.png)");
    for (const bad of ["javascript:alert(1)", "data:image/svg+xml,<svg/>", "//cdn.example/a.png", "not a url"]) {
      expect(bookmarkMarkdown({ ...base, imageUrl: bad })).not.toContain("![]");
    }
  });

  it("keeps the saved address whole when it contains a parenthesis", () => {
    expect(bookmarkMarkdown({ ...base, url: "https://en.wikipedia.org/wiki/Onden_(tool)" }))
      .toContain("](https://en.wikipedia.org/wiki/Onden_%28tool%29)");
    expect(safeHttpDestination("ftp://x/y")).toBeNull();
  });

  it("an ordinary page reads as before", () => {
    expect(bookmarkMarkdown({ ...base, imageUrl: "https://cdn.example/a.png" }))
      .toBe("![](https://cdn.example/a.png)\n\n> D\n\n[T](https://example.com/a)\n");
  });
});
