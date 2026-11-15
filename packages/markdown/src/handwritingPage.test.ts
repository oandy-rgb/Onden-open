import { describe, expect, it } from "vitest";
import { firstImage } from "./firstImage.js";
import { createHash } from "node:crypto";
import { handwritingPageMarkdown, handwritingPageNumber, withoutHandwritingPages } from "./handwritingPage.js";
import { encodeInk, inkPages, inkPageToSvg, INK_PAGE_RENDER_VERSION, inkToSvg, INK_PAPER_COLOR, type InkDocument } from "./ink.js";

const doc = (y: number): InkDocument => ({
  version: 1, erased: {}, page: { width: 1000 },
  strokes: [{ id: "s", color: "#15130d", size: 4, toolId: "pen", points: [[100, y], [300, y + 40], [500, y + 10]] }],
});
const pages = (n: number) => Array.from({ length: n }, (_, i) => handwritingPageMarkdown(i + 1, `/api/media/p${i + 1}.svg`)).join("\n\n");

describe("handwriting page markdown", () => {
  it("marks page N by the fragment of its address, with no alt of a language", () => {
    expect(handwritingPageMarkdown(2, "/api/media/b.svg")).toBe("![][ink-page-2]\n\n[ink-page-2]: /api/media/b.svg#ink-page-2");
    expect(handwritingPageNumber("/api/media/b.svg#ink-page-2")).toBe(2);
    // Only the mark: a user's own image is never a page, whatever its alt says.
    expect(handwritingPageNumber("/api/media/b.svg")).toBeNull();
    expect(handwritingPageNumber("/api/media/b.svg#ink-page-x")).toBeNull();
    expect(handwritingPageNumber(undefined)).toBeNull();
  });
  it("are never the note's own picture (cover, card image, share image)", () => {
    expect(firstImage(`words\n\n${pages(3)}`)).toBeUndefined();
    expect(firstImage(`![a photo](/api/media/p.png)\n\n${pages(2)}`)).toBe("/api/media/p.png");
  });
  it("keep pages up to a number, image line and address line together", () => {
    const md = `text\n\n${pages(3)}`;
    expect(withoutHandwritingPages(md, 1)).toBe(`text\n\n${pages(1)}`);
    expect(withoutHandwritingPages(md)).toBe("text");
    expect(withoutHandwritingPages("![x](y)\n\ntext", 1)).toBe("![x](y)\n\ntext");
  });
});

describe("inkPageToSvg", () => {
  it("draws the whole sheet on paper, as wide as the page", () => {
    const svg = inkPageToSvg({ size: { width: 1000, height: 1400 }, doc: doc(50) })!;
    expect(svg).toContain('viewBox="0 0 1000 ');
    expect(svg).toContain(`fill="${INK_PAPER_COLOR}"`);
    expect(svg.match(/height="(\d+)"/)![1]).toBe("320"); // short ink: not a 1400 sheet
  });
  it("is as tall as the ink plus a margin, at most the page", () => {
    expect(inkPageToSvg({ size: { width: 1000, height: 1400 }, doc: doc(900) })!).toMatch(/height="9[0-9]{2}"/);
    expect(inkPageToSvg({ size: { width: 1000, height: 500 }, doc: doc(900) })!).toContain('height="500"');
  });
  it("is null for an empty page and inkToSvg is unchanged (cropped, transparent)", () => {
    expect(inkPageToSvg({ size: { width: 1000, height: 1400 }, doc: { ...doc(0), strokes: [] } })).toBeNull();
    expect(inkToSvg(doc(50))).not.toContain(INK_PAPER_COLOR);
  });
});

describe("inkPages", () => {
  const value = encodeInk(doc(50));
  it("finds the pages without drawing them; draw() gives the picture", () => {
    const [page] = inkPages(value);
    expect(inkPages(value).map((p) => p.key)).toEqual([page!.key]);
  });
  it("skips a page with nothing on it; a page whose strokes are all erased is a blank sheet", () => {
    expect(inkPages(encodeInk({ ...doc(0), strokes: [] }))).toEqual([]);
    const erased = encodeInk({ ...doc(50), erased: { s: [[0, 1]] } } as InkDocument);
    for (const page of inkPages(erased)) expect(page.draw()).toContain(INK_PAPER_COLOR);
  });
  it("a note of several pages: every page with something on it, in page order", () => {
    const sheet = (key: string, d: InkDocument) => ({ key, background: { kind: "blank" }, size: { width: 1000, height: 1400 }, doc: d });
    const several = encodeInk({ ...doc(50), morePages: { version: 1, order: ["b", "page"], pages: { a: sheet("a", doc(80)), b: sheet("b", doc(60)), c: sheet("c", { ...doc(0), strokes: [] }) } } });
    expect(inkPages(several).map((p) => p.key)).toEqual(["b", "page", "a"]);
    expect(inkPages(several)[0]!.draw()).toBe(inkPageToSvg(sheet("b", doc(60))));
  });
  // A published page is named by the drawing and INK_PAGE_RENDER_VERSION, not by the picture.
  // Changing what the renderer draws changes this hash: bump the version, then update both.
  it("the picture of a fixed drawing is pinned to the render version", () => {
    const hash = createHash("sha256").update(inkPages(value)[0]!.draw()).digest("hex");
    expect([INK_PAGE_RENDER_VERSION, hash.slice(0, 16)]).toEqual([1, "52ae205999c4ee9f"]);
  });
});

describe("inkPages of a value that is not a drawing", () => {
  it("one page for a handwriting note; none for nothing or a PDF envelope", () => {
    expect(inkPages(encodeInk(doc(50)))).toHaveLength(1);
    expect(inkPages(null)).toEqual([]);
    expect(inkPages("{broken")).toEqual([]);
    expect(inkPages(JSON.stringify({ version: 1, pages: { 1: doc(50) } }))).toEqual([]);
  });
});
