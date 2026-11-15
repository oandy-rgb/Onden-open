import { describe, expect, it } from "vitest";
import { graphemeCount } from "./graphemes.js";
import { SLUG_MAX, linkSlug, slugify } from "./slug.js";
import { linkNamesNote } from "./text.js";

describe("slugify", () => {
  it("keeps letters of any script and collapses dashes", () => {
    expect(slugify("  Hello,  World -- again ")).toBe("hello-world-again");
    expect(slugify("讀書 筆記")).toBe("讀書-筆記");
  });
  it("falls back when nothing is left", () => {
    expect(slugify("!!!")).toBe("node");
    expect(slugify("", "collection")).toBe("collection");
  });
  it("is at most SLUG_MAX characters, cut between characters, no dash at the end", () => {
    const long = slugify("讀書筆記 ".repeat(40));
    expect(graphemeCount(long)).toBeLessThanOrEqual(SLUG_MAX);
    expect(long.endsWith("-")).toBe(false);
    expect("讀書筆記-".repeat(40).startsWith(long)).toBe(true);
    // a letter keeps its combining mark: the cut never lands between them
    const marked = slugify("e\u0301".repeat(100).normalize("NFD"));
    expect(graphemeCount(marked)).toBe(SLUG_MAX);
    expect(marked).toBe("\u00e9".repeat(SLUG_MAX));
    expect(slugify(`${"a".repeat(SLUG_MAX - 1)} b`)).toBe("a".repeat(SLUG_MAX - 1));
  });
  it("is idempotent, also for a title it cuts", () => {
    for (const title of ["x".repeat(200), `${"ab ".repeat(60)}`, "हिंदी ".repeat(30), "a😀\u0301".repeat(50)]) {
      expect(slugify(slugify(title))).toBe(slugify(title));
    }
  });
});

describe("linkSlug", () => {
  it("is slugify without the cut", () => {
    expect(linkSlug("Hello World")).toBe(slugify("Hello World"));
    expect(linkSlug("x".repeat(200))).toBe("x".repeat(200));
    expect(linkSlug("!!!")).toBe("node");
  });
  it("a long title's link does not name another note whose slug is its first SLUG_MAX characters", () => {
    const a = `${"a".repeat(SLUG_MAX)} one`;
    const b = `${"a".repeat(SLUG_MAX)} two`;
    const noteA = { title: a, slug: slugify(a) };
    expect(linkNamesNote(b, noteA)).toBe(false);
    expect(linkNamesNote(a, noteA)).toBe(true);
    // a slug stored before the cap is still named by its title's slug
    expect(linkNamesNote(a, { title: "other", slug: linkSlug(a) })).toBe(true);
  });
});
