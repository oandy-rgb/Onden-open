// Colour and size collapse into one button when the tools row would overflow.
// jsdom has no layout, so widths come from stubs and ResizeObserver is driven by hand.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import InkToolbar from "../components/InkToolbar";

const FULL_WIDTH = 749;
let available = 1000;
let observers: Array<() => void> = [];

beforeEach(() => {
  observers = [];
  vi.stubGlobal("ResizeObserver", class {
    constructor(private cb: () => void) {}
    observe() { observers.push(this.cb); }
    disconnect() { observers = observers.filter((cb) => cb !== this.cb); }
    unobserve() {}
  });
  // Expanded content needs FULL_WIDTH; collapsed it needs far less.
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (!this.classList.contains("ink-toolbar-scroll")) return 0;
      return this.querySelector(".ink-swatch") ? FULL_WIDTH : 300;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) { return this.classList.contains("ink-toolbar-scroll") ? available : 0; },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
});

function renderToolbar(props: Partial<React.ComponentProps<typeof InkToolbar>> = {}) {
  const onColorChange = vi.fn();
  const onSizeChange = vi.fn();
  const utils = render(
    <InkToolbar
      tool="pen" onToolChange={() => {}}
      color="#15130d" onColorChange={onColorChange} sizeId="medium" onSizeChange={onSizeChange}
      canUndo canRedo onUndo={() => {}} onRedo={() => {}}
      trailing={<button type="button">more</button>}
      {...props}
    />,
  );
  return { ...utils, onColorChange, onSizeChange };
}

const resize = (width: number) => { available = width; act(() => observers.forEach((cb) => cb())); };

describe("InkToolbar compact", () => {
  it("with room, colour and size stay on the toolbar and there is no collapse button", () => {
    available = 1000;
    renderToolbar();
    expect(screen.getByRole("group", { name: "Color" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Size" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Color and size" })).toBeNull();
  });

  it("without room, one button replaces them; the panel has 5 colours and 3 sizes, picking closes it", () => {
    available = 410;
    const { onColorChange, onSizeChange } = renderToolbar();
    expect(screen.queryByRole("group", { name: "Color" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Color and size" })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Color and size" }));
    let panel = screen.getByRole("dialog", { name: "Color and size" });
    // The five quick colours, and 「更多」 for the rest.
    expect(within(within(panel).getByRole("group", { name: "Color" })).getAllByRole("button")).toHaveLength(6);
    expect(within(panel).getByRole("button", { name: "More colors" })).toBeTruthy();
    expect(within(within(panel).getByRole("group", { name: "Size" })).getAllByRole("button")).toHaveLength(3);
    expect(within(panel).getByRole("button", { name: "Ink" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(panel).getByRole("button", { name: "Medium" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(within(panel).getByRole("button", { name: "Blue" }));
    expect(onColorChange).toHaveBeenCalledWith("#315f8f");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Color and size" }));
    panel = screen.getByRole("dialog", { name: "Color and size" });
    fireEvent.click(within(panel).getByRole("button", { name: "Broad" }));
    expect(onSizeChange).toHaveBeenCalledWith(expect.objectContaining({ id: "broad" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("tools, undo / redo and the trailing menu stay while collapsed", () => {
    available = 410;
    renderToolbar();
    expect(within(screen.getByRole("group", { name: "Tool" })).getAllByRole("button")).toHaveLength(4);
    expect(within(screen.getByRole("group", { name: "History" })).getAllByRole("button")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "more" })).toBeTruthy();
  });

  it("follows the measured width both ways", () => {
    available = 1000;
    renderToolbar();
    resize(410);
    expect(screen.getByRole("button", { name: "Color and size" })).toBeTruthy();
    resize(FULL_WIDTH - 1);
    expect(screen.getByRole("button", { name: "Color and size" })).toBeTruthy();
    resize(FULL_WIDTH);
    expect(screen.queryByRole("button", { name: "Color and size" })).toBeNull();
    expect(screen.getByRole("group", { name: "Color" })).toBeTruthy();
  });
});
