// @vitest-environment jsdom
// The 「引用」 frame over a handwriting page: drag out, pull a corner, copy, cancel — and the input
// policy: a finger that only scrolls never frames.

import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import type { InkRegion } from "@onden/markdown/ink";
import { InkRegionLayer, type CopyNotice } from "../components/page";

const SIZE = { width: 1000, height: 1400 };
// 1 page unit = 0.5 css px: the page is 500 × 700 at the origin.
const rect = { left: 0, top: 0, width: 500, height: 700, right: 500, bottom: 700, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;

function Host({ stylusOnly = false, onCopy = () => {}, notice = null, initial = null, onPenSeen }: { stylusOnly?: boolean; onCopy?: () => void; notice?: CopyNotice | null; initial?: InkRegion | null; onPenSeen?: () => void }) {
  const [region, setRegion] = useState<InkRegion | null>(initial);
  return <InkRegionLayer pageKey="p" pageSize={SIZE} active stylusOnly={stylusOnly} region={region} onRegionChange={setRegion} onCopy={onCopy} notice={notice} marked={null} onPenSeen={onPenSeen} />;
}
const pointer = (el: Element, type: string, x: number, y: number, pointerType = "mouse", id = 1) =>
  fireEvent(el, Object.assign(new Event(type, { bubbles: true, cancelable: true }), { clientX: x, clientY: y, pointerId: id, pointerType, button: 0, isPrimary: true }));
const drag = (el: Element, from: [number, number], to: [number, number], pointerType = "mouse") => {
  pointer(el, "pointerdown", ...from, pointerType);
  pointer(el, "pointermove", ...to, pointerType);
  pointer(el, "pointerup", ...to, pointerType);
};
const frame = (c: HTMLElement) => c.querySelector<HTMLElement>(".ink-region-frame");

// test/setup.ts restores spies after every test: each test mocks its own.
beforeEach(() => { vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect); });

describe("InkRegionLayer", () => {
  it("a drag makes a frame in page units, with a visible 「複製引用」 beside it", () => {
    const { container, getByText } = render(<Host />);
    drag(container.querySelector("[data-ink-region-capture]")!, [50, 100], [250, 200]);
    expect(frame(container)!.style.getPropertyValue("--rl")).toBe("10%");
    expect(frame(container)!.style.getPropertyValue("--rw")).toBe("40%");
    expect(getByText("Copy reference")).not.toBeNull();
  });

  it("a tap or a speck makes none and puts the old frame away", () => {
    const { container } = render(<Host initial={{ page: "p", x: 100, y: 100, w: 300, h: 300 }} />);
    expect(frame(container)).not.toBeNull();
    pointer(container.querySelector("[data-ink-region-capture]")!, "pointerdown", 400, 400);
    pointer(container.querySelector("[data-ink-region-capture]")!, "pointerup", 400, 400);
    expect(frame(container)).toBeNull();
  });

  it("Esc and 「取消」 cancel", () => {
    const { container } = render(<Host initial={{ page: "p", x: 100, y: 100, w: 300, h: 300 }} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(frame(container)).toBeNull();
    const again = render(<Host initial={{ page: "p", x: 100, y: 100, w: 300, h: 300 }} />);
    fireEvent.click(again.getByText("Cancel"));
    expect(frame(again.container)).toBeNull();
  });

  it("pulling a corner resizes and never goes below the smallest size", () => {
    const { container } = render(<Host initial={{ page: "p", x: 100, y: 100, w: 300, h: 300 }} />);
    const handle = container.querySelector("[data-ink-region-handle=se]")!;
    pointer(handle, "pointerdown", 200, 200);
    pointer(handle, "pointermove", 20, 20); // far past the opposite corner
    pointer(handle, "pointerup", 20, 20);
    expect(frame(container)!.style.getPropertyValue("--rw")).toBe("2.4%"); // 24 of 1000 units
  });

  it("copy is the button's own click; the fallback text is shown when copying failed", () => {
    const onCopy = vi.fn();
    const { getByText, getByLabelText } = render(<Host initial={{ page: "p", x: 100, y: 100, w: 300, h: 300 }} onCopy={onCopy} notice={{ kind: "manual", text: "![[A|ink=p@1,2,3,4]]" }} />);
    fireEvent.click(getByText("Copy reference"));
    expect(onCopy).toHaveBeenCalledOnce();
    expect((getByLabelText("Reference") as HTMLInputElement).value).toBe("![[A|ink=p@1,2,3,4]]");
  });

  it("a finger that only scrolls never frames; the pen still does", () => {
    const { container } = render(<Host stylusOnly />);
    const capture = container.querySelector("[data-ink-region-capture]")!;
    drag(capture, [50, 100], [250, 200], "touch");
    expect(frame(container)).toBeNull();
    drag(capture, [50, 100], [250, 200], "pen");
    expect(frame(container)).not.toBeNull();
  });

  it("a second finger cancels the frame being dragged (a pinch)", () => {
    const { container } = render(<Host />);
    const capture = container.querySelector("[data-ink-region-capture]")!;
    pointer(capture, "pointerdown", 50, 100, "touch", 1);
    pointer(capture, "pointerdown", 300, 300, "touch", 2);
    pointer(capture, "pointermove", 250, 200, "touch", 1);
    pointer(capture, "pointerup", 250, 200, "touch", 1);
    expect(frame(container)).toBeNull();
  });
});

describe("input policy on the frame itself", () => {
  const frameOf = { page: "p", x: 100, y: 100, w: 300, h: 300 } as InkRegion;
  it("a finger that only scrolls cannot move or resize the frame; the pen can", () => {
    const { container } = render(<Host stylusOnly initial={frameOf} />);
    const handle = container.querySelector("[data-ink-region-handle=se]")!;
    pointer(handle, "pointerdown", 200, 200, "touch");
    pointer(handle, "pointermove", 300, 300, "touch");
    pointer(handle, "pointerup", 300, 300, "touch");
    expect(frame(container)!.style.getPropertyValue("--rw")).toBe("30%");
    pointer(handle, "pointerdown", 200, 200, "pen");
    pointer(handle, "pointermove", 300, 300, "pen");
    pointer(handle, "pointerup", 300, 300, "pen");
    expect(frame(container)!.style.getPropertyValue("--rw")).not.toBe("30%");
    expect(container.querySelector(".ink-region-layer--finger-scrolls")).not.toBeNull(); // and the CSS lets it scroll
  });

  it("the pen on this layer is reported as seen, as on the drawing surface", () => {
    const onPenSeen = vi.fn();
    const { container } = render(<Host onPenSeen={onPenSeen} />);
    drag(container.querySelector("[data-ink-region-capture]")!, [50, 100], [250, 200], "pen");
    expect(onPenSeen).toHaveBeenCalled();
  });
});
