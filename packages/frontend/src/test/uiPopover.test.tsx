import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { Modal } from "../components/ui/Modal";
import { installFakeCloseWatcher, liveWatchers, requestClose } from "./fakeCloseWatcher";
import { usePopover } from "../components/ui/usePopover";
import { Menu, MenuItem, Popover } from "../components/ui/Popover";

// The shared floating surfaces: every menu closes and hands focus back the
// same way, so these pin the behaviour once instead of per menu.

function Harness({ onPick = vi.fn(), onKeep = vi.fn() }: { onPick?: () => void; onKeep?: () => void }) {
  const [open, setOpen] = useState(false);
  const [sort, setSort] = useState("a");
  const pop = usePopover<HTMLButtonElement>({ open, onClose: () => setOpen(false) });
  return (
    <div>
      <button type="button" ref={pop.anchor}
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>Open</button>
      <button type="button">Elsewhere</button>
      {open && (
        <Menu popover={pop} label="Things">
          <MenuItem onSelect={onPick}>Pick</MenuItem>
          <MenuItem keepOpen onSelect={onKeep}>Keep</MenuItem>
          <MenuItem disabled onSelect={vi.fn()}>Off</MenuItem>
          <MenuItem checked={sort === "a"} onSelect={() => setSort("a")}>Sort A</MenuItem>
          <MenuItem checked={sort === "b"} onSelect={() => setSort("b")}>Sort B</MenuItem>
        </Menu>
      )}
    </div>
  );
}

const trigger = () => screen.getByRole("button", { name: "Open" });
const menu = () => screen.queryByRole("menu", { name: "Things" });

describe("ui/Popover", () => {
  it("opens focused, runs an item and closes, handing focus back to the trigger", () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    trigger().focus();
    fireEvent.click(trigger());
    expect(document.activeElement).toBe(menu());
    fireEvent.click(screen.getByRole("menuitem", { name: "Pick" }));
    expect(onPick).toHaveBeenCalledOnce();
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("keepOpen items run without closing", () => {
    const onKeep = vi.fn();
    render(<Harness onKeep={onKeep} />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("menuitem", { name: "Keep" }));
    expect(onKeep).toHaveBeenCalledOnce();
    expect(menu()).not.toBeNull();
  });

  it("closes on Esc and on a press outside, but a press on the trigger toggles", () => {
    render(<Harness />);
    fireEvent.click(trigger());
    fireEvent.keyDown(menu()!, { key: "Escape" });
    expect(menu()).toBeNull();

    fireEvent.click(trigger());
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(menu()).toBeNull();

    fireEvent.click(trigger());
    fireEvent.pointerDown(trigger());
    expect(menu()).not.toBeNull();
    fireEvent.click(trigger());
    expect(menu()).toBeNull();
  });

  it("Tab leaves a menu, and Esc while an IME is composing only cancels the candidate", () => {
    render(<Harness />);
    fireEvent.click(trigger());
    fireEvent.keyDown(menu()!, { key: "Escape", isComposing: true });
    expect(menu()).not.toBeNull();
    fireEvent.keyDown(menu()!, { key: "Tab" });
    expect(menu()).toBeNull();
  });

  it("a press inside the surface does not close it", () => {
    render(<Harness />);
    fireEvent.click(trigger());
    fireEvent.pointerDown(menu()!);
    expect(menu()).not.toBeNull();
  });

  it("arrow keys, Home and End move between enabled items and wrap", () => {
    render(<Harness />);
    fireEvent.click(trigger());
    const surface = menu()!;
    fireEvent.keyDown(surface, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Pick");
    fireEvent.keyDown(surface, { key: "ArrowDown" });
    fireEvent.keyDown(surface, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Sort A");
    fireEvent.keyDown(surface, { key: "End" });
    expect(document.activeElement?.textContent).toBe("Sort B");
    fireEvent.keyDown(surface, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Pick");
    fireEvent.keyDown(surface, { key: "ArrowUp" });
    expect(document.activeElement?.textContent).toBe("Sort B");
    fireEvent.keyDown(surface, { key: "Home" });
    expect(document.activeElement?.textContent).toBe("Pick");
  });

  it("a choice item says which one is current", () => {
    render(<Harness />);
    fireEvent.click(trigger());
    expect(screen.getByRole("menuitemradio", { name: "Sort A" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Sort B" }));
    fireEvent.click(trigger());
    expect(screen.getByRole("menuitemradio", { name: "Sort B" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "Sort A" })).toHaveAttribute("aria-checked", "false");
  });

  it("a point-placed surface stays inside the viewport", () => {
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(320);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 200, height: 100 } as DOMRect);
    function AtPoint() {
      const pop = usePopover({ open: true, onClose: vi.fn(), at: { x: 300, y: 390 } });
      return <Popover popover={pop} label="Here"><button type="button">x</button></Popover>;
    }
    render(<AtPoint />);
    const surface = screen.getByRole("dialog", { name: "Here" });
    expect(surface.style.getPropertyValue("--popover-x")).toBe("112px");
    expect(surface.style.getPropertyValue("--popover-y")).toBe("292px");
    vi.restoreAllMocks();
  });

  function Field() {
    const [open, setOpen] = useState(false);
    const pop = usePopover<HTMLDivElement>({ open, onClose: () => setOpen(false) });
    return (
      <div>
        <div ref={pop.anchor}><button type="button" onClick={() => setOpen(true)}>Open</button></div>
        {open && <Popover popover={pop} label="Search"><input aria-label="Query" autoFocus /></Popover>}
      </div>
    );
  }

  it("hands focus back to the trigger on Esc even when the content autofocuses a field", () => {
    render(<Field />);
    trigger().focus();
    fireEvent.click(trigger());
    expect(document.activeElement).toBe(screen.getByLabelText("Query"));
    fireEvent.keyDown(screen.getByLabelText("Query"), { key: "Escape" });
    expect(screen.queryByLabelText("Query")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("falls back to the first button in the anchor when the trigger did not hold focus", () => {
    render(<Field />);
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.click(trigger());
    fireEvent.keyDown(screen.getByLabelText("Query"), { key: "Escape" });
    expect(document.activeElement).toBe(trigger());
  });
});

describe("ui/Popover nested", () => {
  function Nested({ onOuterClose }: { onOuterClose: () => void }) {
    const outer = usePopover<HTMLButtonElement>({ open: true, onClose: onOuterClose });
    const [innerOpen, setInnerOpen] = useState(true);
    const inner = usePopover<HTMLButtonElement>({ open: innerOpen, onClose: () => setInnerOpen(false) });
    return (
      <div>
        <button type="button" ref={outer.anchor}>Outer trigger</button>
        <Popover popover={outer} label="Outer">
          <button type="button" ref={inner.anchor}>Inner trigger</button>
          {innerOpen && <Popover popover={inner} label="Inner"><button type="button">Inside inner</button></Popover>}
        </Popover>
      </div>
    );
  }

  it("a press inside a popover opened from another popover does not close the one under it", () => {
    const onOuterClose = vi.fn();
    render(<Nested onOuterClose={onOuterClose} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Inside inner" }));
    expect(onOuterClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onOuterClose).toHaveBeenCalledTimes(1);
  });
});

// Back (a close request in browsers with CloseWatcher): a menu closes first; the dialog under it stays.
describe("ui/Popover and Back", () => {
  beforeEach(() => { installFakeCloseWatcher(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("closes an open menu and leaves the page's modal for the next Back", () => {
    const onModalClose = vi.fn();
    render(<Modal label="Sheet" onClose={onModalClose}><Harness /></Modal>);
    fireEvent.click(trigger());
    expect(menu()).not.toBeNull();
    requestClose();
    expect(menu()).toBeNull();
    expect(onModalClose).not.toHaveBeenCalled();
    expect(liveWatchers()).toHaveLength(0);
  });
});
