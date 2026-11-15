import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { INK_REGION_MIN, parseInkRegion, type InkRegion } from "@onden/markdown/ink";
import { embedMatches } from "@onden/markdown";
import { inkRegionEmbedText, titleNamesNote, moveRegion, regionFromDrag, resizeRegion } from "../lib/inkRegionQuote";

const size = { width: 1000, height: 1400 };
const region: InkRegion = { page: "p", x: 100, y: 200, w: 300, h: 200 };
const inside = (r: InkRegion) => r.x >= 0 && r.y >= 0 && r.x + r.w <= size.width && r.y + r.h <= size.height && r.w >= INK_REGION_MIN && r.h >= INK_REGION_MIN;

describe("the frame", () => {
  it("a drag in any direction makes the same frame, kept on the page; a speck makes none", () => {
    expect(regionFromDrag("p", { x: 400, y: 400 }, { x: 100, y: 200 }, size)).toEqual({ page: "p", x: 100, y: 200, w: 300, h: 200 });
    expect(regionFromDrag("p", { x: -50, y: -50 }, { x: 1200, y: 1500 }, size)).toEqual({ page: "p", x: 0, y: 0, w: 1000, h: 1400 });
    expect(regionFromDrag("p", { x: 10, y: 10 }, { x: 12, y: 300 }, size)).toBeNull();
    expect(regionFromDrag("p", { x: 10, y: 10 }, { x: 10, y: 10 }, size)).toBeNull();
  });

  it("a corner pulled anywhere keeps the opposite corner, the minimum size and the page (random)", () => {
    fc.assert(fc.property(fc.constantFrom("nw", "ne", "sw", "se" as const), fc.integer({ min: -500, max: 1500 }), fc.integer({ min: -500, max: 2000 }), (corner, x, y) => {
      const next = resizeRegion(region, corner, { x, y }, size);
      expect(inside(next)).toBe(true);
      const west = corner === "nw" || corner === "sw", north = corner === "nw" || corner === "ne";
      expect(west ? next.x + next.w : next.x).toBe(west ? region.x + region.w : region.x);
      expect(north ? next.y + next.h : next.y).toBe(north ? region.y + region.h : region.y);
    }));
  });

  it("moving keeps size and stays on the page", () => {
    expect(moveRegion(region, 5000, -5000, size)).toEqual({ ...region, x: 700, y: 0 });
    expect(moveRegion(region, 10, 10, size)).toEqual({ ...region, x: 110, y: 210 });
  });
});

describe("the reference that is copied", () => {
  it("names the note by title and reads back as the same area", () => {
    const text = inkRegionEmbedText({ id: "11111111-1111-4111-8111-111111111111", title: "手寫 筆記", titleNamesNote: true }, region)!;
    expect(text).toBe("![[手寫 筆記|ink=p@100,200,300,200]]");
    const [m] = embedMatches(text);
    expect(m!.target).toBe("手寫 筆記");
    expect(m!.inkRegion).toEqual(region);
  });

  it("a title that cannot be written in a link, or that two notes share, is named by id", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    for (const note of [{ id, title: "a|b", titleNamesNote: true }, { id, title: "x [y]", titleNamesNote: true }, { id, title: "同名", titleNamesNote: false }, { id, title: "", titleNamesNote: true }]) {
      const text = inkRegionEmbedText(note, region)!;
      expect(text).toBe(`![[onden://node/${id}|ink=p@100,200,300,200]]`);
      expect(parseInkRegion(embedMatches(text)[0]!.body.split("|")[1]!)).toEqual(region);
    }
    expect(inkRegionEmbedText({ id, title: "t", titleNamesNote: true }, { ...region, page: "bad key" })).toBeNull();
  });
});

describe("whether the title names the note (the rule embeds are read with)", () => {
  const n = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, title, slug: title.toLowerCase(), markdown: "", node_type: "content", ...extra }) as never;
  const sketch = n("1", "Sketch");
  it("a title nobody else can take", () => { expect(titleNamesNote(sketch, [sketch, n("2", "Other")])).toBe(true); });
  it("the same title, another case, a slug or an alias of another note all take it away", () => {
    expect(titleNamesNote(sketch, [sketch, n("2", "Sketch")])).toBe(false);
    expect(titleNamesNote(sketch, [n("2", "sketch"), sketch])).toBe(false);
    expect(titleNamesNote(sketch, [n("2", "Else", { slug: "sketch" }), sketch])).toBe(false);
    expect(titleNamesNote(sketch, [n("2", "Else", { attrs: { aliases: JSON.stringify(["Sketch"]) } }), sketch])).toBe(false);
  });
  it("the text that would be copied then names the note by id, and the title form resolves back to the note otherwise", async () => {
    const { resolveEmbed } = await import("../lib/embeds");
    const id = "11111111-1111-4111-8111-111111111111";
    const text = inkRegionEmbedText({ id, title: "Sketch", titleNamesNote: titleNamesNote(sketch, [n("2", "sketch"), sketch]) }, { page: "p", x: 1, y: 2, w: 30, h: 40 })!;
    expect(text).toContain("onden://node/");
    const mine = n(id, "Sketch");
    expect(resolveEmbed(embedMatches(text)[0]!.body, null, [n("2", "sketch"), mine])).toMatchObject({ kind: "note", node: { id } });
    const plain = inkRegionEmbedText({ id: "1", title: "Sketch", titleNamesNote: true }, { page: "p", x: 1, y: 2, w: 30, h: 40 })!;
    expect(resolveEmbed(embedMatches(plain)[0]!.body, null, [sketch, n("2", "Other")])).toMatchObject({ kind: "note", node: { id: "1" } });
  });
});
