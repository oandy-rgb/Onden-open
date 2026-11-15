import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLING_MIN_SPEED, flingVelocity, pushFlingSample, startGlide, type FlingSample } from "../lib/ink/glide";

// The glide both cameras share: how fast the finger was going at release, and how the view slows down after.

describe("flingVelocity", () => {
  it("is the finger's speed over the last stretch of the pan", () => {
    const samples: FlingSample[] = [];
    for (let t = 0; t <= 60; t += 20) pushFlingSample(samples, t, 100 + t * 2, 50); // 2 px/ms to the right
    expect(flingVelocity(samples, 60)).toEqual({ vx: 2, vy: 0 });
  });

  it("only counts the last 80 ms: an earlier slow part of the drag does not drag the speed down", () => {
    const samples: FlingSample[] = [];
    for (let t = 0; t <= 500; t += 20) pushFlingSample(samples, t, t < 400 ? t * 0.1 : 40 + (t - 400) * 3, 0);
    expect(flingVelocity(samples, 500)!.vx).toBeCloseTo(3, 5);
    expect(samples[0][0]).toBeGreaterThanOrEqual(500 - 80 - 20);
  });

  it("is null for a finger that stopped before it lifted, a slow drag, or a single touch point", () => {
    const fast: FlingSample[] = [[0, 0, 0], [20, 60, 0]];
    expect(flingVelocity(fast, 20)).not.toBeNull();
    expect(flingVelocity(fast, 20 + 200)).toBeNull(); // rested 200 ms
    expect(flingVelocity([[0, 0, 0], [20, FLING_MIN_SPEED * 20 * 0.9, 0]], 20)).toBeNull();
    expect(flingVelocity([[0, 0, 0]], 0)).toBeNull();
  });
});

describe("startGlide", () => {
  let frames: Array<(t: number) => void> = [];
  const media = (reduce: boolean) => vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduce && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }));
  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => { frames.push(cb); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", () => { frames = []; });
    vi.spyOn(performance, "now").mockReturnValue(0);
    media(false);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  function run() { for (let i = 1; i <= 2000 && frames.length > 0; i++) frames.shift()!(i * 16); }

  it("keeps moving the view in the finger's direction, slower each frame, then says it is done once", () => {
    const moves: number[] = [];
    const done = vi.fn();
    startGlide(2, 0, (dx) => { moves.push(dx); return true; }, done);
    run();
    expect(moves.length).toBeGreaterThan(10);
    expect(moves.every((dx) => dx < 0)).toBe(true); // the view scrolls against the finger
    for (let i = 1; i < moves.length; i++) expect(Math.abs(moves[i])).toBeLessThanOrEqual(Math.abs(moves[i - 1]) + 1e-9);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("a cancelled glide stops at once and is not 'done'", () => {
    const moveBy = vi.fn(() => true);
    const done = vi.fn();
    const cancel = startGlide(2, 0, moveBy, done);
    frames.shift()!(16);
    cancel();
    run();
    expect(moveBy).toHaveBeenCalledTimes(1);
    expect(done).not.toHaveBeenCalled();
  });

  it("with reduce motion on it does not glide at all: no frames, no moves, done straight away", () => {
    media(true);
    const moveBy = vi.fn(() => true);
    const done = vi.fn();
    startGlide(5, 5, moveBy, done);
    expect(frames).toHaveLength(0);
    expect(moveBy).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledTimes(1);
  });
});
