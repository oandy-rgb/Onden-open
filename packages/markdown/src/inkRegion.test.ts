import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { clampInkRegion, embedMatches, formatInkRegion, parseEmbed, parseInkRegion, type InkRegion } from "./index.js";
import { INK_PAGE_UNITS, encodeInk, inkRegionToSvg, inkToSvg, type InkDocument } from "./ink.js";

const stroke = (id: string, points: Array<[number, number]>) => ({ id, color: "#1e1e1e", size: 4, toolId: "pen" as const, points });
const inkOf = (strokes: ReturnType<typeof stroke>[]): InkDocument => ({ version: 1, erased: {}, page: { width: INK_PAGE_UNITS }, strokes });
const doc = (strokes: ReturnType<typeof stroke>[], more?: Record<string, InkDocument>): InkDocument => ({
  version: 1, erased: {}, page: { width: INK_PAGE_UNITS }, strokes,
  ...(more ? { morePages: { version: 1, pages: Object.fromEntries(Object.entries(more).map(([key, d]) => [key, { key, background: { kind: "blank" }, size: { width: 1000, height: 1400 }, doc: d }])) } } : {}),
});
const region = (r: Partial<InkRegion> = {}): InkRegion => ({ page: "page", x: 100, y: 100, w: 300, h: 200, ...r });

describe("ink region syntax", () => {
  it("round-trips any page and rectangle (random)", () => {
    fc.assert(fc.property(
      fc.stringMatching(/^[A-Za-z0-9_-]{1,40}$/), fc.integer({ min: -9999, max: 9999 }), fc.integer({ min: -9999, max: 9999 }),
      fc.integer({ min: 1, max: 9999 }), fc.integer({ min: 1, max: 9999 }),
      (page, x, y, w, h) => {
        const r = { page, x, y, w, h };
        expect(parseInkRegion(formatInkRegion(r)!)).toEqual(r);
      }));
  });

  it("rounds to whole units and refuses a key it could not read back", () => {
    expect(formatInkRegion(region({ x: 10.4, y: 20.6, w: 30.2, h: 40.5 }))).toBe("ink=page@10,21,30,41");
    expect(formatInkRegion(region({ page: "a b" }))).toBeNull();
    expect(formatInkRegion(region({ x: Number.NaN }))).toBeNull();
  });

  it("only a whole, well-formed parameter is a region (anything else stays a label)", () => {
    for (const text of ["ink=page@1,2,0,5", "ink=page@1,2,3", "ink=@1,2,3,4", "ink=page@1,2,3,4 extra", "我的標題", "", "ink=pa ge@1,2,3,4"]) {
      expect(parseInkRegion(text), text).toBeNull();
    }
  });

  it("an embed carries it beside the note's name: special characters, Chinese, same-title notes", () => {
    for (const name of ["手寫筆記", "A & B (v2)", "筆記 #3?", "a/b", "ink=page@1,2,3,4"]) {
      const body = `${name}|${formatInkRegion(region())}`;
      const ref = parseEmbed(body);
      expect(ref.inkRegion).toEqual(region());
      expect(ref.label).toBeNull();
      expect(ref.target).toBe(name.split("#")[0]!.trim());
    }
    const [a, b] = embedMatches("![[甲|ink=page@1,2,30,40]] 與 ![[甲|ink=u-1@5,6,70,80]]");
    expect([a!.target, a!.inkRegion?.page, b!.target, b!.inkRegion?.page]).toEqual(["甲", "page", "甲", "u-1"]);
  });

  it("an older reader (the parser as it was before regions, copied here as a fixed sample) sees a label and the whole drawing", () => {
    // parseEmbed before this change: everything after the first `|` is the label; no region, no heading, no block.
    const BLOCK_ID = /#\^([A-Za-z0-9_-]+)$/;
    const oldParse = (body: string) => {
      const bar = body.indexOf("|");
      const link = bar === -1 ? body : body.slice(0, bar);
      const label = bar === -1 ? null : body.slice(bar + 1).trim() || null;
      const block = BLOCK_ID.exec(link);
      const [name = "", ...anchor] = (block ? link.slice(0, block.index) : link).split("#");
      return { target: name.trim(), blockId: block ? block[1] : null, heading: block ? null : anchor.join("#").trim() || null, label };
    };
    const old = oldParse("手寫筆記|ink=page@1,2,30,40");
    expect(old).toEqual({ target: "手寫筆記", blockId: null, heading: null, label: "ink=page@1,2,30,40" });
    // the old resolver draws a whole-note embed of a handwriting note as the drawing: no heading, no block
    expect(old.heading === null && old.blockId === null).toBe(true);
    // and the new parser agrees on everything but the label
    expect(parseEmbed("手寫筆記|ink=page@1,2,30,40")).toMatchObject({ target: old.target, heading: null, blockId: null, label: null });
    expect(parseEmbed("手寫筆記|我的標題")).toMatchObject({ inkRegion: null, label: "我的標題" });
  });

  it("clamps into the page", () => {
    const size = { width: 1000, height: 1400 };
    expect(clampInkRegion(region({ x: -50, y: -20, w: 200, h: 100 }), size)).toEqual(region({ x: 0, y: 0, w: 150, h: 80 }));
    expect(clampInkRegion(region({ x: 900, y: 1300, w: 500, h: 500 }), size)).toEqual(region({ x: 900, y: 1300, w: 100, h: 100 }));
    expect(clampInkRegion(region({ x: 2000, y: 0 }), size)).toBeNull();
    expect(clampInkRegion(region({ x: -400, w: 300 }), size)).toBeNull();
  });
});

describe("inkRegionToSvg", () => {
  const ink = encodeInk(doc(
    [stroke("in", [[120, 120], [200, 160], [300, 130]]), stroke("out", [[700, 700], [800, 760]]), stroke("cross", [[50, 150], [450, 150]])],
    { second: doc([stroke("s", [[10, 10], [90, 60]])]) },
  ));

  it("draws only what meets the rectangle, cropped to it by the viewBox", () => {
    const pic = inkRegionToSvg(ink, region());
    expect(pic.kind).toBe("picture");
    if (pic.kind !== "picture") return;
    expect((pic.svg.match(/<path /g) ?? []).length).toBe(2); // `in` and `cross`; `out` is left out
    expect(pic.svg).toContain('viewBox="100.0 100.0 300.0 200.0"');
    expect([pic.width, pic.height]).toEqual([300, 200]);
    expect(pic.svg).not.toBe(inkToSvg(ink));
  });

  it("addresses a page by its key, so adding pages changes nothing", () => {
    const pic = inkRegionToSvg(ink, region({ page: "second", x: 0, y: 0, w: 100, h: 100 }));
    expect(pic.kind).toBe("picture");
    expect(inkRegionToSvg(ink, region({ page: "gone" })).kind).toBe("page");
  });

  it("empty, off the page, an erased stroke, not a drawing", () => {
    expect(inkRegionToSvg(ink, region({ x: 500, y: 300 })).kind).toBe("empty");
    expect(inkRegionToSvg(ink, region({ x: 3000 })).kind).toBe("outside");
    expect(inkRegionToSvg(encodeInk({ ...doc([stroke("in", [[120, 120], [200, 160], [300, 130]])]), erased: { in: [[0, 2]] } }), region()).kind).toBe("empty");
    expect(inkRegionToSvg(null, region()).kind).toBe("notInk");
    expect(inkRegionToSvg("not json", region()).kind).toBe("notInk");
    expect(inkRegionToSvg(JSON.stringify({ version: 1, pages: { 1: inkOf([]) } }), region()).kind).toBe("notInk"); // a PDF's envelope
  });

  it("a region clamped from a negative corner still draws the part on the page", () => {
    const pic = inkRegionToSvg(ink, region({ x: -100, y: -100, w: 300, h: 300 }));
    expect(pic.kind).toBe("picture");
    if (pic.kind === "picture") expect(pic.svg).toContain('viewBox="0.0 0.0 200.0 200.0"');
  });

  it("the picture follows the drawing: a stroke added in the region shows", () => {
    const before = inkRegionToSvg(encodeInk(doc([stroke("a", [[120, 120], [200, 160]])])), region());
    const after = inkRegionToSvg(encodeInk(doc([stroke("a", [[120, 120], [200, 160]]), stroke("b", [[150, 200], [250, 220]])])), region());
    expect(before.kind === "picture" && after.kind === "picture" && after.svg !== before.svg).toBe(true);
  });
});

describe("plain-text readings of a quoted area", async () => {
  const { plainText, snippetPlainText, wikilinkLabel } = await import("./index.js");
  const { wikilinkShown, splitWikilink } = await import("./text.js");
  const ID = "onden://node/00000000-0000-4000-8000-000000000001";
  it("a quoted area reads as the note's name, never as its syntax", () => {
    const body = "手寫筆記|ink=page@100,300,400,160";
    expect(wikilinkLabel(body)).toBe("手寫筆記");
    expect(wikilinkShown(body)).toBe("手寫筆記");
    expect(splitWikilink(body).alias).toBeNull();
    expect(snippetPlainText("![[手寫筆記|ink=page@100,300,400,160]] 之後")).not.toContain("ink=");
    expect(plainText("![[手寫筆記|ink=page@100,300,400,160]]")).not.toContain("ink=");
  });
  it("a note named by id reads as a plain word, not a URL; a real label stays", () => {
    expect(wikilinkLabel(`${ID}|ink=page@1,2,30,40`)).toBe("✎");
    expect(wikilinkLabel(`${ID}|我的圖`)).toBe("我的圖");
    expect(wikilinkLabel("手寫筆記|我的圖")).toBe("我的圖");
  });
});

describe("summaries and one-line labels of a note that begins with a quoted area", async () => {
  const { noteSummary, plainInline } = await import("./index.js");
  const text = "![[手寫筆記|ink=page@100,300,400,160]]\n\n後面";
  it("never show the syntax", () => {
    expect(noteSummary(text, { title: "T", maxLen: 80 })).not.toMatch(/ink=|@\d/);
    expect(plainInline("![[手寫筆記|ink=page@100,300,400,160]]")).not.toMatch(/ink=|@\d/);
  });
});

describe("what is really inside the area", () => {
  const ring = (cx: number, cy: number, r: number) => stroke("ring", Array.from({ length: 41 }, (_, i) => [cx + r * Math.cos((i / 40) * 2 * Math.PI), cy + r * Math.sin((i / 40) * 2 * Math.PI)] as [number, number]));
  it("a big circle or an L around the area leaves it empty, not a blank frame", () => {
    const small = region({ x: 400, y: 400, w: 100, h: 100 });
    expect(inkRegionToSvg(encodeInk(doc([ring(450, 450, 300)])), small).kind).toBe("empty");
    expect(inkRegionToSvg(encodeInk(doc([stroke("L", [...Array.from({ length: 31 }, (_, i) => [300, 300 + i * 10] as [number, number]), ...Array.from({ length: 30 }, (_, i) => [310 + i * 10, 600] as [number, number])])])), small).kind).toBe("empty");
    expect(inkRegionToSvg(encodeInk(doc([ring(450, 450, 300)])), region({ x: 100, y: 100, w: 400, h: 400 })).kind).toBe("picture"); // the ring does pass through this one
  });

  it("text boxes and pictures count, and are drawn (pictures only where asked)", () => {
    const text = JSON.stringify({ v: 1, pages: { page: { boxes: [{ id: "t", x: 120, y: 120, w: 200, text: "公式", size: 22, color: "#1e1e1e", align: "left", updated_at: "" }] } } });
    const images = JSON.stringify({ v: 1, pages: { page: { images: [{ id: "i", x: 200, y: 200, w: 100, h: 80, src: "/api/media/0123456789abcdef0123456789abcdef.webp", alt: "", updated_at: "" }] } } });
    const empty = encodeInk(doc([]));
    expect(inkRegionToSvg(empty, region()).kind).toBe("empty");
    const withText = inkRegionToSvg(empty, region(), { text });
    expect(withText.kind === "picture" && withText.svg.includes("公式")).toBe(true);
    expect(inkRegionToSvg(empty, region(), { images }).kind).toBe("empty"); // not asked for
    const withImage = inkRegionToSvg(empty, region(), { images, withImages: true });
    expect(withImage.kind === "picture" && withImage.svg).toContain('<image href="/api/media/');
    expect(inkRegionToSvg(empty, region({ x: 600, y: 600 }), { text, images, withImages: true }).kind).toBe("empty");
  });

  it("a picture's address is reached through the host's own rule (an API on another origin)", () => {
    const images = JSON.stringify({ v: 1, pages: { page: { images: [{ id: "i", x: 200, y: 200, w: 100, h: 80, src: "/api/media/0123456789abcdef0123456789abcdef.webp", alt: "", updated_at: "" }] } } });
    const shown = inkRegionToSvg(encodeInk(doc([])), region(), { images, withImages: true, imageSrc: (src) => `https://api.example.com:8080${src}?a=1&b=2` });
    expect(shown.kind === "picture" && shown.svg).toContain('href="https://api.example.com:8080/api/media/0123456789abcdef0123456789abcdef.webp?a=1&amp;b=2"');
  });

  it("the first page has no bottom edge of its own: an area low on the page is empty, not off it", () => {
    expect(inkRegionToSvg(encodeInk(doc([stroke("a", [[10, 10], [60, 40]])])), region({ y: 1800 })).kind).toBe("empty");
  });
});
