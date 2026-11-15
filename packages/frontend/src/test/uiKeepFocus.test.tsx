import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, createEvent } from "@testing-library/react";
import { usePopover } from "../components/ui/usePopover";
import { Popover } from "../components/ui/Popover";
import { keepFocus } from "../components/ui/keepFocus";

// A floating surface beside the editor never takes focus from it on a press (the keyboard stays up): one rule in
// the shared layer, so rows need nothing of their own. jsdom has no focus-on-mousedown default; what is pinned is
// that the default is prevented exactly where it must be (the real focus is checked in e2e/browser-app/touchFocusCaret.mjs).

function Surface({ keepFocus: keep, onClose = vi.fn() }: { keepFocus: boolean; onClose?: () => void }) {
  const pop = usePopover({ open: true, onClose, at: { x: 10, y: 10 }, keepFocus: keep });
  return (
    <Popover popover={pop} label="Menu" role="group">
      <div data-testid="padding">
        <button type="button">Row</button>
        <input aria-label="Filter" />
      </div>
    </Popover>
  );
}

const press = (el: Element) => { const e = createEvent.mouseDown(el, { bubbles: true, cancelable: true }); fireEvent(el, e); return e.defaultPrevented; };

describe("keepFocus surfaces", () => {
  it("a press on the surface outside any row does not take focus, nor does a row", () => {
    render(<Surface keepFocus />);
    expect(press(screen.getByRole("group"))).toBe(true);
    expect(press(screen.getByTestId("padding"))).toBe(true);
    expect(press(screen.getByRole("button", { name: "Row" }))).toBe(true);
  });

  it("a text field inside stays focusable", () => {
    render(<Surface keepFocus />);
    expect(press(screen.getByRole("textbox", { name: "Filter" }))).toBe(false);
  });

  it("a surface that is not keepFocus leaves presses alone", () => {
    render(<Surface keepFocus={false} />);
    expect(press(screen.getByTestId("padding"))).toBe(false);
  });

  it("a finger scroll is not touched: no touch or pointer move is prevented", () => {
    render(<Surface keepFocus />);
    const pad = screen.getByTestId("padding");
    for (const make of [createEvent.touchStart, createEvent.touchMove, createEvent.pointerMove]) {
      const e = make(pad, { bubbles: true, cancelable: true });
      fireEvent(pad, e);
      expect(e.defaultPrevented).toBe(false);
    }
  });

  it("Esc on the surface still closes it", () => {
    const onClose = vi.fn();
    render(<Surface keepFocus onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("group"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keepFocus(event) spares text fields and prevents everything else", () => {
    const prevent = vi.fn();
    const field = document.createElement("textarea");
    keepFocus({ target: field, preventDefault: prevent });
    expect(prevent).not.toHaveBeenCalled();
    keepFocus({ target: document.createElement("span"), preventDefault: prevent });
    expect(prevent).toHaveBeenCalledOnce();
  });
});
