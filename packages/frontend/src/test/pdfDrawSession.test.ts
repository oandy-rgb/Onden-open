// Ink is saved while drawing mode stays on: the session reports "settled"
// once the debounced change arrives with no pen down (UX walkthrough F1).
import { describe, it, expect, vi } from "vitest";
import { createPdfDrawSession } from "../lib/pdf/drawSession";

describe("PDF draw session settling", () => {
  it("settles at once when the change arrives with the pen up", () => {
    const session = createPdfDrawSession();
    session.onSettled = vi.fn();
    session.strokesChanged();
    expect(session.onSettled).toHaveBeenCalledTimes(1);
  });

  it("waits for the pen to lift when the change arrives mid-stroke", () => {
    const session = createPdfDrawSession();
    const settled = vi.fn();
    session.onSettled = settled;
    session.pointerDown();
    session.strokesChanged();
    expect(settled).not.toHaveBeenCalled();
    session.pointerUp();
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("a stray pointer-up neither settles nor drives the count negative", () => {
    const session = createPdfDrawSession();
    const settled = vi.fn();
    session.onSettled = settled;
    session.pointerUp();
    session.pointerUp();
    expect(settled).not.toHaveBeenCalled();
    session.pointerDown();
    session.strokesChanged();
    expect(settled).not.toHaveBeenCalled();
    session.pointerUp();
    expect(settled).toHaveBeenCalledTimes(1);
  });
});
