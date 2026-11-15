// The ink input policy (T1-1): synthetic pointer sequences → actions.
import { describe, expect, it } from "vitest";
import {
  InkInputPolicy, PALM_GRACE_MS, TAP_MAX_MS, TAP_SLOP_PX, fingerDraws,
  type InkInputAction, type InkInputPolicyOptions, type InkPointerKind,
} from "../lib/ink/inputPolicy";

type Ev = { id: number; kind: InkPointerKind; x?: number; y?: number; t: number; button?: number; inArea?: boolean };

function make(options: InkInputPolicyOptions = { gestures: true }) {
  const policy = new InkInputPolicy(options);
  const sample = (e: Ev) => ({ x: 0, y: 0, ...e });
  return {
    policy,
    down: (e: Ev) => policy.down(sample(e)),
    move: (e: Ev) => policy.move(sample(e)),
    up: (e: Ev) => policy.up(sample(e)),
    cancel: (e: Ev) => policy.cancel(sample(e)),
  };
}

const types = (actions: InkInputAction[]) => actions.map((a) => a.type);
const product = (actions: InkInputAction[]) =>
  actions.reduce((acc, a) => acc * (a.type === "zoom" ? a.factor : 1), 1);
const sum = (actions: InkInputAction[], key: "dx" | "dy") =>
  actions.reduce((acc, a) => acc + (a.type === "pan" ? a[key] : 0), 0);

describe("fingerDraws", () => {
  it("comes from the tool and the stylus-mode setting only", () => {
    expect(fingerDraws(false, false)).toBe(true); // drawing tool, default
    expect(fingerDraws(true, false)).toBe(false); // Hand tool
    expect(fingerDraws(false, true)).toBe(false); // stylus mode
    expect(fingerDraws(true, true)).toBe(false);
  });
});

describe("InkInputPolicy — drawing tool, defaults (phone)", () => {
  it("one finger draws a stroke", () => {
    const p = make();
    expect(types(p.down({ id: 1, kind: "touch", t: 0 }))).toEqual(["draw-start"]);
    expect(types(p.move({ id: 1, kind: "touch", x: 40, t: 16 }))).toEqual(["draw-move"]);
    expect(types(p.up({ id: 1, kind: "touch", x: 40, t: 32 }))).toEqual(["draw-end"]);
  });

  it("a second finger cancels the finger stroke and pinches", () => {
    const p = make();
    p.down({ id: 1, kind: "touch", x: 100, y: 100, t: 0 });
    p.move({ id: 1, kind: "touch", x: 104, y: 100, t: 10 });
    expect(p.down({ id: 2, kind: "touch", x: 200, y: 100, t: 20 })).toEqual([{ type: "draw-cancel", id: 1 }]);
    // Fingers spread 100 → 200 px apart around the same midpoint (150, 100).
    // The pinch starts from the fingers' positions when it began (104..200).
    const out = [
      ...p.move({ id: 1, kind: "touch", x: 50, y: 100, t: 40 }),
      ...p.move({ id: 2, kind: "touch", x: 250, y: 100, t: 50 }),
    ];
    expect(product(out)).toBeCloseTo(200 / 96, 5);
    const last = out.filter((a) => a.type === "zoom").at(-1);
    expect(last?.type === "zoom" && last.x).toBe(150);
    // No stroke ends from this gesture.
    expect(types(p.up({ id: 1, kind: "touch", t: 400 }))).not.toContain("draw-end");
    expect(types(p.up({ id: 2, kind: "touch", t: 410 }))).toEqual([]);
  });

  it("two fingers moving together pan (scroll) the page", () => {
    const p = make();
    p.down({ id: 1, kind: "touch", x: 100, y: 300, t: 0 });
    p.down({ id: 2, kind: "touch", x: 160, y: 300, t: 5 });
    const a = p.move({ id: 1, kind: "touch", x: 100, y: 250, t: 30 });
    const b = p.move({ id: 2, kind: "touch", x: 160, y: 250, t: 35 });
    expect(sum([...a, ...b], "dy")).toBeCloseTo(-50);
    expect(product([...a, ...b])).toBeCloseTo(1, 5); // same spread at the end: no net zoom
  });

  it("after a pinch, the finger left on the glass pans, it never draws", () => {
    const p = make();
    p.down({ id: 1, kind: "touch", x: 100, y: 100, t: 0 });
    p.down({ id: 2, kind: "touch", x: 200, y: 100, t: 5 });
    p.move({ id: 2, kind: "touch", x: 260, y: 100, t: 30 });
    p.up({ id: 2, kind: "touch", x: 260, y: 100, t: 60 });
    const out = p.move({ id: 1, kind: "touch", x: 100, y: 160, t: 80 });
    expect(out).toEqual([{ type: "pan", dx: 0, dy: 60 }]);
    expect(types(p.up({ id: 1, kind: "touch", x: 100, y: 160, t: 90 }))).toEqual([]);
  });
});

describe("InkInputPolicy — stylus mode (iPad + Pencil)", () => {
  it("a pen draws and does NOT latch anything: fingers keep drawing by default", () => {
    const p = make();
    expect(types(p.down({ id: 1, kind: "pen", t: 0 }))).toEqual(["draw-start"]);
    p.up({ id: 1, kind: "pen", t: 100 });
    expect(p.policy.fingerDraws).toBe(true);
    expect(types(p.down({ id: 2, kind: "touch", t: 100 + PALM_GRACE_MS + 1 }))).toEqual(["draw-start"]);
  });

  it("with stylus mode on, one finger pans; the pen still draws", () => {
    const p = make({ gestures: true, stylusOnly: true });
    expect(p.policy.fingerDraws).toBe(false);
    const t0 = 1000;
    expect(p.down({ id: 2, kind: "touch", x: 50, y: 400, t: t0 })).toEqual([]);
    // Inside the slop nothing moves (a resting palm or a tap never scrolls)…
    expect(p.move({ id: 2, kind: "touch", x: 50, y: 400 - TAP_SLOP_PX + 2, t: t0 + 10 })).toEqual([]);
    // …past it the content follows the finger from where it landed.
    expect(p.move({ id: 2, kind: "touch", x: 50, y: 300, t: t0 + 30 })).toEqual([{ type: "pan", dx: 0, dy: -100 }]);
    expect(p.move({ id: 2, kind: "touch", x: 50, y: 280, t: t0 + 40 })).toEqual([{ type: "pan", dx: 0, dy: -20 }]);
    p.up({ id: 2, kind: "touch", y: 280, t: t0 + 900 });
    expect(types(p.down({ id: 3, kind: "pen", t: 5000 }))).toEqual(["draw-start"]);
  });

  it("stylus mode can be switched off again at runtime", () => {
    const p = make({ gestures: true, stylusOnly: true });
    p.policy.configure({ stylusOnly: false });
    expect(types(p.down({ id: 1, kind: "touch", t: 0 }))).toEqual(["draw-start"]);
  });

  it("a fast one-finger flick ends with a fling", () => {
    const p = make({ gestures: true, stylusOnly: true });
    p.down({ id: 1, kind: "touch", x: 0, y: 500, t: 0 });
    p.move({ id: 1, kind: "touch", x: 0, y: 450, t: 20 });
    p.move({ id: 1, kind: "touch", x: 0, y: 380, t: 40 });
    const out = p.up({ id: 1, kind: "touch", x: 0, y: 380, t: 45 });
    expect(out[0]?.type).toBe("fling");
    if (out[0]?.type === "fling") expect(out[0].vy).toBeLessThan(0);
  });

  it("palm rejection: a pen takes over a palm stroke; the palm stays ignored", () => {
    const p = make({ gestures: true });
    expect(types(p.down({ id: 5, kind: "touch", x: 200, y: 200, t: 0 }))).toEqual(["draw-start"]);
    expect(p.down({ id: 6, kind: "pen", x: 10, y: 10, t: 8 })).toEqual([
      { type: "draw-cancel", id: 5 }, { type: "draw-start", id: 6 },
    ]);
    expect(p.move({ id: 5, kind: "touch", x: 220, y: 220, t: 16 })).toEqual([]);
    // A second palm landing while the pen draws: ignored.
    expect(p.down({ id: 7, kind: "touch", x: 300, y: 300, t: 20 })).toEqual([]);
    expect(types(p.up({ id: 6, kind: "pen", t: 30 }))).toEqual(["draw-end"]);
    expect(p.up({ id: 5, kind: "touch", t: 40 })).toEqual([]);
  });

  it("palm rejection: a touch right after the pen lifted is taken as a palm", () => {
    const p = make({ gestures: true });
    p.down({ id: 1, kind: "pen", t: 0 });
    p.up({ id: 1, kind: "pen", t: 50 });
    expect(p.down({ id: 2, kind: "touch", t: 50 + PALM_GRACE_MS - 1 })).toEqual([]);
    expect(p.move({ id: 2, kind: "touch", y: 200, t: 60 + PALM_GRACE_MS })).toEqual([]);
  });

  it("a pen landing during a finger pan stops the pan and draws", () => {
    const p = make({ gestures: true, stylusOnly: true });
    p.down({ id: 1, kind: "touch", y: 0, t: 1000 });
    p.move({ id: 1, kind: "touch", y: 50, t: 1020 });
    expect(types(p.down({ id: 2, kind: "pen", t: 1030 }))).toEqual(["draw-start"]);
    expect(p.move({ id: 1, kind: "touch", y: 90, t: 1040 })).toEqual([]);
  });
});

describe("InkInputPolicy — Hand tool", () => {
  it("one finger pans — it never draws, however long it rests", () => {
    const p = make({ gestures: true, handTool: true });
    expect(p.down({ id: 1, kind: "touch", x: 100, y: 400, t: 0 })).toEqual([]);
    expect(types(p.move({ id: 1, kind: "touch", x: 100, y: 340, t: 30 }))).toEqual(["pan"]);
    expect(p.move({ id: 1, kind: "touch", x: 100, y: 330, t: 40 })).toEqual([{ type: "pan", dx: 0, dy: -10 }]);
  });

  it("two fingers pan + zoom exactly as with a drawing tool", () => {
    const p = make({ gestures: true, handTool: true });
    p.down({ id: 1, kind: "touch", x: 100, y: 300, t: 0 });
    p.down({ id: 2, kind: "touch", x: 200, y: 300, t: 5 });
    const out = [
      ...p.move({ id: 1, kind: "touch", x: 50, y: 300, t: 40 }),
      ...p.move({ id: 2, kind: "touch", x: 250, y: 300, t: 50 }),
    ];
    expect(product(out)).toBeCloseTo(2, 5);
  });

  it("the pen and the mouse grab the page too (and draw again once a pen tool is picked)", () => {
    const p = make({ gestures: true, handTool: true });
    expect(p.down({ id: 1, kind: "pen", x: 10, y: 10, t: 0 })).toEqual([]);
    expect(p.move({ id: 1, kind: "pen", x: 10, y: 40, t: 10 })).toEqual([{ type: "pan", dx: 0, dy: 30 }]);
    p.up({ id: 1, kind: "pen", t: 20 });
    expect(p.down({ id: 2, kind: "mouse", x: 0, y: 0, t: 1000 })).toEqual([]);
    expect(p.move({ id: 2, kind: "mouse", x: 5, y: 0, t: 1010 })).toEqual([{ type: "pan", dx: 5, dy: 0 }]);
    p.up({ id: 2, kind: "mouse", t: 1020 });
    p.policy.configure({ handTool: false });
    expect(types(p.down({ id: 3, kind: "pen", t: 2000 }))).toEqual(["draw-start"]);
    p.up({ id: 3, kind: "pen", t: 2100 });
    expect(types(p.down({ id: 4, kind: "mouse", t: 3000 }))).toEqual(["draw-start"]);
  });

  it("taps still undo / redo", () => {
    const p = make({ gestures: true, handTool: true });
    p.down({ id: 1, kind: "touch", x: 100, y: 100, t: 1000 });
    p.down({ id: 2, kind: "touch", x: 160, y: 100, t: 1010 });
    p.up({ id: 1, kind: "touch", t: 1100 });
    expect(p.up({ id: 2, kind: "touch", t: 1120 })).toEqual([{ type: "undo" }]);
  });
});

describe("InkInputPolicy — where a stroke may start", () => {
  it("a finger whose touch is not on the paper (inArea false) pans in BOTH finger modes", () => {
    for (const stylusOnly of [false, true]) {
      const p = make({ gestures: true, stylusOnly });
      expect(p.down({ id: 1, kind: "touch", inArea: false, t: 0 })).toEqual([]);
      expect(types(p.move({ id: 1, kind: "touch", y: 40, t: 20 }))).toEqual(["pan"]);
    }
  });
});

describe("InkInputPolicy — taps", () => {
  it("a two-finger tap undoes, a three-finger tap redoes", () => {
    const p = make({ gestures: true, stylusOnly: true });
    p.down({ id: 1, kind: "touch", x: 100, y: 100, t: 1000 });
    p.down({ id: 2, kind: "touch", x: 160, y: 100, t: 1010 });
    p.move({ id: 2, kind: "touch", x: 163, y: 102, t: 1050 }); // jitter inside the slop
    expect(p.up({ id: 1, kind: "touch", t: 1100 })).toEqual([]);
    expect(p.up({ id: 2, kind: "touch", t: 1120 })).toEqual([{ type: "undo" }]);

    p.down({ id: 3, kind: "touch", x: 100, y: 100, t: 2000 });
    p.down({ id: 4, kind: "touch", x: 150, y: 100, t: 2005 });
    p.down({ id: 5, kind: "touch", x: 200, y: 100, t: 2010 });
    p.up({ id: 3, kind: "touch", t: 2100 });
    p.up({ id: 4, kind: "touch", t: 2110 });
    expect(p.up({ id: 5, kind: "touch", t: 2120 })).toEqual([{ type: "redo" }]);
  });

  it("in finger-draw mode a two-finger tap drops the started stroke and undoes", () => {
    const p = make();
    expect(types(p.down({ id: 1, kind: "touch", t: 0 }))).toEqual(["draw-start"]);
    expect(types(p.down({ id: 2, kind: "touch", x: 60, t: 15 }))).toEqual(["draw-cancel"]);
    p.up({ id: 1, kind: "touch", t: 120 });
    expect(p.up({ id: 2, kind: "touch", x: 60, t: 130 })).toEqual([{ type: "undo" }]);
  });

  it("not a tap: too slow, moved, cancelled, or read-only", () => {
    const slow = make({ gestures: true, stylusOnly: true });
    slow.down({ id: 1, kind: "touch", t: 0 });
    slow.down({ id: 2, kind: "touch", x: 60, t: 10 });
    slow.up({ id: 1, kind: "touch", t: TAP_MAX_MS });
    expect(slow.up({ id: 2, kind: "touch", x: 60, t: TAP_MAX_MS + 1 })).toEqual([]);

    const moved = make({ gestures: true, stylusOnly: true });
    moved.down({ id: 1, kind: "touch", t: 0 });
    moved.down({ id: 2, kind: "touch", x: 60, t: 10 });
    moved.move({ id: 2, kind: "touch", x: 60 + TAP_SLOP_PX + 5, t: 50 });
    moved.up({ id: 1, kind: "touch", t: 100 });
    expect(types(moved.up({ id: 2, kind: "touch", t: 110 }))).not.toContain("undo");

    const cancelled = make({ gestures: true, stylusOnly: true });
    cancelled.down({ id: 1, kind: "touch", t: 0 });
    cancelled.down({ id: 2, kind: "touch", x: 60, t: 10 });
    cancelled.cancel({ id: 1, kind: "touch", t: 50 });
    expect(cancelled.up({ id: 2, kind: "touch", x: 60, t: 60 })).toEqual([]);

    const readOnly = make({ gestures: true, readOnly: true });
    readOnly.down({ id: 1, kind: "touch", t: 0 });
    readOnly.down({ id: 2, kind: "touch", x: 60, t: 10 });
    readOnly.up({ id: 1, kind: "touch", t: 50 });
    expect(readOnly.up({ id: 2, kind: "touch", x: 60, t: 60 })).toEqual([]);
  });
});

describe("InkInputPolicy — mouse, read-only, page edge", () => {
  it("mouse draws with the left button; space held pans", () => {
    const p = make();
    expect(types(p.down({ id: 1, kind: "mouse", t: 0 }))).toEqual(["draw-start"]);
    p.up({ id: 1, kind: "mouse", t: 10 });
    expect(p.down({ id: 1, kind: "mouse", button: 2, t: 20 })).toEqual([]);
    p.up({ id: 1, kind: "mouse", t: 30 });
    p.policy.setSpaceHeld(true);
    expect(p.down({ id: 1, kind: "mouse", x: 0, t: 40 })).toEqual([]);
    expect(p.move({ id: 1, kind: "mouse", x: 5, t: 50 })).toEqual([{ type: "pan", dx: 5, dy: 0 }]);
  });

  it("read-only: nothing draws; fingers and the pen pan", () => {
    const p = make({ gestures: true, readOnly: true });
    expect(p.down({ id: 1, kind: "touch", t: 0 })).toEqual([]);
    expect(types(p.move({ id: 1, kind: "touch", y: 50, t: 20 }))).toEqual(["pan"]);
    p.up({ id: 1, kind: "touch", y: 50, t: 400 });
    expect(p.down({ id: 2, kind: "pen", t: 1000 })).toEqual([]);
    expect(types(p.move({ id: 2, kind: "pen", y: 30, t: 1010 }))).toEqual(["pan"]);
    p.up({ id: 2, kind: "pen", t: 1020 });
    expect(p.down({ id: 3, kind: "mouse", t: 2000 })).toEqual([]);
  });

  it("a stroke can't start off the page: pen ignored, finger pans", () => {
    const p = make();
    expect(p.down({ id: 1, kind: "touch", inArea: false, t: 0 })).toEqual([]);
    expect(types(p.move({ id: 1, kind: "touch", y: 40, t: 20 }))).toEqual(["pan"]);
    p.up({ id: 1, kind: "touch", t: 400 });
    expect(p.down({ id: 2, kind: "pen", inArea: false, t: 500 })).toEqual([]);
    expect(p.move({ id: 2, kind: "pen", y: 40, t: 520 })).toEqual([]);
  });

  it("a missed pointerup is cancelled when the id comes back", () => {
    const p = make();
    p.down({ id: 1, kind: "touch", t: 0 });
    expect(types(p.down({ id: 1, kind: "touch", t: 500 }))).toEqual(["draw-cancel", "draw-start"]);
  });
});

describe("InkInputPolicy — hosts without pan/zoom (PDF, legacy)", () => {
  it("first pointer draws, a second is ignored, touch ignored after a pen", () => {
    const p = make({ gestures: false });
    expect(types(p.down({ id: 1, kind: "touch", t: 0 }))).toEqual(["draw-start"]);
    expect(p.down({ id: 2, kind: "touch", t: 5 })).toEqual([]);
    expect(types(p.up({ id: 1, kind: "touch", t: 50 }))).toEqual(["draw-end"]);
    expect(p.up({ id: 2, kind: "touch", t: 60 })).toEqual([]);
    p.down({ id: 3, kind: "pen", t: 100 });
    p.up({ id: 3, kind: "pen", t: 200 });
    expect(p.down({ id: 4, kind: "touch", t: 5000 })).toEqual([]);
    expect(p.move({ id: 4, kind: "touch", y: 50, t: 5010 })).toEqual([]);
  });
});

describe("InkInputPolicy — native touch (the PDF)", () => {
  it("one finger that doesn't draw emits nothing: the browser scrolls it, no fling", () => {
    const p = make({ gestures: true, stylusOnly: true, nativeTouch: true });
    expect(p.down({ id: 1, kind: "touch", x: 0, y: 300, t: 0 })).toEqual([]);
    expect(p.move({ id: 1, kind: "touch", x: 0, y: 200, t: 20 })).toEqual([]);
    expect(p.move({ id: 1, kind: "touch", x: 0, y: 100, t: 40 })).toEqual([]);
    expect(p.up({ id: 1, kind: "touch", x: 0, y: 100, t: 50 })).toEqual([]);
  });

  it("two fingers emit no zoom (the host pinches) but still cancel a finger's stroke and undo on a tap", () => {
    const p = make({ gestures: true, nativeTouch: true });
    expect(types(p.down({ id: 1, kind: "touch", x: 100, y: 300, t: 0 }))).toEqual(["draw-start"]);
    expect(types(p.down({ id: 2, kind: "touch", x: 200, y: 300, t: 10 }))).toEqual(["draw-cancel"]);
    expect(p.move({ id: 2, kind: "touch", x: 300, y: 300, t: 30 })).toEqual([]);
    p.up({ id: 2, kind: "touch", x: 300, y: 300, t: 40 });
    p.up({ id: 1, kind: "touch", x: 100, y: 300, t: 50 });
    p.down({ id: 3, kind: "touch", x: 100, y: 300, t: 1000 });
    p.down({ id: 4, kind: "touch", x: 200, y: 300, t: 1010 });
    p.up({ id: 3, kind: "touch", x: 100, y: 300, t: 1050 });
    expect(types(p.up({ id: 4, kind: "touch", x: 200, y: 300, t: 1060 }))).toEqual(["undo"]);
  });

  it("the pen still pans with the Hand tool", () => {
    const p = make({ gestures: true, handTool: true, nativeTouch: true });
    p.down({ id: 1, kind: "pen", x: 0, y: 300, t: 0 });
    expect(sum(p.move({ id: 1, kind: "pen", x: 0, y: 200, t: 20 }), "dy")).toBe(-100);
  });
});
