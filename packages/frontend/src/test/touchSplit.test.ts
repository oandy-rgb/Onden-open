import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTouchSplit } from "../lib/ink";

type Pt = [id: number, x: number, y: number, type?: string];

/** `touches` = everything the browser still thinks is down; `changed` = the
 *  contacts this event is about. */
const touchEvent = (type: string, touches: Pt[], changed: Pt[] = touches) => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  const point = ([identifier, clientX, clientY, touchType]: Pt) => ({ identifier, clientX, clientY, touchType });
  Object.assign(e, { touches: touches.map(point), changedTouches: changed.map(point) });
  return e;
};

describe("touch split: a finger the container never saw lift", () => {
  const pinch = { start: vi.fn(), move: vi.fn(), end: vi.fn() };
  let el: HTMLElement;
  let dispose: () => void;
  let penOwned = false;

  beforeEach(() => {
    Object.values(pinch).forEach((f) => f.mockClear());
    penOwned = false;
    el = document.createElement("div");
    document.body.appendChild(el);
    dispose = installTouchSplit(el, { penOwned: () => penOwned, pinch });
  });
  afterEach(() => {
    dispose();
    el.remove();
  });

  const send = (e: Event) => {
    el.dispatchEvent(e);
    return e.defaultPrevented;
  };

  it("one finger scrolls natively after a pinch whose second touchend was lost", () => {
    expect(send(touchEvent("touchstart", [[1, 100, 300], [2, 200, 300]]))).toBe(true);
    expect(pinch.start).toHaveBeenCalledTimes(1);
    // First finger lifts normally; the page is redrawn, so finger 2's touchend never arrives.
    send(touchEvent("touchend", [[2, 200, 300]], [[1, 100, 300]]));
    expect(pinch.end).toHaveBeenCalledTimes(1);

    pinch.start.mockClear();
    expect(send(touchEvent("touchstart", [[3, 150, 400]]))).toBe(false);
    expect(send(touchEvent("touchmove", [[3, 150, 380]]))).toBe(false);
    expect(pinch.start).not.toHaveBeenCalled();
    expect(pinch.move).not.toHaveBeenCalled();
  });

  it("neither touchend arrived: the next single finger is still just a scroll", () => {
    send(touchEvent("touchstart", [[1, 100, 300], [2, 200, 300]]));
    pinch.start.mockClear();
    expect(send(touchEvent("touchstart", [[3, 150, 400]]))).toBe(false);
    expect(pinch.end).toHaveBeenCalledTimes(1);
    expect(pinch.start).not.toHaveBeenCalled();
  });

  it("a touchmove that no longer lists a pinch finger ends the pinch and lets the browser scroll", () => {
    send(touchEvent("touchstart", [[1, 100, 300], [2, 200, 300]]));
    expect(send(touchEvent("touchmove", [[1, 90, 300], [2, 210, 300]]))).toBe(true);
    expect(pinch.move).toHaveBeenCalledTimes(1);
    expect(send(touchEvent("touchmove", [[1, 90, 310]]))).toBe(false);
    expect(pinch.end).toHaveBeenCalledTimes(1);
    expect(pinch.move).toHaveBeenCalledTimes(1);
  });

  it("a touchend elsewhere in the document that drops a pinch finger still applies the preview", () => {
    send(touchEvent("touchstart", [[1, 100, 300], [2, 200, 300]]));
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    outside.dispatchEvent(touchEvent("touchend", [[1, 100, 300]], [[2, 200, 300]]));
    expect(pinch.end).toHaveBeenCalledTimes(1);
    outside.remove();
  });

  it("a pen contact whose touchend was lost does not turn later fingers into palms", () => {
    penOwned = true;
    expect(send(touchEvent("touchstart", [[9, 50, 50, "stylus"]]))).toBe(true);
    // Pen lifted but its touchend never reached the container.
    expect(send(touchEvent("touchstart", [[4, 150, 400]]))).toBe(false);
  });

  it("keeps the existing rules: a live pen still cancels, two real fingers still pinch", () => {
    penOwned = true;
    expect(send(touchEvent("touchstart", [[9, 50, 50, "stylus"]]))).toBe(true);
    expect(send(touchEvent("touchstart", [[9, 50, 50, "stylus"], [4, 150, 400]], [[4, 150, 400]]))).toBe(true); // palm
    expect(pinch.start).not.toHaveBeenCalled();
    send(touchEvent("touchend", [[4, 150, 400]], [[9, 50, 50, "stylus"]]));
    penOwned = false;
    send(touchEvent("touchstart", [[1, 100, 300], [2, 200, 300]]));
    expect(pinch.start).toHaveBeenCalledTimes(1);
  });
});
