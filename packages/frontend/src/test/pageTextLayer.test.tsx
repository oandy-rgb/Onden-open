import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { decodePageText, encodePageText } from "@onden/markdown/page-text";
import { PageTextController, SAVE_PAUSE_MS } from "../lib/pageText";
import { TextBoxLayer, type TextBoxMode } from "../components/page";

// The text-box layer on a page: tap to add, type, move, resize, delete, undo,
// and the input-method rules (nothing is saved or acted on while composing).

const KEY = "pdf:1";
const box = (over: Record<string, unknown> = {}) => ({ id: "a", x: 100, y: 50, w: 300, text: "hello", size: 22, color: "#15130d", align: "left", updated_at: "", ...over });
const stored = (...boxes: Array<ReturnType<typeof box>>) => encodePageText({ v: 1, pages: { [KEY]: { boxes: boxes as never } } });

let n = 0;
function setup(opts: { initial?: string | null; mode?: TextBoxMode; scale?: number } = {}) {
  const save = vi.fn<(value: string, base: string | null) => void>();
  const controller = new PageTextController({ initial: opts.initial ?? null, save, newId: () => `n${++n}`, now: () => new Date("2026-10-28T00:00:00Z") });
  function Harness({ mode }: { mode: TextBoxMode }) {
    const doc = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    return <TextBoxLayer controller={controller} doc={doc} pageKey={KEY} pageWidth={1000} mode={mode} scale={opts.scale ?? 1} />;
  }
  const view = render(<Harness mode={opts.mode ?? "text"} />);
  return { controller, save, view, rerender: (mode: TextBoxMode) => view.rerender(<Harness mode={mode} />) };
}
const pointer = (el: Element, type: "pointerDown" | "pointerMove" | "pointerUp", x: number, y: number, pointerType = "touch") =>
  fireEvent[type](el, { clientX: x, clientY: y, pointerId: 1, pointerType, button: 0 });
const tap = (el: Element, x: number, y: number, pointerType = "touch") => {
  pointer(el, "pointerDown", x, y, pointerType);
  pointer(el, "pointerUp", x, y, pointerType);
};
const capture = () => document.querySelector("[data-page-text-capture]")!;
const boxEl = (id: string) => document.querySelector(`[data-page-text-box="${id}"]`) as HTMLElement;

beforeEach(() => { vi.useFakeTimers(); n = 0; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("adding and typing", () => {
  it.each(["touch", "pen", "mouse"])("a %s tap on the page adds a box and starts typing", (kind) => {
    const { controller } = setup();
    act(() => tap(capture(), 200, 300, kind));
    expect(controller.boxes(KEY)).toHaveLength(1);
    expect(controller.boxes(KEY)[0]).toMatchObject({ x: 200, w: 320 });
    expect(document.activeElement?.tagName).toBe("TEXTAREA");
  });

  it("the mouse events that follow a touch tap cannot take focus off the new box", () => {
    setup();
    act(() => tap(capture(), 200, 300));
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    capture().dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    // ...and neither can the ones that land on the new box's own grip.
    const onGrip = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    document.querySelector("[data-page-text-grip]")!.dispatchEvent(onGrip);
    expect(onGrip.defaultPrevented).toBe(true);
    expect(document.activeElement?.tagName).toBe("TEXTAREA");
  });

  it("a drag (a scroll) adds nothing", () => {
    const { controller } = setup();
    act(() => {
      pointer(capture(), "pointerDown", 200, 300);
      pointer(capture(), "pointerMove", 200, 380);
      pointer(capture(), "pointerUp", 200, 380);
    });
    expect(controller.boxes(KEY)).toHaveLength(0);
  });

  it("typing is saved after a pause, not on each key", () => {
    const { controller, save } = setup();
    act(() => tap(capture(), 200, 300));
    const area = screen.getByRole("textbox");
    for (const value of ["你", "你好", "你好 😀"]) act(() => { fireEvent.change(area, { target: { value } }); });
    expect(save).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(SAVE_PAUSE_MS); });
    expect(save).toHaveBeenCalledTimes(1);
    expect(controller.boxes(KEY)[0]!.text).toBe("你好 😀");
  });

  it("a tap elsewhere closes the box and saves; an empty box is removed", () => {
    const { controller, save } = setup();
    act(() => tap(capture(), 200, 300));
    act(() => { fireEvent.change(screen.getByRole("textbox"), { target: { value: "note" } }); });
    act(() => { fireEvent.blur(screen.getByRole("textbox")); });
    expect(save).toHaveBeenCalledTimes(1);
    act(() => tap(capture(), 600, 600)); // the box is selected: this tap only closes it
    expect(controller.boxes(KEY)).toHaveLength(1);
    expect(controller.getSelection()).toBeNull();
    act(() => tap(capture(), 600, 600)); // nothing open: this one adds
    expect(controller.boxes(KEY)).toHaveLength(2);
    act(() => { fireEvent.blur(screen.getByRole("textbox")); }); // left empty
    expect(controller.boxes(KEY)).toHaveLength(1);
  });

  it("the pen tool shows the boxes and takes no taps", () => {
    const { controller } = setup({ initial: stored(box()), mode: "view" });
    expect(document.querySelector("[data-page-text-capture]")).toBeNull();
    expect(boxEl("a").className).not.toContain("page-text-box--live");
    expect(screen.getByText("hello")).toBeTruthy();
    expect(controller.boxes(KEY)).toHaveLength(1);
  });
});

describe("an input method composing", () => {
  it("nothing is saved or changed until the composition ends; Esc and Ctrl+Z do nothing meanwhile", () => {
    const { controller, save } = setup();
    act(() => tap(capture(), 200, 300));
    const area = screen.getByRole("textbox") as HTMLTextAreaElement;
    act(() => { fireEvent.compositionStart(area); });
    act(() => { fireEvent.change(area, { target: { value: "ㄋㄧˇ" } }); });
    expect(controller.boxes(KEY)[0]!.text).toBe("");
    expect(area.value).toBe("ㄋㄧˇ");
    act(() => { fireEvent.keyDown(area, { key: "Escape", keyCode: 229, isComposing: true }); });
    act(() => { fireEvent.keyDown(area, { key: "z", ctrlKey: true, keyCode: 229, isComposing: true }); });
    expect(controller.getSelection()?.editing).toBe(true);
    act(() => { vi.advanceTimersByTime(SAVE_PAUSE_MS * 2); });
    expect(save).not.toHaveBeenCalled();
    act(() => { fireEvent.change(area, { target: { value: "你" } }); });
    act(() => { fireEvent.compositionEnd(area, { target: { value: "你" } }); });
    expect(controller.boxes(KEY)[0]!.text).toBe("你");
    act(() => { vi.advanceTimersByTime(SAVE_PAUSE_MS); });
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe("moving, resizing, deleting", () => {
  it("a tap selects, a second tap edits", () => {
    const { controller } = setup({ initial: stored(box()), mode: "select" });
    act(() => tap(boxEl("a"), 120, 60));
    expect(controller.getSelection()).toEqual({ pageKey: KEY, id: "a", editing: false });
    act(() => tap(boxEl("a"), 120, 60));
    expect(controller.getSelection()?.editing).toBe(true);
  });

  it("a drag moves it in page units — at 2× zoom 100 px is 50 units — and saves once, on release", () => {
    const { controller, save } = setup({ initial: stored(box()), mode: "select", scale: 2 });
    act(() => {
      pointer(boxEl("a"), "pointerDown", 300, 200);
      pointer(boxEl("a"), "pointerMove", 350, 240);
      pointer(boxEl("a"), "pointerMove", 400, 260);
    });
    expect(save).not.toHaveBeenCalled();
    act(() => pointer(boxEl("a"), "pointerUp", 400, 260));
    expect(controller.boxes(KEY)[0]).toMatchObject({ x: 150, y: 80 });
    expect(save).toHaveBeenCalledTimes(1);
    expect(decodePageText(save.mock.calls[0]![0]).pages[KEY]!.boxes[0]).toMatchObject({ x: 150, y: 80 });
    expect(controller.getSelection()?.id).toBe("a");
  });

  it("is drawn at the page's scale: position, width and type size follow zoom", () => {
    const { rerender, view } = setup({ initial: stored(box()), mode: "view", scale: 0.5 });
    expect(boxEl("a").style.getPropertyValue("--ptb-left")).toBe("50px");
    expect(boxEl("a").style.getPropertyValue("--ptb-width")).toBe("150px");
    expect(boxEl("a").style.getPropertyValue("--ptb-size")).toBe("11px");
    void rerender; void view;
  });

  it("the right-edge handle sets the width, within the page", () => {
    const { controller, save } = setup({ initial: stored(box()), mode: "select" });
    act(() => tap(boxEl("a"), 120, 60));
    const handle = document.querySelector("[data-page-text-resize]")!;
    act(() => {
      pointer(handle, "pointerDown", 400, 60);
      pointer(handle, "pointerMove", 500, 60);
      pointer(handle, "pointerUp", 500, 60);
    });
    expect(controller.boxes(KEY)[0]).toMatchObject({ x: 100, w: 400 });
    expect(save).toHaveBeenCalledTimes(1);
    act(() => {
      pointer(handle, "pointerDown", 500, 60);
      pointer(handle, "pointerMove", 5000, 60);
      pointer(handle, "pointerUp", 5000, 60);
    });
    expect(controller.boxes(KEY)[0]!.w).toBe(900); // up to the page edge
  });

  it("the bar sets size and colour and deletes", () => {
    const { controller } = setup({ initial: stored(box()), mode: "select" });
    act(() => tap(boxEl("a"), 120, 60));
    act(() => { fireEvent.click(screen.getByRole("button", { name: "Large text" })); });
    expect(controller.boxes(KEY)[0]!.size).toBe(32);
    const swatches = screen.getAllByRole("button").filter((b) => b.className.includes("ink-swatch"));
    act(() => { fireEvent.click(swatches[4]!); });
    expect(controller.boxes(KEY)[0]!.color).not.toBe("#15130d");
    act(() => { fireEvent.click(screen.getByRole("button", { name: "Delete text box" })); });
    expect(controller.boxes(KEY)).toHaveLength(0);
    expect(controller.undo()).toBe(true);
    expect(controller.boxes(KEY)).toHaveLength(1);
  });

  it("Ctrl+Z in the text undoes the typing, not the browser's own history", () => {
    const { controller } = setup({ initial: stored(box()), mode: "select" });
    act(() => tap(boxEl("a"), 120, 60));
    act(() => tap(boxEl("a"), 120, 60));
    const area = screen.getByRole("textbox");
    act(() => { fireEvent.change(area, { target: { value: "hello world" } }); });
    act(() => { fireEvent.keyDown(area, { key: "z", ctrlKey: true }); });
    expect(controller.boxes(KEY)[0]!.text).toBe("hello");
  });

  it("a value from a newer version cannot be edited", () => {
    const newer = JSON.stringify({ v: 2, pages: { [KEY]: { boxes: [box()] } } });
    const { controller } = setup({ initial: newer, mode: "text" });
    expect(document.querySelector("[data-page-text-capture]")).toBeNull();
    act(() => tap(boxEl("a"), 120, 60));
    expect(controller.getSelection()).toBeNull();
  });
});
