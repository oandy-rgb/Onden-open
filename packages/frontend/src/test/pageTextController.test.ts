import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodePageText, encodePageText, type PageTextDoc } from "@onden/markdown/page-text";
import { PageTextController, SAVE_PAUSE_MS } from "../lib/pageText";

// The text boxes of a note: when they are saved (a pause in typing, a finished
// move, leaving the page), what is saved (no empty boxes, nothing twice) and
// how undo steps are cut. Each save is one lib/data savePageText write.

let n = 0;
function make(initial: string | null = null, readOnly = false) {
  const save = vi.fn<(value: string, base: string | null) => void>();
  const controller = new PageTextController({ initial, save, readOnly, now: () => new Date("2026-10-28T00:00:00Z"), newId: () => `b${++n}` });
  return { controller, save };
}
const boxesOf = (controller: PageTextController, key = "pdf:1") => controller.boxes(key);
const savedDoc = (save: ReturnType<typeof make>["save"], call = 0): PageTextDoc => decodePageText(save.mock.calls[call]![0]);

beforeEach(() => { vi.useFakeTimers(); n = 0; });
afterEach(() => { vi.useRealTimers(); });

describe("saving", () => {
  it("typing is saved once, after a pause — not on every key", () => {
    const { controller, save } = make();
    const box = controller.addBox("pdf:1", { x: 10, y: 20 })!;
    for (const text of ["H", "He", "Hel", "Hell", "Hello"]) {
      controller.setText("pdf:1", box.id, text);
      vi.advanceTimersByTime(SAVE_PAUSE_MS - 100);
    }
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(save).toHaveBeenCalledTimes(1);
    expect(savedDoc(save).pages["pdf:1"]!.boxes[0]).toMatchObject({ text: "Hello", x: 10, y: 20 });
  });

  it("leaving the page (commit) saves what is pending at once, and only once", () => {
    const { controller, save } = make();
    const box = controller.addBox("pdf:1", {})!;
    controller.setText("pdf:1", box.id, "半途 😀");
    controller.commit();
    expect(save).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SAVE_PAUSE_MS * 3);
    controller.commit();
    expect(save).toHaveBeenCalledTimes(1);
    expect(savedDoc(save).pages["pdf:1"]!.boxes[0]!.text).toBe("半途 😀");
  });

  it("a box with no text is never saved, and a box emptied is saved as gone", () => {
    const { controller, save } = make();
    const box = controller.addBox("pdf:1", {})!;
    controller.commit();
    expect(save).not.toHaveBeenCalled();
    controller.setText("pdf:1", box.id, "x");
    controller.commit();
    controller.setText("pdf:1", box.id, "  ");
    controller.commit();
    expect(save).toHaveBeenCalledTimes(2);
    expect(savedDoc(save, 1).pages["pdf:1"]).toBeUndefined();
  });

  it("a drag previews and saves once, on release", () => {
    const initial = encodePageText({ v: 1, pages: { "pdf:1": { boxes: [{ id: "a", x: 0, y: 0, w: 300, text: "a", size: 22, color: "#000000", align: "left", updated_at: "" }] } } });
    const { controller, save } = make(initial);
    controller.select("pdf:1", "a");
    for (let i = 1; i <= 5; i++) controller.preview("pdf:1", "a", { x: i * 10, y: i * 5 });
    expect(save).not.toHaveBeenCalled();
    expect(boxesOf(controller)[0]).toMatchObject({ x: 50, y: 25 });
    controller.setGeometry("pdf:1", "a", { x: 50, y: 25 });
    expect(save).toHaveBeenCalledTimes(1);
    expect(savedDoc(save).pages["pdf:1"]!.boxes[0]).toMatchObject({ x: 50, y: 25 });
  });

  it("size, colour and delete save at once", () => {
    const initial = encodePageText({ v: 1, pages: { "pdf:1": { boxes: [{ id: "a", x: 0, y: 0, w: 300, text: "a", size: 22, color: "#000000", align: "left", updated_at: "" }] } } });
    const { controller, save } = make(initial);
    controller.setStyle("pdf:1", "a", { size: 32 });
    controller.setStyle("pdf:1", "a", { color: "#c43c3c" });
    controller.removeBox("pdf:1", "a");
    expect(save).toHaveBeenCalledTimes(3);
    expect(savedDoc(save, 0).pages["pdf:1"]!.boxes[0]!.size).toBe(32);
    expect(savedDoc(save, 1).pages["pdf:1"]!.boxes[0]!.color).toBe("#c43c3c");
    expect(savedDoc(save, 2).pages["pdf:1"]).toBeUndefined();
  });

  it("each save names the value it was made from, so the server can merge", () => {
    const initial = encodePageText({ v: 1, pages: { "pdf:1": { boxes: [{ id: "a", x: 0, y: 0, w: 300, text: "a", size: 22, color: "#000000", align: "left", updated_at: "" }] } } });
    const { controller, save } = make(initial);
    controller.setStyle("pdf:1", "a", { size: 32 });
    controller.setStyle("pdf:1", "a", { size: 16 });
    expect(save.mock.calls[0]![1]).toBe(initial);
    expect(save.mock.calls[1]![1]).toBe(save.mock.calls[0]![0]);
    const fresh = make(null);
    const box = fresh.controller.addBox("pdf:1", {})!;
    fresh.controller.setText("pdf:1", box.id, "x");
    fresh.controller.commit();
    expect(fresh.save.mock.calls[0]![1]).toBeNull();
  });

  it("keeps the boxes of other pages and what it does not know", () => {
    const initial = JSON.stringify({ v: 1, extra: 7, pages: { "pdf:2": { boxes: [{ id: "z", x: 1, y: 1, w: 100, text: "z", size: 22, color: "#000000", align: "left", updated_at: "", rot: 3 }] } } });
    const { controller, save } = make(initial);
    const box = controller.addBox("pdf:1", {})!;
    controller.setText("pdf:1", box.id, "new");
    controller.commit();
    const saved = JSON.parse(save.mock.calls[0]![0]);
    expect(saved.extra).toBe(7);
    expect(saved.pages["pdf:2"].boxes[0].rot).toBe(3);
    expect(saved.pages["pdf:1"].boxes[0].text).toBe("new");
  });
});

describe("undo", () => {
  it("a box added, typed and moved is three steps; a typing burst is one", () => {
    const { controller } = make();
    const box = controller.addBox("pdf:1", {})!;
    controller.setText("pdf:1", box.id, "a");
    controller.setText("pdf:1", box.id, "ab");
    controller.setText("pdf:1", box.id, "abc");
    controller.commit();
    controller.preview("pdf:1", box.id, { x: 40 });
    controller.setGeometry("pdf:1", box.id, { x: 40 });
    expect(boxesOf(controller)[0]).toMatchObject({ text: "abc", x: 40 });
    expect(controller.undo()).toBe(true); // the move
    expect(boxesOf(controller)[0]).toMatchObject({ text: "abc", x: 0 });
    expect(controller.undo()).toBe(true); // the whole typing burst
    expect(boxesOf(controller)[0]!.text).toBe("");
    expect(controller.undo()).toBe(true); // the add
    expect(boxesOf(controller)).toHaveLength(0);
    expect(controller.canUndo).toBe(false);
    expect(controller.redo()).toBe(true);
    expect(boxesOf(controller)).toHaveLength(1);
  });

  it("undoing a delete brings the box back and saves it again", () => {
    const initial = encodePageText({ v: 1, pages: { "pdf:1": { boxes: [{ id: "a", x: 0, y: 0, w: 300, text: "a", size: 22, color: "#000000", align: "left", updated_at: "" }] } } });
    const { controller, save } = make(initial);
    controller.removeBox("pdf:1", "a");
    controller.undo();
    expect(boxesOf(controller)).toHaveLength(1);
    expect(save).toHaveBeenCalledTimes(2);
    expect(savedDoc(save, 1).pages["pdf:1"]!.boxes[0]!.id).toBe("a");
  });

  it("a new edit drops the redo steps", () => {
    const { controller } = make();
    const box = controller.addBox("pdf:1", {})!;
    controller.setText("pdf:1", box.id, "a");
    controller.commit();
    controller.undo();
    controller.setStyle("pdf:1", box.id, { size: 16 });
    expect(controller.canRedo).toBe(false);
  });

  it("a box added and left empty leaves no undo step", () => {
    const { controller } = make();
    const box = controller.addBox("pdf:1", {})!;
    controller.select("pdf:1", box.id, true);
    controller.clearSelection();
    expect(boxesOf(controller)).toHaveLength(0);
    expect(controller.canUndo).toBe(false);
  });
});

describe("a value from a newer version", () => {
  it("shows its boxes and refuses every edit", () => {
    const newer = JSON.stringify({ v: 2, pages: { "pdf:1": { boxes: [{ id: "a", x: 0, y: 0, w: 300, text: "a", size: 22, color: "#000000", align: "left", updated_at: "" }] } } });
    const { controller, save } = make(newer);
    expect(controller.readOnly).toBe(true);
    expect(boxesOf(controller)).toHaveLength(1);
    expect(controller.addBox("pdf:1", {})).toBeUndefined();
    controller.setText("pdf:1", "a", "changed");
    controller.removeBox("pdf:1", "a");
    controller.commit();
    expect(boxesOf(controller)[0]!.text).toBe("a");
    expect(save).not.toHaveBeenCalled();
  });
});
