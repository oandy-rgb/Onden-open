// The eyedropper: which colour is stored at a point (from the drawing's data,
// never the screen's pixels), and the toolbar flow around it — the next press
// on the page takes the colour, Esc or the dropper again cancels, and the
// press that picks draws nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { hexToHsv, hsvToHex } from "../lib/ink";

let serverPrefs: Record<string, unknown> = {};
const sendWrite = vi.hoisted(() => vi.fn());
vi.mock("../lib/data/onlineWrite", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/data/onlineWrite")>(), sendWrite }));
vi.mock("../lib/data/reads", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/data/reads")>();
  return { ...real, reads: { ...real.reads, people: { ...real.reads.people, myPref: vi.fn(async (key: string) => ({ value: serverPrefs[key] ?? null })) } } };
});

import InkToolbar from "../components/InkToolbar";
import { useInkPen } from "../hooks/useInkPen";
import { bindAccountStorage } from "../lib/accountStorage";
import { colorInDrawing, pickColorAt, registerColorSource } from "../lib/ink/colorPick";
import type { InkActiveTool, InkShape, InkStroke } from "../lib/ink";

describe("hue / saturation / brightness", () => {
  it("round-trips every grey, primary and a sample of the palette through hex", () => {
    for (const hex of ["#000000", "#ffffff", "#808080", "#ff0000", "#00ff00", "#0000ff", "#15130d", "#c43c3c", "#fff176", "#9fd8ff", "#12ab34"]) {
      expect(hsvToHex(hexToHsv(hex)!), hex).toBe(hex);
    }
    expect(hexToHsv("nope")).toBeNull();
    expect(hexToHsv("#f00")).toEqual({ h: 0, s: 1, v: 1 });
  });

  it("hue 360 is the same red as 0, and out-of-range values are clamped", () => {
    expect(hsvToHex({ h: 360, s: 1, v: 1 })).toBe("#ff0000");
    expect(hsvToHex({ h: -120, s: 1, v: 1 })).toBe("#0000ff");
    expect(hsvToHex({ h: 0, s: 3, v: 2 })).toBe("#ff0000");
  });
});

const stroke = (id: string, color: string, points: Array<[number, number]>, size = 4): InkStroke => ({ id, color, size, toolId: "pen", points });
const shape = (id: string, over: Partial<InkShape> = {}): InkShape => ({ id, kind: "rectangle", start: [100, 100], end: [200, 180], color: "#2f7d4f", size: 4, ...over });
const drawing = (over: Partial<Parameters<typeof colorInDrawing>[0]> = {}) => ({ strokes: [] as InkStroke[], erased: {}, shapes: [] as InkShape[], ...over });

describe("colorInDrawing", () => {
  it("finds the stroke under a point, within its width and the reach, and nothing far from it", () => {
    const d = drawing({ strokes: [stroke("a", "#c43c3c", [[0, 0], [100, 0]])] });
    expect(colorInDrawing(d, 50, 3, 10)).toBe("#c43c3c");
    expect(colorInDrawing(d, 50, 12, 10)).toBe("#c43c3c"); // the reach plus half the line's width
    expect(colorInDrawing(d, 50, 13, 10)).toBeNull();
  });

  it("the stroke drawn last wins where two cross; a shape is over strokes", () => {
    const d = drawing({
      strokes: [stroke("a", "#c43c3c", [[0, 0], [100, 100]]), stroke("b", "#315f8f", [[0, 100], [100, 0]])],
      shapes: [shape("s", { start: [50, 0], end: [150, 100], color: "#2f7d4f" })], // its left edge passes through (50, 50)
    });
    expect(colorInDrawing(d, 50, 50, 5)).toBe("#2f7d4f"); // a shape is over strokes
    expect(colorInDrawing(drawing({ strokes: d.strokes }), 50, 50, 5)).toBe("#315f8f");
  });

  it("a part of a stroke that was erased does not count; the rest still does", () => {
    const d = drawing({ strokes: [stroke("a", "#c43c3c", [[0, 0], [10, 0], [20, 0], [30, 0], [40, 0]])], erased: { a: [[1, 2]] } });
    expect(colorInDrawing(d, 15, 0, 2)).toBeNull();
    expect(colorInDrawing(d, 40, 0, 2)).toBe("#c43c3c");
  });

  it("a shape is found on its outline, and inside only when it is filled", () => {
    const hollow = drawing({ shapes: [shape("h")] });
    expect(colorInDrawing(hollow, 100, 140, 5)).toBe("#2f7d4f"); // on the left edge
    expect(colorInDrawing(hollow, 150, 140, 5)).toBeNull(); // inside
    const filled = drawing({ shapes: [shape("f", { fill: "solid" })] });
    expect(colorInDrawing(filled, 150, 140, 5)).toBe("#2f7d4f");
  });

  it("a colour that is not a stored hex is skipped, not guessed", () => {
    const d = drawing({ strokes: [stroke("a", "red", [[0, 0], [100, 0]])] });
    expect(colorInDrawing(d, 50, 0, 5)).toBeNull();
  });
});

describe("pickColorAt", () => {
  afterEach(() => { document.body.innerHTML = ""; });
  const place = (el: HTMLElement, left: number, top: number, width: number, height: number) => {
    el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect;
    document.body.appendChild(el);
    return el;
  };

  it("a text box is read from its stored colour, wherever it is under the point", () => {
    const box = place(Object.assign(document.createElement("div"), { }), 100, 100, 200, 40);
    box.dataset.inkColor = "#7a2e33";
    expect(pickColorAt(150, 120)).toBe("#7a2e33");
    expect(pickColorAt(50, 50)).toBeNull();
  });

  it("an ink surface answers for its own area, and text over it wins", () => {
    const surface = place(document.createElement("div"), 0, 0, 500, 500);
    const off = registerColorSource({ element: surface, colorAt: () => "#315f8f" });
    expect(pickColorAt(10, 10)).toBe("#315f8f");
    expect(pickColorAt(600, 10)).toBeNull(); // outside the surface
    const box = place(document.createElement("div"), 0, 0, 100, 100);
    box.dataset.inkColor = "#c43c3c";
    expect(pickColorAt(10, 10)).toBe("#c43c3c");
    off();
    document.body.removeChild(box);
    expect(pickColorAt(10, 10)).toBeNull(); // withdrawn
  });

  it("ignores a colour attribute that is not a hex colour", () => {
    const box = place(document.createElement("div"), 0, 0, 100, 100);
    box.dataset.inkColor = "url(javascript:alert(1))";
    expect(pickColorAt(10, 10)).toBeNull();
  });
});

beforeEach(() => {
  localStorage.clear();
  serverPrefs = {};
  sendWrite.mockReset().mockImplementation(async (_m: string, path: string, body: { value: unknown }) => {
    serverPrefs[path.split("/").pop()!] = body.value;
    return { value: body.value };
  });
  bindAccountStorage("ink-pick-test", "");
});
afterEach(() => cleanup());

function Host({ onPageDown }: { onPageDown?: () => void }) {
  const pen = useInkPen({ color: "#15130d", sizeId: "medium" });
  const [tool, setTool] = useState<InkActiveTool>("pen");
  return (
    <>
      <InkToolbar tool={tool} onToolChange={(t) => setTool(t as InkActiveTool)} {...pen.toolbar} canUndo={false} canRedo={false} onUndo={() => {}} onRedo={() => {}} />
      <output data-testid="color">{pen.color}</output>
      <div data-testid="page" onPointerDown={onPageDown} />
      <div data-testid="text" data-ink-color="#c43c3c" />
    </>
  );
}
const color = () => screen.getByTestId("color").textContent;
const rect = (el: Element, left: number, top: number, width = 100, height = 40) => {
  (el as HTMLElement).getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect;
};
const press = (el: Element, x: number, y: number, pointerType = "pen") => {
  const e = new Event("pointerdown", { bubbles: true, cancelable: true });
  Object.assign(e, { pointerId: 3, pointerType, button: 0, buttons: 1, clientX: x, clientY: y });
  fireEvent(el, e);
};
const start = () => {
  fireEvent.click(screen.getByRole("button", { name: "More colors" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "More colors" })).getByRole("button", { name: "Pick a color from the page" }));
};
const hint = () => document.querySelector("[data-ink-eyedropper-ui]");

describe("the eyedropper in the toolbar", () => {
  it("starting closes the colour panel and shows the hint; the next press on a text box takes its colour, and nothing else gets that press", () => {
    const onPageDown = vi.fn();
    render(<Host onPageDown={onPageDown} />);
    rect(screen.getByTestId("text"), 200, 200);
    start();
    expect(screen.queryByRole("dialog", { name: "More colors" })).toBeNull();
    expect(hint()).toBeTruthy();
    expect(document.body.dataset.inkEyedropper).toBe("on");
    press(screen.getByTestId("page"), 250, 220, "touch"); // a finger works as well as a pen
    expect(color()).toBe("#c43c3c");
    expect(onPageDown).not.toHaveBeenCalled(); // the press did not draw
    expect(hint()).toBeNull();
    expect(document.body.dataset.inkEyedropper).toBeUndefined();
  });

  it("the rest of the press that picked is kept from the page, after the picking is over too (a pen down and moving with no pointerdown before it would read as the side button)", () => {
    const seen: string[] = [];
    render(<Host />);
    const page = screen.getByTestId("page");
    for (const type of ["pointermove", "pointerup"]) page.addEventListener(type, () => seen.push(type));
    rect(screen.getByTestId("text"), 0, 0);
    start();
    press(page, 10, 10);
    expect(hint()).toBeNull(); // picked: the eyedropper is done
    const send = (type: string, pointerId: number) => { const e = new Event(type, { bubbles: true, cancelable: true }); Object.assign(e, { pointerId, pointerType: "pen", clientX: 12, clientY: 12 }); fireEvent(page, e); };
    send("pointermove", 3);
    send("pointermove", 4); // another pointer is not ours
    send("pointerup", 3);
    expect(seen).toEqual(["pointermove"]); // only the other pointer's move got through
    send("pointermove", 3); // the press is over: this is a new one's business
    expect(seen).toEqual(["pointermove", "pointermove"]);
  });

  it("a press on an ink surface takes the stroke's colour", () => {
    render(<Host />);
    const page = screen.getByTestId("page");
    rect(page, 0, 0, 600, 600);
    const off = registerColorSource({ element: page, colorAt: () => "#2f7d4f" });
    start();
    press(page, 30, 30);
    expect(color()).toBe("#2f7d4f");
    off();
  });

  it("a press on nothing keeps waiting and says so; Esc ends it without changing the colour", () => {
    render(<Host />);
    start();
    press(screen.getByTestId("page"), 5, 5);
    expect(color()).toBe("#15130d");
    expect(hint()!.textContent).toContain("Nothing there");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(hint()).toBeNull();
    expect(color()).toBe("#15130d");
  });

  it("the dropper in the hint, and the Cancel button, end it (a touch screen has no Esc)", () => {
    render(<Host />);
    start();
    fireEvent.click(within(hint() as HTMLElement).getByRole("button", { name: "Pick a color from the page" }));
    expect(hint()).toBeNull();
    start();
    fireEvent.click(within(hint() as HTMLElement).getByRole("button", { name: "Cancel" }));
    expect(hint()).toBeNull();
  });

  it("choosing another tool ends it; the toolbar's own buttons still work meanwhile", () => {
    render(<Host />);
    start();
    fireEvent.click(screen.getByRole("button", { name: "Red" })); // a toolbar press is not "the page"
    expect(color()).toBe("#c43c3c");
    expect(hint()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Eraser" }));
    expect(hint()).toBeNull();
  });

  it("the picked colour is used and shown under Recent", () => {
    render(<Host />);
    rect(screen.getByTestId("text"), 0, 0);
    start();
    press(screen.getByTestId("page"), 10, 10);
    fireEvent.click(screen.getByRole("button", { name: "More colors" }));
    expect(within(screen.getByRole("dialog", { name: "More colors" })).getByRole("group", { name: "Recent" })).toBeTruthy();
  });
});
