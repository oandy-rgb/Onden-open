// The shape button and the colour panel of the shared ink toolbar, and what
// they keep with the account (lib/inkPrefs): the last shape, the quick
// colours, the colours made or used lately.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
import { inkAutoShapePref, inkPalettePref, inkShapeFillPref, inkShapeKindPref, parseShapeKind } from "../lib/inkPrefs";
import { INK_SHAPE_KINDS } from "@onden/markdown/ink";
import type { InkActiveTool } from "../lib/ink";

beforeEach(() => {
  localStorage.clear();
  serverPrefs = {};
  sendWrite.mockReset().mockImplementation(async (_m: string, path: string, body: { value: unknown }) => {
    serverPrefs[path.split("/").pop()!] = body.value;
    return { value: body.value };
  });
  bindAccountStorage("ink-prefs-test", "");
  for (const pref of [inkPalettePref, inkShapeKindPref, inkShapeFillPref, inkAutoShapePref]) pref.store.forget();
});
afterEach(() => cleanup());

/** A toolbar wired the way the hosts wire it (useInkPen), with the tool and colour on show. */
function Host({ initialTool = "pen", onTool }: { initialTool?: InkActiveTool; onTool?: (t: InkActiveTool) => void }) {
  const pen = useInkPen({ color: "#15130d", sizeId: "medium" });
  const [tool, setTool] = useState<InkActiveTool>(initialTool);
  return (
    <>
      <InkToolbar
        tool={tool}
        onToolChange={(t) => { setTool(t as InkActiveTool); onTool?.(t as InkActiveTool); }}
        {...pen.toolbar}
        canUndo={false} canRedo={false} onUndo={() => {}} onRedo={() => {}}
      />
      <output data-testid="color">{pen.color}</output>
      <output data-testid="kind">{pen.shapeKind}</output>
    </>
  );
}
const color = () => screen.getByTestId("color").textContent;
const kind = () => screen.getByTestId("kind").textContent;
const shapeButton = () => document.querySelector('[data-ink-tool="shape"]') as HTMLButtonElement;
const puts = (key: string) => sendWrite.mock.calls.filter(([m, p]) => m === "PUT" && p === `/api/me/prefs/${key}`).map(([, , body]) => body.value);

describe("the shape button", () => {
  it("is one button in the tool group, between the eraser and Hand", () => {
    render(<Host />);
    const group = screen.getByRole("group", { name: "Tool" });
    expect(within(group).getAllByRole("button").map((b) => b.getAttribute("data-ink-tool"))).toEqual(["pen", "highlighter", "eraser", "shape", "hand"]);
  });

  it("pressing it chooses the shape tool and offers the eight shapes", () => {
    const onTool = vi.fn();
    render(<Host onTool={onTool} />);
    fireEvent.click(shapeButton());
    expect(onTool).toHaveBeenCalledWith("shape");
    const list = screen.getByRole("group", { name: "Shape" });
    expect([...list.querySelectorAll("[data-ink-shape]")].map((b) => b.getAttribute("data-ink-shape"))).toEqual([...INK_SHAPE_KINDS]);
    expect([...list.querySelectorAll("[data-ink-shape]")].map((b) => b.getAttribute("aria-label"))).toEqual([
      "Straight line", "Arrow", "Rectangle", "Rounded rectangle", "Ellipse", "Triangle", "Diamond", "Star",
    ]);
  });

  it("choosing a shape closes the list, keeps the shape tool, and the button's icon follows", async () => {
    render(<Host />);
    expect(shapeButton().getAttribute("data-ink-shape-kind")).toBe("rectangle");
    const before = shapeButton().innerHTML;
    fireEvent.click(shapeButton());
    fireEvent.click(document.querySelector('[data-ink-shape="star"]')!);
    expect(screen.queryByRole("group", { name: "Shape" })).toBeNull();
    expect(shapeButton().getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(shapeButton().getAttribute("data-ink-shape-kind")).toBe("star"));
    expect(shapeButton().innerHTML).not.toBe(before);
    expect(shapeButton().getAttribute("aria-label")).toBe("Shape — Star");
  });

  it("pressing it again, while the tool is on, hides and shows the list", () => {
    render(<Host initialTool="shape" />);
    expect(screen.queryByRole("group", { name: "Shape" })).toBeNull();
    fireEvent.click(shapeButton());
    expect(screen.getByRole("group", { name: "Shape" })).toBeTruthy();
    fireEvent.click(shapeButton());
    expect(screen.queryByRole("group", { name: "Shape" })).toBeNull();
  });

  it("the list also chooses fill or no fill; the choice follows the account and the button's icon shows it", async () => {
    const { unmount } = render(<Host />);
    fireEvent.click(shapeButton());
    const filled = () => shapeButton().querySelector("svg")!.getAttribute("fill");
    expect(filled()).toBe("none");
    expect(screen.getByRole("button", { name: "No fill" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Filled" }));
    await waitFor(() => expect(puts("inkShapeFill")).toEqual(["solid"]));
    await waitFor(() => expect(filled()).toBe("currentColor"));
    unmount();
    inkShapeFillPref.store.forget();
    localStorage.clear();
    serverPrefs.inkShapeFill = "none";
    render(<Host />);
    await waitFor(() => expect(filled()).toBe("none"));
  });

  it("the last shape follows the account: saved, and another device's choice arrives", async () => {
    const { unmount } = render(<Host />);
    fireEvent.click(shapeButton());
    fireEvent.click(document.querySelector('[data-ink-shape="diamond"]')!);
    await waitFor(() => expect(puts("inkShape")).toEqual(["diamond"]));
    unmount();
    // A device that has never chosen one starts on what the account holds.
    inkShapeKindPref.store.forget();
    localStorage.clear();
    serverPrefs.inkShape = "triangle";
    render(<Host />);
    await waitFor(() => expect(kind()).toBe("triangle"));
  });

  it("a kind this version does not know is not taken as the last shape", () => {
    expect(parseShapeKind("spiral")).toBeNull();
    expect(parseShapeKind(3)).toBeNull();
    for (const k of INK_SHAPE_KINDS) expect(parseShapeKind(k)).toBe(k);
  });

  it("a toolbar whose host has no shapes (no `shape` prop) has no shape button; read-only neither", () => {
    const base = { tool: "pen" as const, onToolChange: () => {}, color: "#15130d", onColorChange: () => {}, sizeId: "medium", onSizeChange: () => {}, canUndo: false, canRedo: false, onUndo: () => {}, onRedo: () => {} };
    const { rerender } = render(<InkToolbar {...base} />);
    expect(shapeButton()).toBeNull();
    rerender(<InkToolbar {...base} readOnly shape={{ kind: "line", onKindChange: () => {}, fill: "none", onFillChange: () => {} }} />);
    expect(shapeButton()).toBeNull();
  });
});

describe("colours", () => {
  const quick = () => within(screen.getByRole("group", { name: "Color" })).getAllByRole("button").filter((b) => b.classList.contains("ink-swatch"));
  const openMore = () => fireEvent.click(screen.getByRole("button", { name: "More colors" }));
  const panel = () => screen.getByRole("dialog", { name: "More colors" });

  it("the toolbar shows five quick colours and one 「更多」 button", () => {
    render(<Host />);
    expect(quick().map((b) => b.getAttribute("title"))).toEqual(["Ink", "Oxblood", "Blue", "Amber", "Red"]);
    expect(screen.getByRole("button", { name: "More colors" })).toBeTruthy();
  });

  it("「更多」 holds about twenty colours, the palette with its colour code and eyedropper, and the lists", () => {
    render(<Host />);
    openMore();
    const swatches = within(within(panel()).getByRole("group", { name: "Colors" })).getAllByRole("button");
    expect(swatches).toHaveLength(20);
    expect(within(panel()).getByLabelText("Color code")).toBeTruthy();
    expect(within(panel()).getByRole("slider", { name: "Saturation and brightness" })).toBeTruthy();
    expect(within(panel()).getByRole("slider", { name: "Hue" })).toBeTruthy();
    expect(within(panel()).getByRole("button", { name: "Pick a color from the page" })).toBeTruthy();
    expect(within(panel()).queryByRole("button", { name: "Use" })).toBeNull(); // the colour follows the drag: nothing to confirm
    expect(panel().querySelector('input[type="color"]')).toBeNull();
    expect(within(panel()).getByRole("group", { name: "Quick colors" })).toBeTruthy();
    // nothing made or used yet: no empty headings
    expect(within(panel()).queryByRole("group", { name: "Recent" })).toBeNull();
    expect(within(panel()).queryByRole("group", { name: "My colors" })).toBeNull();
  });

  it("a palette colour is used and shows under Recent, kept with the account", async () => {
    render(<Host />);
    openMore();
    fireEvent.click(within(panel()).getByRole("button", { name: "Light yellow" }));
    expect(color()).toBe("#fff176");
    await waitFor(() => expect(puts("inkPalette").at(-1)).toMatchObject({ recent: ["#fff176"] }));
    expect(within(panel()).getByRole("group", { name: "Recent" })).toBeTruthy();
    // the current colour is not one of the five: 「更多」 wears it
    expect(screen.getByRole("button", { name: "More colors" }).classList.contains("active")).toBe(true);
  });

  it("a colour code is used as it is typed and kept under My colors when finished; a bad code changes nothing", async () => {
    render(<Host />);
    openMore();
    const input = within(panel()).getByLabelText("Color code") as HTMLInputElement;
    expect(input.value).toBe("#15130d"); // shows the pen's colour
    fireEvent.change(input, { target: { value: "#12zz34" } });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(color()).toBe("#15130d");
    fireEvent.change(input, { target: { value: "12AB34" } });
    expect(color()).toBe("#12ab34");
    expect(puts("inkPalette")).toEqual([]); // not kept until finished
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(puts("inkPalette").at(-1)).toMatchObject({ custom: ["#12ab34"] }));
    expect(within(within(panel()).getByRole("group", { name: "My colors" })).getByRole("button", { name: "#12ab34" })).toBeTruthy();
    expect(input.value).toBe("#12ab34");
  });

  it("an Enter that picks an input-method candidate does not finish the colour code", () => {
    render(<Host />);
    openMore();
    const input = within(panel()).getByLabelText("Color code") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "#12ab34" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true, keyCode: 229 });
    expect(puts("inkPalette")).toEqual([]);
  });

  describe("the palette (square and hue bar)", () => {
    // jsdom has no layout: give the two a size so a pointer's place means something.
    const sized = (el: HTMLElement) => {
      el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: el.hasAttribute("data-ink-picker-hue") ? 44 : 140, right: 200, bottom: 140, x: 0, y: 0, toJSON() {} }) as DOMRect;
      return el;
    };
    const square = () => sized(panel().querySelector("[data-ink-picker-square]")!);
    const hueBar = () => sized(panel().querySelector("[data-ink-picker-hue]")!);
    const pointer = (el: Element, type: string, x: number, y: number, pointerType = "pen") => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(e, { pointerId: 7, pointerType, button: 0, buttons: 1, clientX: x, clientY: y });
      fireEvent(el, e);
    };

    it("is big enough for a pen or a finger: the square at least 200 × 140, the hue bar 44 tall to touch", () => {
      const css = readFileSync(join(__dirname, "../components/InkToolbar.css"), "utf8");
      const rule = (selector: string) => [...css.matchAll(new RegExp(`(?:^|\\n)${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`, "g"))].map((m) => m[1]).join("\n");
      expect(rule(".ink-picker-square")).toMatch(/min-width:\s*200px/);
      expect(rule(".ink-picker-square")).toMatch(/height:\s*140px/);
      expect(rule(".ink-picker-hue")).toMatch(/height:\s*44px/);
    });

    it("dragging the square changes the pen colour as it moves, and keeps the colour when let go", async () => {
      render(<Host />);
      openMore();
      fireEvent.change(within(panel()).getByLabelText("Color code"), { target: { value: "#ff0000" } }); // start from a pure red hue
      const el = square();
      pointer(el, "pointerdown", 200, 0); // top right: full saturation, full brightness of the hue
      expect(color()).toBe("#ff0000");
      pointer(el, "pointermove", 100, 70); // middle: half saturation, half brightness
      expect(color()).toBe("#804040");
      expect(puts("inkPalette")).toEqual([]); // still dragging: nothing kept yet
      pointer(el, "pointermove", 400, 300); // dragged beyond the corner: clamped to the corner
      expect(color()).toBe("#000000");
      pointer(el, "pointerup", 100, 70);
      await waitFor(() => expect(puts("inkPalette").at(-1)).toMatchObject({ custom: ["#000000"] }));
    });

    it("the hue bar sets the hue and the square keeps its saturation and brightness; a finger works as well as a pen", () => {
      render(<Host />);
      openMore();
      fireEvent.change(within(panel()).getByLabelText("Color code"), { target: { value: "#ff0000" } });
      pointer(square(), "pointerdown", 200, 0, "touch");
      pointer(square(), "pointerup", 200, 0, "touch");
      expect(color()).toBe("#ff0000");
      pointer(hueBar(), "pointerdown", 200 / 3, 10, "touch"); // a third across = 120°, green
      expect(color()).toBe("#00ff00");
      pointer(hueBar(), "pointermove", 400 / 3, 10, "touch"); // 240°, blue
      expect(color()).toBe("#0000ff");
      pointer(hueBar(), "pointerup", 400 / 3, 10, "touch");
    });

    it("dragging to grey keeps the hue, so coming back to colour is the same colour", () => {
      render(<Host />);
      openMore();
      fireEvent.change(within(panel()).getByLabelText("Color code"), { target: { value: "#ff0000" } });
      const el = square();
      pointer(el, "pointerdown", 200, 0);
      pointer(hueBar(), "pointerdown", 200 / 3, 10);
      pointer(hueBar(), "pointerup", 200 / 3, 10);
      pointer(el, "pointermove", 0, 0); // no saturation: white
      expect(color()).toBe("#ffffff");
      pointer(el, "pointermove", 200, 0);
      expect(color()).toBe("#00ff00"); // the green it was, not red again
      pointer(el, "pointerup", 200, 0);
    });

    it("the square follows a colour chosen elsewhere", () => {
      render(<Host />);
      openMore();
      fireEvent.click(within(panel()).getByRole("button", { name: "Light blue" }));
      const slider = within(panel()).getByRole("slider", { name: "Saturation and brightness" });
      expect(slider.getAttribute("aria-valuetext")).toBe("Saturation 38%, brightness 100%");
    });

    it("the arrow keys nudge the square (saturation across, brightness up and down) and the hue bar; Shift takes bigger steps", async () => {
      render(<Host />);
      openMore();
      fireEvent.change(within(panel()).getByLabelText("Color code"), { target: { value: "#ff0000" } });
      const sq = within(panel()).getByRole("slider", { name: "Saturation and brightness" });
      fireEvent.keyDown(sq, { key: "ArrowLeft" });
      expect(color()).toBe("#ff0303"); // 99 % saturation
      fireEvent.keyDown(sq, { key: "ArrowDown", shiftKey: true });
      expect(color()).toBe("#e60202"); // 90 % brightness
      fireEvent.keyDown(sq, { key: "ArrowUp" });
      fireEvent.keyDown(sq, { key: "ArrowRight" });
      fireEvent.keyUp(sq, { key: "ArrowRight" });
      await waitFor(() => expect(puts("inkPalette").length).toBeGreaterThan(0)); // kept when the key is let go
      const hue = within(panel()).getByRole("slider", { name: "Hue" });
      const before = hue.getAttribute("aria-valuenow");
      fireEvent.keyDown(hue, { key: "ArrowRight", shiftKey: true });
      expect(Number(hue.getAttribute("aria-valuenow"))).toBe(Number(before) + 15);
      fireEvent.keyDown(hue, { key: "ArrowLeft" });
      expect(Number(hue.getAttribute("aria-valuenow"))).toBe(Number(before) + 14);
    });

    it("an arrow key that belongs to an input method does nothing", () => {
      render(<Host />);
      openMore();
      const sq = within(panel()).getByRole("slider", { name: "Saturation and brightness" });
      const before = color();
      fireEvent.keyDown(sq, { key: "ArrowLeft", isComposing: true, keyCode: 229 });
      expect(color()).toBe(before);
    });
  });

  it("a quick colour can be replaced by the current one, and the toolbar shows it", async () => {
    render(<Host />);
    openMore();
    fireEvent.click(within(panel()).getByRole("button", { name: "Light blue" }));
    fireEvent.click(within(panel()).getByRole("button", { name: "Replace quick color 2" }));
    await waitFor(() => expect(puts("inkPalette").at(-1)).toMatchObject({ quick: ["#15130d", "#9fd8ff", "#315f8f", "#c2871d", "#c43c3c"] }));
    await waitFor(() => expect(quick().map((b) => b.getAttribute("title"))).toEqual(["Ink", "Light blue", "Blue", "Amber", "Red"]));
    // and the current colour is now a quick one: 「更多」 no longer wears it
    expect(screen.getByRole("button", { name: "More colors" }).querySelector(".ink-compact-dot")).toBeNull();
    expect(quick()[1]!.getAttribute("aria-pressed")).toBe("true");
  });

  it("another device's quick colours and made colours arrive", async () => {
    serverPrefs.inkPalette = { quick: ["#000000", "#111111", "#222222", "#333333", "#444444"], recent: [], custom: ["#abcdef"] };
    render(<Host />);
    await waitFor(() => expect(quick().map((b) => b.getAttribute("title"))).toEqual(["#000000", "#111111", "#222222", "#333333", "#444444"]));
    openMore();
    expect(within(panel()).getByRole("button", { name: "#abcdef" })).toBeTruthy();
  });

  it("a stored value that is not a palette leaves the defaults", async () => {
    serverPrefs.inkPalette = { quick: "no" };
    render(<Host />);
    await act(async () => { await Promise.resolve(); });
    expect(quick().map((b) => b.getAttribute("title"))).toEqual(["Ink", "Oxblood", "Blue", "Amber", "Red"]);
  });
});

describe("the hold-still setting", () => {
  it("is on until the person turns it off, and follows the account", async () => {
    const { result, unmount } = renderHook(() => useInkPen({ color: "#000000", sizeId: "medium" }));
    expect(result.current.autoShape).toBe(true);
    await waitFor(() => expect(inkAutoShapePref.store.get().settled).toBe(true)); // the first load is over
    unmount();
    serverPrefs.inkAutoShape = false;
    inkAutoShapePref.store.forget();
    localStorage.clear();
    const again = renderHook(() => useInkPen({ color: "#000000", sizeId: "medium" }));
    await waitFor(() => expect(again.result.current.autoShape).toBe(false));
  });
});
