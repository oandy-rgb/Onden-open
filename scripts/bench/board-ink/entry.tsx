// Bundled by ../board-ink.mjs: builds the whiteboard's committed-ink renderer
// (Canvas 2D, tiled, through the same createCommittedRenderer the board uses)
// over seeded strokes, and exposes pan / pinch / commit drivers to the page.
import { createCommittedRenderer, type ICommittedRenderer } from "../../../packages/frontend/src/lib/ink/committed";
import type { CommittedView } from "../../../packages/frontend/src/lib/ink/committed";
import type { InkStroke } from "@onden/markdown/ink";

const SIZE = { w: 390, h: 844 };

function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Strokes spread over a board about 12 screens wide and tall (zoom 1), so a screen shows a small part. */
function fakeStrokes(count: number, seed: number): InkStroke[] {
  const rand = random(seed);
  const side = Math.sqrt(count / 0.03); // ~0.03 strokes per px² cell → dense but not solid
  const strokes: InkStroke[] = [];
  for (let n = 0; n < count; n++) {
    const x0 = rand() * side * 6, y0 = rand() * side * 6;
    const points = 15 + Math.floor(rand() * 26);
    const pts: Array<[number, number, number]> = [];
    for (let k = 0; k < points; k++) {
      const t = k / (points - 1);
      pts.push([
        Math.round((x0 + t * 40 + Math.sin(t * 6 + n) * 6) * 10) / 10,
        Math.round((y0 + t * 30 + Math.cos(t * 5 + n) * 8) * 10) / 10,
        0.3 + 0.5 * Math.sin(t * Math.PI),
      ]);
    }
    strokes.push({ id: `bench-${n}`, points: pts, color: "#15130d", size: 2.4, toolId: "pen" });
  }
  return strokes;
}

let renderer: ICommittedRenderer | null = null;
let view: CommittedView;
const dpr = window.devicePixelRatio;

(window as unknown as { __boardBench: unknown }).__boardBench = {
  async mount(_kind: "canvas2d", count: number, seed: number) {
    renderer?.destroy();
    document.body.innerHTML = `<div id="host" style="position:relative;width:${SIZE.w}px;height:${SIZE.h}px;overflow:hidden"></div>`;
    const t0 = performance.now();
    renderer = createCommittedRenderer({ container: document.getElementById("host")!, cssWidth: SIZE.w, cssHeight: SIZE.h, dpr });
    const createMs = performance.now() - t0;
    view = { dark: false, scale: 1, offsetX: 0, offsetY: 0, dpr };
    const strokes = fakeStrokes(count, seed);
    const t1 = performance.now();
    renderer.commitStrokes(strokes, {}, view);
    const commitMs = performance.now() - t1;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
    return { kind: renderer.kind, createMs, commitMs, heapMB: mem / 1048576 };
  },
  /** One camera step per animation frame; returns after the last frame has painted. */
  async pan(frames: number, step: number) {
    for (let i = 0; i < frames; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      view = { ...view, offsetX: view.offsetX - step, offsetY: view.offsetY - step * 1.6 };
      renderer!.setView(view);
    }
    await new Promise((r) => requestAnimationFrame(r));
  },
  /** Pinch out then in around the screen centre (zoom 1 → 2.4 → 1), one step per frame. */
  async pinch(frames: number) {
    const cx = SIZE.w / 2, cy = SIZE.h / 2;
    const base = view;
    for (let i = 0; i < frames; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const t = i / (frames - 1);
      const zoom = 1 + 1.4 * Math.sin(t * Math.PI);
      const k = zoom / base.scale;
      view = { ...base, scale: zoom, offsetX: cx - (cx - base.offsetX) * k, offsetY: cy - (cy - base.offsetY) * k };
      renderer!.setView(view);
    }
    await new Promise((r) => requestAnimationFrame(r));
  },
  /** Time until the first paint after the zoom settles (Canvas 2D repaints tiles after ZOOM_SETTLE_MS). */
  async settleRepaint() {
    const t0 = performance.now();
    let last = t0;
    let worst = 0;
    while (performance.now() - t0 < 700) {
      await new Promise((r) => requestAnimationFrame(r));
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }
    return worst;
  },
};
