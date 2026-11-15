// Palm rejection (ipad-ink persona): a resting palm must never claim the
// pointer or leave stray strokes once a stylus is in play. Drives the real
// InkEngine pointer pipeline through synthetic pointer events in jsdom.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InkEngine } from "../lib/ink/engine";
import type { ICommittedRenderer } from "../lib/ink/committed";
import type { InkDocument } from "../lib/ink/types";

function stubRenderer(): ICommittedRenderer {
  return {
    kind: "canvas2d",
    commitStrokes() {},
    setView() {},
    resize() {},
    destroy() {},
  };
}

// jsdom has no real PointerEvent pipeline; build a plain Event and graft on the
// pointer fields the engine reads. setPointerCapture is also absent → stub it.
function pointer(
  type: "pointerdown" | "pointermove" | "pointerup",
  opts: { pointerId: number; pointerType: "pen" | "touch" | "mouse"; x?: number; y?: number; button?: number },
): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, {
    pointerId: opts.pointerId,
    pointerType: opts.pointerType,
    button: opts.button ?? 0,
    clientX: opts.x ?? 0,
    clientY: opts.y ?? 0,
    pressure: 0.5,
    getCoalescedEvents: () => [],
  });
  return e;
}

function makeEngine() {
  const el = document.createElement("div");
  (el as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
  (el as unknown as { releasePointerCapture: () => void }).releasePointerCapture = () => {};
  document.body.appendChild(el);
  const engine = new InkEngine({
    committedRenderer: stubRenderer(),
    wetCanvas: document.createElement("canvas"),
    manageCanvasSize: false,
  });
  const dispose = engine.addPointerHandlers(el);
  return { engine, el, dispose };
}

function strokeCount(doc: InkDocument): number {
  return doc.strokes.length;
}

describe("InkEngine palm rejection", () => {
  beforeEach(() => {
    // No-op rAF: the engine's endInput drains the buffer synchronously via
    // processBuffer(), so the stroke commits without ever running a frame —
    // and a self-rescheduling tick can't recurse the stack in the test.
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("ignores a resting-palm touch once a stylus has drawn", () => {
    const { engine, el, dispose } = makeEngine();

    // Pen draws a stroke → pen-only mode latches.
    el.dispatchEvent(pointer("pointerdown", { pointerId: 1, pointerType: "pen", x: 10, y: 10 }));
    el.dispatchEvent(pointer("pointermove", { pointerId: 1, pointerType: "pen", x: 20, y: 20 }));
    el.dispatchEvent(pointer("pointerup", { pointerId: 1, pointerType: "pen", x: 20, y: 20 }));
    expect(strokeCount(engine.serialize())).toBe(1);

    // A resting palm now touches: must be dropped (no stray stroke).
    el.dispatchEvent(pointer("pointerdown", { pointerId: 2, pointerType: "touch", x: 100, y: 100 }));
    el.dispatchEvent(pointer("pointermove", { pointerId: 2, pointerType: "touch", x: 140, y: 140 }));
    el.dispatchEvent(pointer("pointerup", { pointerId: 2, pointerType: "touch", x: 140, y: 140 }));
    expect(strokeCount(engine.serialize())).toBe(1);

    dispose();
    engine.destroy();
  });

  it("lets a pen preempt a palm stroke that landed first", () => {
    const { engine, el, dispose } = makeEngine();

    // Palm lands a frame before the stylus.
    el.dispatchEvent(pointer("pointerdown", { pointerId: 5, pointerType: "touch", x: 200, y: 200 }));
    el.dispatchEvent(pointer("pointermove", { pointerId: 5, pointerType: "touch", x: 210, y: 210 }));

    // Pen arrives → preempts the palm, palm's wet stroke is discarded.
    el.dispatchEvent(pointer("pointerdown", { pointerId: 6, pointerType: "pen", x: 10, y: 10 }));
    // Palm keeps moving but is no longer the active pointer → ignored.
    el.dispatchEvent(pointer("pointermove", { pointerId: 5, pointerType: "touch", x: 220, y: 220 }));
    el.dispatchEvent(pointer("pointermove", { pointerId: 6, pointerType: "pen", x: 30, y: 30 }));
    el.dispatchEvent(pointer("pointerup", { pointerId: 6, pointerType: "pen", x: 30, y: 30 }));

    const doc = engine.serialize();
    // Exactly one stroke — the pen's — and it does not contain the palm's coords.
    expect(strokeCount(doc)).toBe(1);
    const xs = doc.strokes[0].points.map((p) => p[0]);
    expect(Math.max(...xs)).toBeLessThan(100); // pen coords (10/30), not palm's 200s

    dispose();
    engine.destroy();
  });

  it("still allows finger drawing when no stylus is present (touch-only device)", () => {
    const { engine, el, dispose } = makeEngine();

    el.dispatchEvent(pointer("pointerdown", { pointerId: 9, pointerType: "touch", x: 10, y: 10 }));
    el.dispatchEvent(pointer("pointermove", { pointerId: 9, pointerType: "touch", x: 20, y: 20 }));
    el.dispatchEvent(pointer("pointerup", { pointerId: 9, pointerType: "touch", x: 20, y: 20 }));

    expect(strokeCount(engine.serialize())).toBe(1);

    dispose();
    engine.destroy();
  });
});
