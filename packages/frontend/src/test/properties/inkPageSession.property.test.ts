// 深入審查 2026-11-11（手寫）：docs/archive/deep-review-ink-2026-11-11.md。
// 一本有多頁的手寫本（InkPageSession）：隨機的「畫、頁面捲走（卸載）、頁面捲回（掛載）、套用」順序之後，
// 最後一次 apply 的信封必須含每一頁最後畫的內容，沒有任何一筆因為頁面卸載／重掛而消失。
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";
import { InkEngine, InkPageSession, emptyInkDocument, type InkDocument } from "../../lib/ink";

const engineWith = (doc: InkDocument | null) => {
  const engine = new InkEngine({
    committedRenderer: { kind: "canvas2d", commitStrokes() {}, setView() {}, resize() {}, destroy() {} },
    wetCanvas: document.createElement("canvas"),
    manageCanvasSize: false,
  });
  engine.load(doc);
  return engine;
};
const drawn = (id: string): InkDocument => ({ ...emptyInkDocument(), strokes: [{ id, toolId: "pen", color: "#000", size: 4, points: [[1, 1], [9, 9]] }] });
type Env = Record<string, InkDocument>;
const KEYS = ["p1", "p2", "p3"] as const;

type Op = { kind: "draw" | "unmount" | "mount" | "apply"; key: (typeof KEYS)[number] };
const ops = fc.array(fc.record({ kind: fc.constantFrom("draw", "unmount", "mount", "apply"), key: fc.constantFrom(...KEYS) }), { minLength: 1, maxLength: 40 });

describe("InkPageSession：隨機的畫／卸載／重掛／套用順序", () => {
  it("最後一次 apply 之後，每一頁都是最後畫的內容", () => {
    fc.assert(fc.property(ops, (sequence: Op[]) => {
      const session = new InkPageSession<Env>((env, key, doc) => ({ ...env, [key]: doc }));
      let env: Env = {};
      const engines = new Map<string, InkEngine>();
      const expected = new Map<string, string>();
      let n = 0;
      for (const { kind, key } of sequence) {
        const engine = engines.get(key);
        if (kind === "mount" && !engine) {
          const fresh = engineWith(env[key] ?? null);
          engines.set(key, fresh);
          session.attach(key, fresh, 1.4);
        } else if (kind === "unmount" && engine) {
          session.detach(key, engine);
          engines.delete(key);
        } else if (kind === "draw" && engine) {
          const id = `s${++n}`;
          engine.load(drawn(id));
          expected.set(key, id);
        } else if (kind === "apply") env = session.apply(env);
      }
      env = session.apply(env);
      for (const [key, id] of expected) expect(env[key]?.strokes.map((s) => s.id)).toEqual([id]);
    }), { seed: PROPS_SEED, numRuns: PROPS_RUNS });
  });
});
