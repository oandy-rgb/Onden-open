import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { Modal, Popover, useInlinePopover, type PopoverPoint } from "../components/ui";
import SelectionToolbar from "../components/SelectionToolbar";

// The popover's point mode is what the editor's floating bubbles and menus sit on:
// above or below a text position, kept in the window and above the keyboard, never
// taking focus from the text being typed in, closed by Esc or a press elsewhere.

function Beside({ at, onClose = vi.fn() }: { at: PopoverPoint; onClose?: () => void }) {
  const pop = useInlinePopover({ open: true, onClose, at });
  return (
    <>
      <textarea aria-label="Text" />
      <Popover popover={pop} label="Suggestions" role="group"><button type="button">One</button></Popover>
    </>
  );
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("usePopover at a point", () => {
  it("puts the bottom edge at y when `above`, and keeps the top edge at y otherwise", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 100, height: 40 } as DOMRect);
    const { unmount } = render(<Beside at={{ x: 50, y: 200, above: true }} />);
    expect(screen.getByRole("group", { name: "Suggestions" }).style.getPropertyValue("--popover-y")).toBe("160px");
    unmount();
    render(<Beside at={{ x: 50, y: 200 }} />);
    expect(screen.getByRole("group", { name: "Suggestions" }).style.getPropertyValue("--popover-y")).toBe("200px");
  });

  it("stays above the on-screen keyboard", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 100, height: 48 } as DOMRect);
    Object.defineProperty(window, "visualViewport", { value: { offsetTop: 0, height: 500 }, configurable: true });
    render(<Beside at={{ x: 50, y: 490 }} />);
    expect(screen.getByRole("group", { name: "Suggestions" }).style.getPropertyValue("--popover-y")).toBe("444px");
    Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });
  });

  it("stays above the editor's bar on top of the keyboard, not only above the keyboard", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return (this.hasAttribute("data-keyboard-bar") ? { top: 440, width: 360, height: 60 } : { width: 100, height: 640 }) as DOMRect;
    });
    Object.defineProperty(window, "visualViewport", { value: { offsetTop: 0, height: 500 }, configurable: true });
    render(<><div data-keyboard-bar /><Beside at={{ x: 50, y: 100, lineTop: 70 }} /></>);
    const surface = screen.getByRole("group", { name: "Suggestions" });
    expect(surface.style.getPropertyValue("--popover-y")).toBe("100px");
    expect(surface.style.getPropertyValue("--popover-room")).toBe("332px");
    Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });
  });

  it("keeps its top on screen when the browser panned the page for the keyboard", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 100, height: 640 } as DOMRect);
    Object.defineProperty(window, "visualViewport", { value: { offsetTop: 225, height: 490 }, configurable: true });
    render(<Beside at={{ x: 50, y: 300 }} />);
    const surface = screen.getByRole("group", { name: "Suggestions" });
    expect(surface.style.getPropertyValue("--popover-y")).toBe("233px");
    expect(surface.style.getPropertyValue("--popover-room")).toBe("474px");
    Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });
  });

  it("stays clear of the line being typed in: the room under it, or above it near the keyboard", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 100, height: 640 } as DOMRect);
    Object.defineProperty(window, "visualViewport", { value: { offsetTop: 0, height: 500 }, configurable: true });
    const { unmount } = render(<Beside at={{ x: 50, y: 100, lineTop: 70 }} />);
    let surface = screen.getByRole("group", { name: "Suggestions" });
    expect(surface.style.getPropertyValue("--popover-y")).toBe("100px");
    expect(surface.style.getPropertyValue("--popover-room")).toBe("392px");
    unmount();
    render(<Beside at={{ x: 50, y: 450, lineTop: 420 }} />);
    surface = screen.getByRole("group", { name: "Suggestions" });
    expect(surface.style.getPropertyValue("--popover-y")).toBe("8px");
    expect(surface.style.getPropertyValue("--popover-room")).toBe("412px");
    Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });
  });

  it("leaves focus in the text, and closes on Esc or a press elsewhere", () => {
    const onClose = vi.fn();
    render(<Beside at={{ x: 10, y: 10 }} onClose={onClose} />);
    const text = screen.getByRole("textbox", { name: "Text" });
    text.focus();
    expect(document.activeElement).toBe(text);
    fireEvent.pointerDown(screen.getByRole("button", { name: "One" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(text, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(text);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("the selection bubble", () => {
  const actions = { onWrap: vi.fn(), onQuote: vi.fn(), onHeading: vi.fn(), onLink: vi.fn() };

  it("is drawn in the layer of the modal it was opened in", () => {
    render(<Modal label="Note" onClose={() => {}}><SelectionToolbar at={{ x: 20, y: 30, above: true }} {...actions} /></Modal>);
    expect(screen.getByRole("toolbar", { name: "Format selection" }).closest("dialog")).toBe(screen.getByRole("dialog", { name: "Note" }));
  });

  it("is dismissed by Esc", () => {
    const onDismiss = vi.fn();
    render(<SelectionToolbar at={{ x: 20, y: 30 }} onDismiss={onDismiss} {...actions} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
