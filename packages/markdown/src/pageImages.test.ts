import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  PAGE_IMAGES_MAX_PER_PAGE, decodePageImages, emptyPageImages, encodePageImages, isPageImageSrc, isPageImagesReadOnly,
  mergePageImages, pageImagesOf, revertPageImagesConflicts, type PageImage, type PageImagesDoc,
} from "./pageImages.js";
import { INK_PAGE_KEY } from "./pageText.js";
import { mediaRefs } from "./mediaRefs.js";
import { PROPS_RUNS, PROPS_SEED } from "./test/helpers/propsConfig.js";

const SRC = "/api/media/0123456789abcdef0123456789abcdef.png";
const image = (id: string, over: Partial<PageImage> = {}): PageImage => ({
  id, x: 10, y: 20, w: 360, h: 240, src: SRC, alt: "photo", updated_at: "2026-10-28T00:00:00.000Z", ...over,
});
const doc = (pages: Record<string, PageImage[]>): string =>
  encodePageImages({ v: 1, pages: Object.fromEntries(Object.entries(pages).map(([k, images]) => [k, { images }])) });
const idsOf = (value: string, key = INK_PAGE_KEY) => decodePageImages(value).pages[key]?.images.map((i) => i.id).sort() ?? [];

describe("page_images format", () => {
  it("round-trips, with the page key of the handwriting page", () => {
    const value = doc({ [INK_PAGE_KEY]: [image("a", { alt: "週報 😀 👩‍👩‍👧" }), image("b", { x: -5.5, y: 1000.25 })] });
    expect(encodePageImages(decodePageImages(value))).toBe(value);
    expect(pageImagesOf(decodePageImages(value), INK_PAGE_KEY).map((i) => i.id)).toEqual(["a", "b"]); // list order = drawing order
    expect(pageImagesOf(decodePageImages(value), "pdf:1")).toEqual([]);
  });

  it("reads nothing, garbage and other shapes as no pictures", () => {
    for (const raw of [null, undefined, "", "not json", "[]", "{}", '{"v":1,"pages":[]}']) {
      expect(decodePageImages(raw)).toEqual(emptyPageImages());
    }
  });

  it("a picture's address is a media address of ours and nothing else", () => {
    for (const ok of [SRC, "/api/media/old-name_1.JPG"]) expect(isPageImageSrc(ok), ok).toBe(true);
    for (const bad of ["", "javascript:alert(1)", "data:image/png;base64,AAAA", "https://evil.example/x.png", "//evil.example/api/media/a.png",
      "/api/media/", "/api/media/../secret", "/api/media/a/b.png", "/api/media/a.png?x=1", "api/media/a.png", "/api/media/a.png ", 7, null]) {
      expect(isPageImageSrc(bad), String(bad)).toBe(false);
    }
  });

  it("the stored address is one the server's ownership claim finds in the attribute", () => {
    expect(mediaRefs(doc({ [INK_PAGE_KEY]: [image("a")] }))).toEqual(["0123456789abcdef0123456789abcdef.png"]);
  });

  it("repairs a malformed picture, drops one without an id or with a foreign address, and a repeated id", () => {
    const raw = JSON.stringify({ v: 1, pages: { page: { images: [
      { id: "a", x: "bad", y: NaN, w: -5, h: 0, src: SRC, alt: 7 },
      { id: "no-src" }, { id: "evil", src: "javascript:alert(1)" }, { id: "ext", src: "https://x.example/p.png" },
      { src: SRC }, { id: "a", src: SRC, alt: "second" }, "junk", null,
    ] } } });
    const images = decodePageImages(raw).pages.page!.images;
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ id: "a", x: 0, y: 0, w: 40, h: 40, src: SRC, alt: "" });
  });

  it("cuts a long description by characters, never in the middle of one, and keeps at most a page's worth", () => {
    const alt = "👩‍👩‍👧".repeat(300);
    const [first] = decodePageImages(doc({ page: [image("a", { alt })] })).pages.page!.images;
    expect([...new Intl.Segmenter().segment(first!.alt)]).toHaveLength(120);
    const many = Array.from({ length: PAGE_IMAGES_MAX_PER_PAGE + 20 }, (_, i) => image(`i${i}`));
    expect(decodePageImages(doc({ page: many })).pages.page!.images).toHaveLength(PAGE_IMAGES_MAX_PER_PAGE);
  });

  it("keeps fields it does not know, at every level", () => {
    const raw = JSON.stringify({ v: 1, extra: 1, pages: { page: { note: "n", images: [{ ...image("a"), rot: 12 }] } } });
    const round = JSON.parse(encodePageImages(decodePageImages(raw)));
    expect(round.extra).toBe(1);
    expect(round.pages.page.note).toBe("n");
    expect(round.pages.page.images[0].rot).toBe(12);
  });

  it("leaves out pages without pictures", () => {
    expect(JSON.parse(encodePageImages({ v: 1, pages: { page: { images: [] } } })).pages).toEqual({});
  });

  it("a newer version is read-only", () => {
    expect(isPageImagesReadOnly('{"v":2,"pages":{}}')).toBe(true);
    expect(isPageImagesReadOnly('{"v":1,"pages":{}}')).toBe(false);
    expect(isPageImagesReadOnly(null)).toBe(false);
  });
});

describe("mergePageImages", () => {
  const base = doc({ page: [image("a"), image("b")] });

  it("keeps different pictures added on both sides", () => {
    const merged = mergePageImages(base, doc({ page: [image("a"), image("b"), image("s")] }), doc({ page: [image("a"), image("b"), image("i")] }));
    expect(idsOf(merged.value)).toEqual(["a", "b", "i", "s"]);
    expect(merged.conflicts).toEqual([]);
  });

  it("takes the side that moved a picture, and each picture independently", () => {
    const stored = doc({ page: [image("a", { x: 111 }), image("b")] });
    const incoming = doc({ page: [image("a"), image("b", { w: 200, h: 100 })] });
    const images = decodePageImages(mergePageImages(base, stored, incoming).value).pages.page!.images;
    expect(images.find((i) => i.id === "a")!.x).toBe(111);
    expect(images.find((i) => i.id === "b")).toMatchObject({ w: 200, h: 100 });
  });

  it("both moved one picture: incoming wins and the conflict is reported", () => {
    const merged = mergePageImages(base, doc({ page: [image("a", { x: 1 }), image("b")] }), doc({ page: [image("a", { x: 2 }), image("b")] }));
    expect(decodePageImages(merged.value).pages.page!.images.find((i) => i.id === "a")!.x).toBe(2);
    expect(merged.conflicts).toEqual([{ pageKey: "page", id: "a" }]);
  });

  it("removed on one side, moved on the other: the move stays; removed and untouched: stays removed", () => {
    const removed = doc({ page: [image("b")] });
    const moved = doc({ page: [image("a", { y: 500 }), image("b")] });
    expect(idsOf(mergePageImages(base, removed, moved).value)).toEqual(["a", "b"]);
    expect(mergePageImages(base, removed, moved).conflicts).toEqual([{ pageKey: "page", id: "a" }]);
    expect(idsOf(mergePageImages(base, base, removed).value)).toEqual(["b"]);
    expect(mergePageImages(base, removed, base).conflicts).toEqual([]);
  });

  it("an empty or unreadable base keeps what both sides have; the pictures of other pages are not touched", () => {
    const stored = doc({ "pdf:2": [image("s")] });
    const incoming = doc({ page: [image("i")] });
    for (const b of [null, "", "garbage"]) {
      const merged = mergePageImages(b, stored, incoming);
      expect(idsOf(merged.value, "page")).toEqual(["i"]);
      expect(idsOf(merged.value, "pdf:2")).toEqual(["s"]);
    }
  });

  it("revert takes back only the conflicting picture", () => {
    const stored = doc({ page: [image("a", { x: 1 }), image("b")] });
    const incoming = doc({ page: [image("a", { x: 2 }), image("b"), image("n")] });
    const merged = mergePageImages(base, stored, incoming);
    const reverted = decodePageImages(revertPageImagesConflicts(merged.value, stored, merged.conflicts)).pages.page!.images;
    expect(reverted.find((i) => i.id === "a")!.x).toBe(1);
    expect(reverted.map((i) => i.id).sort()).toEqual(["a", "b", "n"]);
  });
});

describe("mergePageImages (random edits)", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const edit = fc.record({ kind: fc.constantFrom("add", "move", "remove"), id: fc.constantFrom(...ids), x: fc.integer({ min: 0, max: 900 }) });
  const apply = (value: string, edits: Array<{ kind: string; id: string; x: number }>): string => {
    const d: PageImagesDoc = decodePageImages(value);
    const images = [...(d.pages.page?.images ?? [])];
    for (const e of edits) {
      const at = images.findIndex((i) => i.id === e.id);
      if (e.kind === "remove") { if (at >= 0) images.splice(at, 1); }
      else if (at >= 0) images[at] = { ...images[at]!, x: e.x, updated_at: `t${e.x}` };
      else images.push(image(e.id, { x: e.x }));
    }
    return encodePageImages({ v: 1, pages: { page: { images } } });
  };
  const opts = { seed: PROPS_SEED, numRuns: PROPS_RUNS };
  const base = doc({ page: [image("a"), image("b")] });

  it("never loses a picture either side kept, never duplicates one", () => {
    fc.assert(fc.property(fc.array(edit, { maxLength: 6 }), fc.array(edit, { maxLength: 6 }), (storedEdits, incomingEdits) => {
      const stored = apply(base, storedEdits);
      const incoming = apply(base, incomingEdits);
      const merged = idsOf(mergePageImages(base, stored, incoming).value);
      expect(new Set(merged).size).toBe(merged.length);
      const baseIds = new Set(idsOf(base));
      const s = new Set(idsOf(stored)), i = new Set(idsOf(incoming));
      for (const id of ids) {
        if ((s.has(id) && !baseIds.has(id)) || (i.has(id) && !baseIds.has(id)) || (s.has(id) && i.has(id))) expect(merged).toContain(id);
        if (!s.has(id) && !i.has(id)) expect(merged).not.toContain(id);
      }
    }), opts);
  });

  it("merging a save into an unchanged store is the save", () => {
    fc.assert(fc.property(fc.array(edit, { maxLength: 6 }), (edits) => {
      const incoming = apply(base, edits);
      expect(mergePageImages(base, base, incoming).value).toBe(incoming);
      expect(mergePageImages(base, incoming, incoming).value).toBe(incoming);
    }), opts);
  });
});
