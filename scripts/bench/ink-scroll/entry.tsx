// Bundled by ../ink-scroll.mjs: mounts the real InkNodeView with generated
// pen strokes so the browser can measure scrolling, writing and zooming.
import { createRoot } from "react-dom/client";
import InkNodeView from "../../../packages/frontend/src/components/InkNodeView";
import { notePages } from "@onden/markdown/ink";
import type { InkDocument, InkStroke } from "@onden/markdown/ink";

const ROW_HEIGHT = 42;
const PAGE_WIDTH = 1000;
const STROKES_PER_ROW = 50; // a dense page: about a thousand strokes on screen

// mulberry32: the same strokes for the same seed on every run.
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

/** `count` handwriting-like strokes of 15–40 pressure points, 50 per 42-unit row. */
function fakeDocument(count: number, seed: number): InkDocument {
  const rand = random(seed);
  const strokes: InkStroke[] = [];
  for (let n = 0; n < count; n++) {
    const row = Math.floor(n / STROKES_PER_ROW);
    const x0 = (n % STROKES_PER_ROW) * (PAGE_WIDTH / STROKES_PER_ROW) + rand() * 4;
    const y0 = row * ROW_HEIGHT + 6 + rand() * 6;
    const points = 15 + Math.floor(rand() * 26);
    const pts: Array<[number, number, number]> = [];
    for (let k = 0; k < points; k++) {
      const t = k / (points - 1);
      pts.push([
        Math.round((x0 + t * 16 + Math.sin(t * 6 + n) * 3) * 10) / 10,
        Math.round((y0 + t * 26 + Math.cos(t * 5 + n) * 4) * 10) / 10,
        0.3 + 0.5 * Math.sin(t * Math.PI),
      ]);
    }
    strokes.push({ id: `bench-${n}`, points: pts, color: "#15130d", size: 2.4, toolId: "pen" });
  }
  return { version: 1, strokes, erased: {}, page: { width: PAGE_WIDTH } };
}

let root: ReturnType<typeof createRoot> | null = null;
(window as unknown as { __inkBench: unknown }).__inkBench = {
  mount(count: number, seed: number) {
    root?.unmount();
    document.body.innerHTML = '<div id="host" style="width:100vw;height:100vh;display:flex;flex-direction:column"></div>';
    root = createRoot(document.getElementById("host")!);
    root.render(<InkNodeView initialPages={notePages(fakeDocument(count, seed))} onPagesChange={() => {}} />);
  },
};
