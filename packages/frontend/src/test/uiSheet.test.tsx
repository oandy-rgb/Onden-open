import { afterEach, describe, it, expect, vi } from "vitest";
import { act, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { DockedSheet, Sheet } from "../components/ui";

// ui/Sheet: what jsdom can see — the structure, the keyboard variable, the
// steady marker and Modal's dismissal. Where the card sits (bottom edge,
// keyboard top edge, a fixed top) is measured in a real browser.

const layer = () => document.querySelector("dialog.ui-sheet-layer") as HTMLDialogElement;
const card = () => document.querySelector(".ui-sheet") as HTMLElement;

function fakeVisualViewport(height: number) {
  const listeners = new Set<() => void>();
  const vv = {
    height, offsetTop: 0,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
  return { resize: (next: number) => { vv.height = next; listeners.forEach((fn) => fn()); } };
}

afterEach(() => Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined }));

describe("ui/Sheet", () => {
  it("is a named modal whose card has a handle and the caller's class", () => {
    render(<Sheet label="Move" className="my-layer" cardClassName="my-card" onClose={vi.fn()}><p>Body</p></Sheet>);
    expect(screen.getByRole("dialog", { name: "Move" })).toBe(layer());
    expect(layer().classList.contains("my-layer")).toBe(true);
    expect(card().classList.contains("my-card")).toBe(true);
    expect(card().firstElementChild?.classList.contains("ui-sheet-handle")).toBe(true);
    expect(card().classList.contains("ui-sheet--steady")).toBe(false);
    expect(layer().classList.contains("ui-sheet-layer--bottom")).toBe(false);
  });

  it("steady and desktop=\"bottom\" are marked for the stylesheet", () => {
    render(<Sheet label="Move" steady desktop="bottom" onClose={vi.fn()}>x</Sheet>);
    expect(card().classList.contains("ui-sheet--steady")).toBe(true);
    expect(layer().classList.contains("ui-sheet-layer--bottom")).toBe(true);
  });

  it("steady takes the content's own height when it is shorter than the room, else all of it", () => {
    const realStyle = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) =>
      (el as Element).classList?.contains("ui-sheet") ? ({ maxHeight: "700px" } as CSSStyleDeclaration) : realStyle(el, pseudo));
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: 260 } as DOMRect);
    const { unmount } = render(<Sheet label="Move" steady onClose={vi.fn()}>two places</Sheet>);
    expect(card().style.getPropertyValue("--ui-sheet-steady-height")).toBe("260px");
    expect(card().hasAttribute("data-fitting")).toBe(false);
    unmount();
    rect.mockReturnValue({ height: 700 } as DOMRect);
    render(<Sheet label="Move" steady onClose={vi.fn()}>many places</Sheet>);
    expect(card().style.getPropertyValue("--ui-sheet-steady-height")).toBe("");
    expect(card().hasAttribute("data-fitting")).toBe(false);
    vi.restoreAllMocks();
  });

  it("writes the keyboard's inset on the card while the keyboard is up", () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    const vv = fakeVisualViewport(800);
    vi.useFakeTimers();
    render(<Sheet label="Move" onClose={vi.fn()}>x</Sheet>);
    expect(card().style.getPropertyValue("--kb-inset")).toBe("0px");
    expect(card().hasAttribute("data-keyboard")).toBe(false);
    // It moves once the viewport is still, not on every event while the keyboard rises.
    act(() => { vv.resize(700); vv.resize(500); });
    expect(card().style.getPropertyValue("--kb-inset")).toBe("0px");
    act(() => vi.advanceTimersByTime(150));
    expect(card().style.getPropertyValue("--kb-inset")).toBe("300px");
    expect(card().hasAttribute("data-keyboard")).toBe(true);
    act(() => { vv.resize(800); vi.advanceTimersByTime(150); });
    expect(card().style.getPropertyValue("--kb-inset")).toBe("0px");
    vi.useRealTimers();
  });

  it("dragging the handle down far enough closes the sheet; a short drag springs back", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<Sheet label="Move" onClose={onClose}>x</Sheet>);
    vi.spyOn(card(), "offsetHeight", "get").mockReturnValue(400);
    const handle = card().querySelector(".ui-sheet-handle")!;
    const at = (event: Event, time: number) => { Object.defineProperty(event, "timeStamp", { value: time }); return event; };
    // Slow drags (a second long): only the distance decides.
    const drag = (to: number, ms: number) => {
      fireEvent(handle, at(createEvent.pointerDown(handle, { clientY: 100, button: 0 }), 1));
      fireEvent.pointerMove(handle, { clientY: 100 + to });
      expect(card().style.transform).toBe(`translateY(${to}px)`);
      fireEvent(handle, at(createEvent.pointerUp(handle, { clientY: 100 + to }), ms));
    };
    drag(40, 1000);
    expect(card().style.transform).toBe("");
    act(() => vi.advanceTimersByTime(200));
    expect(onClose).not.toHaveBeenCalled();
    drag(150, 1000);
    act(() => vi.advanceTimersByTime(200));
    expect(onClose).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("dragging up grows a card whose content is cut off, and a card that shows everything only gives a little", () => {
    vi.useFakeTimers();
    render(<Sheet label="Move" onClose={vi.fn()}>x</Sheet>);
    const el = card();
    const handle = el.querySelector(".ui-sheet-handle")!;
    vi.spyOn(el, "offsetHeight", "get").mockReturnValue(300);
    const scroll = vi.spyOn(el, "scrollHeight", "get").mockReturnValue(500);
    const at = (event: Event, time: number) => { Object.defineProperty(event, "timeStamp", { value: time }); return event; };
    const drag = (to: number) => {
      fireEvent(handle, at(createEvent.pointerDown(handle, { clientY: 400, button: 0 }), 1));
      fireEvent.pointerMove(handle, { clientY: 400 + to });
    };
    const release = (to: number) => fireEvent(handle, at(createEvent.pointerUp(handle, { clientY: 400 + to }), 1000));
    // 200px of content is hidden: the card grows with the finger, at most by that.
    drag(-120);
    expect(el.style.height).toBe("420px");
    release(-120);
    expect(el.style.height).toBe("500px"); // far enough: it stays at its full height
    el.style.height = "";
    drag(-20);
    release(-20);
    expect(el.style.height).toBe("300px"); // not far enough: back to where it was
    act(() => { el.dispatchEvent(new Event("transitionend")); });
    expect(el.style.height).toBe("");
    // Everything shows: it moves up a fifth of the finger, at most 24px, and springs back.
    scroll.mockReturnValue(300);
    drag(-60);
    expect(el.style.height).toBe("");
    expect(el.style.transform).toBe("translateY(-12px)");
    drag(-400);
    expect(el.style.transform).toBe("translateY(-24px)");
    release(-400);
    expect(el.style.transform).toBe("");
    vi.useRealTimers();
  });

  it("Esc asks to close, and busy holds it open", () => {
    const onClose = vi.fn();
    const { rerender } = render(<Sheet label="Move" onClose={onClose}>x</Sheet>);
    fireEvent(layer(), new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<Sheet label="Move" busy onClose={onClose}>x</Sheet>);
    fireEvent(layer(), new Event("cancel", { cancelable: true }));
    fireEvent.pointerDown(layer()); fireEvent.click(layer());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// DockedSheet: not a modal — a bottom panel over a page that stays usable, three heights.
describe("ui/DockedSheet", () => {
  const docked = (height: "bar" | "half" | "full", onHeightChange = vi.fn()) => (
    <DockedSheet label="Panel" dock={{ height, onHeightChange, bar: <span>row</span> }}><p>Body</p></DockedSheet>
  );
  const dock = () => document.querySelector(".ui-sheet-dock") as HTMLElement;
  const handle = () => dock().querySelector(".ui-sheet-handle") as HTMLElement;

  it("is a named region, not a dialog: no modal layer, nothing behind it is inert or locked", () => {
    render(<><button>page</button>{docked("half")}</>);
    expect(screen.getByRole("region", { name: "Panel" })).toBe(dock());
    expect(document.querySelector("dialog")).toBeNull();
    expect(document.body.style.overflow).not.toBe("hidden");
    expect(screen.getByRole("button", { name: "page" }).closest("[inert]")).toBeNull();
    expect(dock().getAttribute("data-height")).toBe("half");
  });

  it("the bar height shows the bar row and keeps the body mounted but hidden", () => {
    const { rerender } = render(docked("bar"));
    expect(screen.getByText("row")).toBeInTheDocument();
    expect(screen.getByText("Body").parentElement).toHaveAttribute("hidden");
    rerender(docked("half"));
    expect(screen.queryByText("row")).toBeNull();
    expect(screen.getByText("Body").parentElement).not.toHaveAttribute("hidden");
  });

  it("a drag on the handle goes one height up or down; a tap on the bar opens half; a short move does nothing", () => {
    const change = vi.fn();
    const { rerender } = render(docked("half", change));
    const drag = (from: number, to: number) => { fireEvent.pointerDown(handle(), { clientY: from, button: 0 }); fireEvent.pointerMove(handle(), { clientY: to }); fireEvent.pointerUp(handle(), { clientY: to }); };
    drag(100, 180); expect(change).toHaveBeenLastCalledWith("bar");
    drag(180, 100); expect(change).toHaveBeenLastCalledWith("full");
    change.mockClear(); drag(100, 110); expect(change).not.toHaveBeenCalled();
    rerender(docked("bar", change));
    drag(100, 100); expect(change).toHaveBeenLastCalledWith("half");
    rerender(docked("full", change));
    change.mockClear(); drag(100, 20); expect(change).not.toHaveBeenCalled(); // nothing above full
  });

  it("publishes its height so the page's last lines stay reachable, and takes it back when it goes", () => {
    const { unmount } = render(docked("half"));
    expect(document.documentElement.style.getPropertyValue("--ui-dock-clearance")).not.toBe("");
    unmount();
    expect(document.documentElement.style.getPropertyValue("--ui-dock-clearance")).toBe("");
  });
});
