import { describe, expect, it } from "vitest";
import { servedLinkTarget } from "./sitePath.js";
import { HASHTAG_RE, linkNamesNote, scanWikilinks, soleWikilink, wikilinkBodies, wikilinkNames, wikilinkTarget } from "./text.js";

describe("note text grammar", () => {
  it("wikilinks: one line, first ] closes, targets drop alias and anchor", () => {
    expect(wikilinkBodies("[[a]] [[b|B]] [[c\n]] [[[[d]]")).toEqual(["a", "b|B", "[[d"]);
    expect(wikilinkTarget(" Page#Heading|alias ")).toBe("Page");
    expect(wikilinkTarget("#^block")).toBe("");
  });

  it("soleWikilink: the whole text is one link, and it is the link scanWikilinks finds", () => {
    expect(soleWikilink("[[a]]")).toEqual({ body: "a", target: "a", alias: null });
    expect(soleWikilink("[[Page#H|shown|more]]")).toEqual({ body: "Page#H|shown|more", target: "Page#H", alias: "shown|more" });
    expect(soleWikilink("[[a[[b]]")).toEqual({ body: "a[[b", target: "a[[b", alias: null });
    for (const text of ["", "[[]]", " [[a]]", "[[a]] ", "[[a]] [[b]]", "[[a]]]", "[[a]b]]", "[[a\nb]]", "![[a]]", "[[a", "a]]"]) {
      expect(soleWikilink(text), JSON.stringify(text)).toBeNull();
    }
    // Same answer as a scan, for anything that starts and ends like a link.
    for (const text of ["[[a]]", "[[a|b]]", "[[a]]]", "[[[a]]]", "[[a]b]]", "[[a\n]]", "[[a[[b]]"]) {
      const scanned = scanWikilinks(text);
      const whole = scanned.length === 1 && scanned[0]!.start === 0 && scanned[0]!.end === text.length;
      expect(soleWikilink(text) !== null, JSON.stringify(text)).toBe(whole);
    }
  });

  it("a link names a note by title, slug (the server's slug rule) or alias", () => {
    const note = { title: "Reading List", slug: "reading-list", aliases: ["待讀"] };
    expect(linkNamesNote("reading list", note)).toBe(true);
    expect(linkNamesNote("Reading  -- List!#top", note)).toBe(true);
    expect(linkNamesNote("待讀|看這", note)).toBe(true);
    expect(linkNamesNote("#top", note)).toBe(false);
    expect(linkNamesNote("Other", note)).toBe(false);
  });

  it("an Obsidian Excalidraw link names the imported drawing: title, then title without .excalidraw, then alias", () => {
    expect(wikilinkNames("2025-12-08 09.58.38.excalidraw")).toEqual(["2025-12-08 09.58.38.excalidraw", "2025-12-08 09.58.38"]);
    expect(wikilinkNames("Plain")).toEqual(["Plain"]);
    expect(wikilinkNames(".excalidraw")).toEqual([".excalidraw"]);
    const drawing = { title: "2025-12-08 09.58.38", slug: "2025-12-08-0958-38" };
    expect(linkNamesNote("2025-12-08 09.58.38.excalidraw", drawing)).toBe(true);
    expect(linkNamesNote("2025-12-08 09.58.38.Excalidraw|pic", drawing)).toBe(true);
    expect(linkNamesNote("2025-12-08 09.58.38", drawing)).toBe(true);
    // the exact title wins too, and the import's alias still names it
    expect(linkNamesNote("a.excalidraw", { title: "a.excalidraw" })).toBe(true);
    expect(linkNamesNote("Old.excalidraw", { title: "Renamed", aliases: ["Old.excalidraw"] })).toBe(true);
    expect(linkNamesNote("Other.excalidraw", drawing)).toBe(false);
    // the site's resolver reads links the same way
    const served = [{ id: "d", ...drawing }, { id: "o", title: "Other", slug: "other" }];
    expect(servedLinkTarget("2025-12-08 09.58.38.excalidraw", served)?.id).toBe("d");
    expect(servedLinkTarget("2025-12-08 09.58.38.EXCALIDRAW|pic", served)?.id).toBe("d");
    expect(servedLinkTarget("Nope.excalidraw", served)).toBeNull();
  });

  it("hashtags: any script, start of line or after a space, not in URLs", () => {
    const names = (text: string) => Array.from(text.matchAll(HASHTAG_RE), (m) => m[2]);
    expect(names("#研究 and #todo, x#no https://a.test#frag\n#todo")).toEqual(["研究", "todo", "todo"]);
  });
});
