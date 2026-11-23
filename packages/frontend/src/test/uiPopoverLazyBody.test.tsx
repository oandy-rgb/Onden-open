import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";

import { Popover, usePopover } from "../components/ui";

// The create popover's body is lazily loaded: on the first open the surface mounts a moment AFTER `open` turned true.
// It used to stay at the corner it started in (top-left, over the top bar) until the next open.
function LazyBody() {
  const [open, setOpen] = useState(false);
  const [bodyLoaded, setBodyLoaded] = useState(false);
  const pop = usePopover<HTMLButtonElement>({ open, onClose: () => setOpen(false), placement: "bottom-start" });
  useEffect(() => { if (open) { const id = setTimeout(() => setBodyLoaded(true), 0); return () => clearTimeout(id); } }, [open]);
  return (
    <>
      <button type="button" ref={pop.anchor} onClick={() => setOpen(true)}>Plus</button>
      {open && bodyLoaded && <Popover popover={pop} label="Create"><button type="button">Go</button></Popover>}
    </>
  );
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("usePopover when the surface mounts after it opens", () => {
  it("is placed next to its anchor, not left at the corner", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return (this.tagName === "BUTTON" && this.textContent === "Plus"
        ? { left: 300, right: 340, top: 40, bottom: 80, width: 40, height: 40 }
        : { left: 0, right: 100, top: 0, bottom: 60, width: 100, height: 60 }) as DOMRect;
    });
    Object.defineProperty(document.documentElement, "clientWidth", { value: 1204, configurable: true });
    render(<LazyBody />);
    await act(async () => { screen.getByRole("button", { name: "Plus" }).click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    const surface = screen.getByRole("dialog", { name: "Create" });
    expect(surface.style.getPropertyValue("--popover-x")).toBe("300px");
    expect(surface.style.getPropertyValue("--popover-y")).toBe("86px");
  });
});
