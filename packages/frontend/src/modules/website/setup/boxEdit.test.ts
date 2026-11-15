import { describe, expect, it } from "vitest";
import { BOX_IDS, BOX_SPECS, NO_FACTS, defaultBoxes, picksOf, validateDesign, defaultDesign, type BoxPick } from "@onden/site";
import { canAddSlot, moveSlot, optionsFor, pickFor, putInSlot, removeSlot, samePick, targetPick } from "./boxEdit";

const pick = (widget: string, variant: string): BoxPick => ({ widget, variant });
const boxes = defaultBoxes();

describe("replacing what sits in a slot", () => {
  it("a single box takes one widget, or none (留空)", () => {
    expect(putInSlot(boxes, { box: "note.left", index: 0 }, pick("tree", "tree"))["note.left"]).toEqual(pick("tree", "tree"));
    expect(putInSlot(boxes, { box: "note.left", index: 0 }, null)["note.left"]).toBeNull();
    expect(putInSlot({ ...boxes, "note.left": null }, { box: "note.left", index: 0 }, pick("toc", "list"))["note.left"]).toEqual(pick("toc", "list"));
  });
  it("a box takes only its class: anything else changes nothing", () => {
    expect(putInSlot(boxes, { box: "home.hero", index: 0 }, pick("rss", "link"))).toBe(boxes);
    expect(putInSlot(boxes, { box: "foot", index: 0 }, pick("recent", "list"))).toBe(boxes);
  });
  it("a list slot is replaced in place; the others keep their place", () => {
    const next = putInSlot(boxes, { box: "home.list", index: 1 }, pick("featured", "cards"));
    expect(next["home.list"].map((p) => p.widget)).toEqual(["recent", "featured", "all"]);
  });
  it("an unknown look becomes the widget's first", () => {
    expect(putInSlot(boxes, { box: "home.list", index: 0 }, pick("all", "nope"))["home.list"][0]).toEqual(pick("all", "byYear"));
  });
});

describe("list boxes: add, move, remove, and their limits", () => {
  it("adds one slot at the end up to the box's limit, then no more", () => {
    let b = boxes;
    for (let i = 0; i < 10; i++) b = putInSlot(b, { box: "home.list", index: picksOf(b, "home.list").length }, pick("recent", "list"));
    expect(picksOf(b, "home.list")).toHaveLength(BOX_SPECS["home.list"].max);
    expect(canAddSlot(b, "home.list")).toBe(false);
    expect(canAddSlot(boxes, "home.list")).toBe(true);
    expect(canAddSlot(boxes, "note.left")).toBe(false); // a single box has no 「加一格」
  });
  it.each([["note.end", 4], ["tag.end", 3], ["foot", 4]] as const)("%s holds at most %i", (box, max) => {
    let b = boxes;
    const widget = box === "note.end" ? pick("backlinks", "quote") : box === "tag.end" ? pick("tagfeed", "rss") : pick("rss", "link");
    for (let i = 0; i < 9; i++) b = putInSlot(b, { box, index: picksOf(b, box).length }, widget);
    expect(picksOf(b, box)).toHaveLength(max);
  });
  it("moves a slot up or down, never past the ends", () => {
    const down = moveSlot(boxes, { box: "home.list", index: 0 }, 1);
    expect(down["home.list"].map((p) => p.widget)).toEqual(["topics", "recent", "all"]);
    expect(moveSlot(boxes, { box: "home.list", index: 0 }, -1)).toBe(boxes);
    expect(moveSlot(boxes, { box: "home.list", index: 2 }, 1)).toBe(boxes);
    expect(moveSlot(boxes, { box: "header", index: 0 }, 1)).toBe(boxes);
  });
  it("removes a slot", () => {
    expect(removeSlot(boxes, { box: "foot", index: 1 }).foot.map((p) => p.widget)).toEqual(["copyright", "scheme"]);
  });
  it("whatever the screen does, validateDesign has nothing left to change", () => {
    let b = boxes;
    for (const id of BOX_IDS) {
      for (const { widget } of optionsFor(id, NO_FACTS)) {
        for (const variant of widget.variants) b = putInSlot(b, { box: id, index: picksOf(b, id).length }, pick(widget.id, variant.id));
      }
      b = putInSlot(b, { box: id, index: 0 }, null);
    }
    expect(validateDesign({ ...defaultDesign(), boxes: b }).problems).toEqual([]);
  });
});

describe("the picker's options", () => {
  it("lists only what the box takes, in registry order, each marked ready or not", () => {
    expect(optionsFor("header", NO_FACTS).map((o) => o.widget.id)).toEqual(["nav"]);
    expect(optionsFor("note.left", NO_FACTS).map((o) => o.widget.id)).toEqual(["toc", "sidenotes", "tree"]);
    const section = optionsFor("home.list", NO_FACTS);
    expect(section.map((o) => o.widget.id)).toEqual(["intro", "latest", "recent", "all", "topics", "featured", "subscribe"]);
    expect(section.find((o) => o.widget.id === "subscribe")?.ready).toBe(true);
    expect(section.find((o) => o.widget.id === "intro")?.ready).toBe(false);
    expect(optionsFor("home.list", { ...NO_FACTS, introNote: true }).find((o) => o.widget.id === "intro")?.ready).toBe(true);
  });
  it("choosing the widget already there keeps its look; another starts with its first", () => {
    const all = optionsFor("home.list", NO_FACTS).find((o) => o.widget.id === "all")!.widget;
    expect(pickFor(all, pick("all", "maturity"))).toEqual(pick("all", "maturity"));
    expect(pickFor(all, pick("recent", "list"))).toEqual(pick("all", "byYear"));
    expect(pickFor(all, null)).toEqual(pick("all", "byYear"));
  });
  it("reads the slot and compares picks", () => {
    expect(targetPick(boxes, { box: "home.list", index: 5 })).toBeNull();
    expect(targetPick(boxes, { box: "home.list", index: 0 })).toEqual(pick("recent", "list"));
    expect(samePick(null, null)).toBe(true);
    expect(samePick(null, pick("a", "b"))).toBe(false);
    expect(samePick(pick("a", "b"), pick("a", "b"))).toBe(true);
  });
});
