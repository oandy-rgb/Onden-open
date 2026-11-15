// The glide after a one-finger fling, shared by every camera that glides (the
// notebook's PageBook, the whiteboard's useBoardCamera), so a
// flick feels the same everywhere: how fast the finger was moving at release
// (`flingVelocity`) and how the board slows down after (`startGlide`).

import { matchesMedia } from "../mediaQuery";

/** Velocity decays by this factor every 16 ms. */
const FLING_DECAY = 0.95;
const FLING_STOP_SPEED = 0.02; // px/ms
/** A one-finger pan ending faster than this (px/ms) keeps gliding. */
export const FLING_MIN_SPEED = 0.25;
/** Velocity is measured over the last stretch of the pan. */
const FLING_WINDOW_MS = 80;

/** One finger position during a pan: [time ms, x px, y px]. */
export type FlingSample = [t: number, x: number, y: number];

/** Add a position to the pan's trail, dropping what is older than the measuring window. */
export function pushFlingSample(samples: FlingSample[], t: number, x: number, y: number): void {
  samples.push([t, x, y]);
  while (samples.length > 2 && t - samples[0][0] > FLING_WINDOW_MS) samples.shift();
}

/** The finger's velocity (px/ms) at release time `now`, or null when it was too slow, or had stopped
 *  before lifting (a finger that rests then lifts does not glide). */
export function flingVelocity(samples: FlingSample[], now: number): { vx: number; vy: number } | null {
  if (samples.length < 2) return null;
  const [t0, x0, y0] = samples[0];
  const [t1, x1, y1] = samples[samples.length - 1];
  if (now - t1 > FLING_WINDOW_MS || t1 - t0 <= 0) return null;
  const vx = (x1 - x0) / (t1 - t0);
  const vy = (y1 - y0) / (t1 - t0);
  return Math.hypot(vx, vy) < FLING_MIN_SPEED ? null : { vx, vy };
}

/** Glide at (vx, vy) px/ms, slowing down. `moveBy` scrolls the view by a CSS-px
 *  delta and says whether it moved (false at an edge ends the glide). Returns
 *  a cancel function; a new pan or zoom must call it. `onDone` runs once when
 *  the glide comes to rest by itself (not when cancelled) — at once when
 *  "reduce motion" is on, which glides nowhere. */
export function startGlide(vx: number, vy: number, moveBy: (dx: number, dy: number) => boolean, onDone?: () => void): () => void {
  if (typeof requestAnimationFrame !== "function" || matchesMedia("(prefers-reduced-motion: reduce)")) {
    onDone?.();
    return () => {};
  }
  let raf: number | null = null;
  let last = typeof performance !== "undefined" ? performance.now() : Date.now();
  const step = (now: number) => {
    const dt = Math.min(64, Math.max(1, now - last));
    last = now;
    const decay = Math.pow(FLING_DECAY, dt / 16);
    vx *= decay;
    vy *= decay;
    const moved = moveBy(-vx * dt, -vy * dt);
    if (!moved || Math.hypot(vx, vy) < FLING_STOP_SPEED) { raf = null; onDone?.(); return; }
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => {
    if (raf !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
    raf = null;
  };
}
