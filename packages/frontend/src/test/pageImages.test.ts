// The pictures on a page, below the UI: the controller (undo stack, saving, the
// drag that previews), the geometry (where a picture goes, how it resizes) and
// which stack undo goes to.
import { describe, expect, it, vi } from "vitest";
import { decodePageImages, encodePageImages, type PageImage } from "@onden/markdown/page-images";
import {
  PageImagesController, centeredIn, insertedSize, moved, resizedFromCorner, undoTarget, visiblePageBand,
} from "../lib/pageImages";

const SRC = "/api/media/0123456789abcdef0123456789abcdef.png";
const NEW = { x: 100, y: 200, w: 300, h: 200, src: SRC, alt: "photo" };
const image = (id: string, over: Partial<PageImage> = {}): PageImage => ({ id, ...NEW, updated_at: "2026-10-28T00:00:00.000Z", ...over });
const valueOf = (...images: PageImage[]) => encodePageImages({ v: 1, pages: { page: { images } } });

function setup(initial: string | null = null, extra: { readOnly?: boolean } = {}) {
  const save = vi.fn<(value: string, base: string | null) => void>();
  let n = 0;
  const controller = new PageImagesController({ initial, save, newId: () => `i${++n}`, now: () => new Date("2026-10-28T12:00:00.000Z"), ...extra });
  const saved = (call = save.mock.calls.length - 1) => decodePageImages(save.mock.calls[call]![0]).pages.page?.images ?? [];
  return { controller, save, saved };
}

describe("PageImagesController", () => {
  it("adding a picture selects it, saves at once with the value it was made from, and is one undo step", () => {
    const { controller, save, saved } = setup();
    const added = controller.addImage("page", NEW)!;
    expect(added).toMatchObject({ id: "i1", ...NEW, updated_at: "2026-10-28T12:00:00.000Z" });
    expect(controller.getSelection()).toEqual({ pageKey: "page", id: "i1" });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![1]).toBeNull(); // the note had none
    expect(saved()).toHaveLength(1);
    expect(controller.canUndo).toBe(true);
    expect(controller.undo()).toBe(true);
    expect(controller.images("page")).toEqual([]);
    expect(saved()).toEqual([]); // the undo is saved too
    expect(controller.getSelection()).toBeNull(); // the selected picture is gone
    expect(controller.redo()).toBe(true);
    expect(controller.images("page")).toHaveLength(1);
  });

  it("each save carries the one before it as its base", () => {
    const { controller, save } = setup(valueOf(image("a")));
    controller.removeImage("page", "a");
    controller.addImage("page", NEW);
    expect(save.mock.calls[0]![1]).toBe(valueOf(image("a")));
    expect(save.mock.calls[1]![1]).toBe(save.mock.calls[0]![0]);
  });

  it("a drag previews without saving or stacking, and its release is one step and one save", () => {
    const { controller, save, saved } = setup(valueOf(image("a")));
    controller.preview("page", "a", { x: 120, y: 210 });
    controller.preview("page", "a", { x: 150, y: 260 });
    expect(controller.image("page", "a")).toMatchObject({ x: 150, y: 260 });
    expect(save).not.toHaveBeenCalled();
    controller.setRect("page", "a", { x: 150, y: 260, w: 300, h: 200 });
    expect(save).toHaveBeenCalledTimes(1);
    expect(saved()[0]).toMatchObject({ x: 150, y: 260 });
    controller.undo();
    expect(controller.image("page", "a")).toMatchObject({ x: 100, y: 200 }); // the whole drag, not a piece of it
    expect(controller.canUndo).toBe(false);
  });

  it("a cancelled drag puts the picture back and leaves no step", () => {
    const { controller, save } = setup(valueOf(image("a")));
    controller.preview("page", "a", { x: 500, y: 500 });
    controller.cancelPreview();
    expect(controller.image("page", "a")).toMatchObject({ x: 100, y: 200 });
    expect(controller.canUndo).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it("setRect with nothing changed is not a step, and a picture is never smaller than the minimum", () => {
    const { controller, save } = setup(valueOf(image("a")));
    controller.setRect("page", "a", { x: 100, y: 200 });
    expect(controller.canUndo).toBe(false);
    expect(save).not.toHaveBeenCalled();
    controller.setRect("page", "a", { w: 1, h: 1 });
    expect(controller.image("page", "a")).toMatchObject({ w: 40, h: 40 });
  });

  it("removing is a step and a save; a new edit after an undo drops the redo", () => {
    const { controller, saved } = setup(valueOf(image("a"), image("b")));
    controller.removeImage("page", "a");
    expect(saved().map((i) => i.id)).toEqual(["b"]);
    controller.undo();
    expect(saved().map((i) => i.id)).toEqual(["a", "b"]); // back in its place
    expect(controller.canRedo).toBe(true);
    controller.removeImage("page", "b");
    expect(controller.canRedo).toBe(false);
  });

  it("a later picture is drawn over an earlier one (list order)", () => {
    const { controller } = setup();
    controller.addImage("page", NEW);
    controller.addImage("page", { ...NEW, alt: "second" });
    expect(controller.images("page").map((i) => i.id)).toEqual(["i1", "i2"]);
  });

  it("an undo that changes nothing in the stored value is not saved again", () => {
    const { controller, save } = setup(valueOf(image("a")));
    controller.commit();
    expect(save).not.toHaveBeenCalled();
  });

  it("a note written by a newer version is shown and refuses every edit", () => {
    const newer = JSON.stringify({ v: 2, pages: { page: { images: [image("a")] } } });
    const { controller, save } = setup(newer);
    expect(controller.readOnly).toBe(true);
    expect(controller.images("page")).toHaveLength(1);
    expect(controller.addImage("page", NEW)).toBeUndefined();
    controller.removeImage("page", "a");
    controller.preview("page", "a", { x: 1 });
    expect(controller.undo()).toBe(false);
    expect(controller.images("page")).toHaveLength(1);
    expect(save).not.toHaveBeenCalled();
  });

  it("notifies subscribers, and the snapshot changes only when the pictures do", () => {
    const { controller } = setup();
    const listener = vi.fn();
    const off = controller.subscribe(listener);
    const before = controller.getSnapshot();
    controller.select("page", "none");
    controller.addImage("page", NEW);
    expect(listener).toHaveBeenCalled();
    expect(controller.getSnapshot()).not.toBe(before);
    off();
  });

  it("disposing saves the rest of a drag that was never released", () => {
    const { controller, save } = setup(valueOf(image("a")));
    controller.preview("page", "a", { x: 300, y: 300 });
    controller.dispose();
    expect(save).toHaveBeenCalledTimes(1);
    expect(decodePageImages(save.mock.calls[0]![0]).pages.page!.images[0]).toMatchObject({ x: 300, y: 300 });
  });
});

describe("geometry", () => {
  it("a new picture keeps its proportions, comfortable width, and is not blown up or taller than allowed", () => {
    expect(insertedSize({ width: 4000, height: 3000 }, 1000, 900)).toEqual({ w: 360, h: 270 });
    expect(insertedSize({ width: 200, height: 100 }, 1000, 900)).toEqual({ w: 200, h: 100 }); // small stays small
    const tall = insertedSize({ width: 1000, height: 4000 }, 1000, 500);
    expect(tall.h).toBeLessThanOrEqual(500);
    expect(tall.w / tall.h).toBeCloseTo(0.25, 5);
    expect(insertedSize(null, 1000, 900)).toEqual({ w: 360, h: 270 }); // unreadable: 4:3
    expect(insertedSize({ width: 1, height: 1 }, 1000, 900).w).toBe(40);
    expect(insertedSize({ width: 4000, height: 3000 }, 200, 900).w).toBe(200); // a narrow page
  });

  it("the visible part of the page is read from the two rects, in page units", () => {
    // a 1000-wide page drawn 500px wide (scale 0.5); the viewport shows its pixels 100–400
    expect(visiblePageBand({ top: 0, bottom: 300 }, { top: -100, bottom: 700, width: 500 }, 1000)).toEqual({ top: 200, height: 600 });
    // the page is shorter than the view
    expect(visiblePageBand({ top: 0, bottom: 800 }, { top: 20, bottom: 420, width: 500 }, 1000)).toEqual({ top: 0, height: 800 });
    // nothing of the page is on screen: its top part
    expect(visiblePageBand({ top: 0, bottom: 300 }, { top: 500, bottom: 900, width: 500 }, 1000).top).toBe(0);
  });

  it("centres on the visible part, kept on the page", () => {
    expect(centeredIn({ top: 500, height: 600 }, { w: 300, h: 200 }, 1000)).toEqual({ x: 350, y: 700 });
    expect(centeredIn({ top: 0, height: 100 }, { w: 300, h: 200 }, 1000)).toEqual({ x: 350, y: 0 }); // not above the page
    expect(centeredIn({ top: 500, height: 600 }, { w: 300, h: 200 }, 1000, 800).y).toBe(600); // not below its end
  });

  it("moving keeps the picture inside the page's width, below its top and above its end", () => {
    const rect = { x: 100, y: 100, w: 300, h: 200 };
    expect(moved(rect, 50, -20, 1000)).toEqual({ ...rect, x: 150, y: 80 });
    expect(moved(rect, -500, -500, 1000)).toEqual({ ...rect, x: 0, y: 0 });
    expect(moved(rect, 5000, 5000, 1000, 1400)).toEqual({ ...rect, x: 700, y: 1200 });
  });

  it("a corner resizes about the opposite corner and keeps the proportions", () => {
    const rect = { x: 100, y: 100, w: 300, h: 200 };
    const se = resizedFromCorner(rect, "se", 60, 40, 1000);
    expect(se).toMatchObject({ x: 100, y: 100, w: 360 });
    expect(se.h).toBeCloseTo(240, 5);
    const nw = resizedFromCorner(rect, "nw", -60, -40, 1000); // pulled out up and left
    expect(nw.x + nw.w).toBeCloseTo(400, 5); // the south-east corner stays
    expect(nw.y + nw.h).toBeCloseTo(300, 5);
    expect(nw.w).toBeCloseTo(360, 5);
    const ne = resizedFromCorner(rect, "ne", -60, 40, 1000); // right edge in, top edge down: smaller
    expect(ne.x).toBe(100);
    expect(ne.y + ne.h).toBeCloseTo(300, 5);
    expect(ne.w).toBeLessThan(300);
    const sw = resizedFromCorner(rect, "sw", -60, 40, 1000);
    expect(sw.x + sw.w).toBeCloseTo(400, 5);
    expect(sw.w).toBeCloseTo(360, 5);
  });

  it("a resize has a smallest size, and stops at the page's edges", () => {
    const rect = { x: 100, y: 100, w: 300, h: 200 };
    const small = resizedFromCorner(rect, "se", -5000, -5000, 1000);
    expect(small.h).toBeGreaterThanOrEqual(40);
    expect(small.w / small.h).toBeCloseTo(1.5, 5);
    expect(resizedFromCorner(rect, "se", 5000, 5000, 1000).w).toBe(900); // to the right edge
    expect(resizedFromCorner(rect, "nw", -5000, -5000, 1000).x).toBe(0);
    const bounded = resizedFromCorner(rect, "se", 5000, 5000, 1000, 500);
    expect(bounded.y + bounded.h).toBeLessThanOrEqual(500 + 1e-9);
  });
});

describe("undoTarget", () => {
  const has = { canUndo: true, canRedo: false };
  const none = { canUndo: false, canRedo: false };
  const pick = (over: Partial<Parameters<typeof undoTarget>[0]>) => undoTarget({ tool: "pen", text: none, images: none, imageSelected: false, ...over });

  it("the drawing tools undo the drawing, whatever else has steps", () => {
    for (const tool of ["pen", "highlighter", "eraser", "shape"]) expect(pick({ tool, text: has, images: has }), tool).toBe("drawing");
  });
  it("the Text tool undoes the text boxes, even before they have a step", () => {
    expect(pick({ tool: "text" })).toBe("text");
    expect(pick({ tool: "text", images: has })).toBe("text");
  });
  it("the Hand tool undoes the text boxes while they have steps, then the pictures, else the drawing", () => {
    expect(pick({ tool: "hand", text: has, images: has })).toBe("text");
    expect(pick({ tool: "hand", images: has })).toBe("images");
    expect(pick({ tool: "hand" })).toBe("drawing");
    expect(pick({ tool: "hand", text: { canUndo: false, canRedo: true } })).toBe("text"); // a redo is a step to give back
  });
  it("a selected picture takes the undo, over the text boxes", () => {
    expect(pick({ tool: "hand", text: has, images: has, imageSelected: true })).toBe("images");
    expect(pick({ tool: "hand", text: has, images: none, imageSelected: true })).toBe("text"); // nothing to undo among the pictures
  });
  it("a page without a text layer or picture layer simply never sends undo there", () => {
    expect(pick({ tool: "text", text: null })).toBe("drawing");
    expect(pick({ tool: "hand", images: null, imageSelected: true })).toBe("drawing");
  });
});
