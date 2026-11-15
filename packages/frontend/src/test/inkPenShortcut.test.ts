// S Pen side button (penShortcut.ts): the detector as a pure state machine, then
// the real InkEngine pipeline with synthetic events in jsdom.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InkEngine } from "../lib/ink/engine";
import type { ICommittedRenderer } from "../lib/ink/committed";
import { PEN_SHORTCUT_DOUBLE_MS, PEN_SHORTCUT_QUIET_MS, PEN_SHORTCUT_REPEAT_MS, PenShortcutDetector, penShortcutTool } from "../lib/ink/penShortcut";
import { InkInputPolicy } from "../lib/ink/inputPolicy";

describe("PenShortcutDetector", () => {
  it("A: hover buttons 0 → non-0 toggles once, the release re-arms it", () => {
    const d = new PenShortcutDetector();
    expect(d.pointerMove("pen", 0, 0)).toBe(false);
    expect(d.pointerMove("pen", 1, 10)).toBe(true);
    expect(d.pointerMove("pen", 1, 20)).toBe(false); // still held
    expect(d.pointerMove("pen", 0, 30)).toBe(false);
    expect(d.pointerMove("pen", 1, 40)).toBe(true);
  });

  it("A: ignores moves while a pen is down and non-pen moves", () => {
    const d = new PenShortcutDetector();
    d.pointerDown("pen", 1, 0);
    expect(d.pointerMove("pen", 1, 5)).toBe(false);
    d.pointerEnd("pen", 1, 8);
    expect(d.pointerMove("mouse", 1, 10)).toBe(false);
    expect(d.pointerMove("touch", 1, 10)).toBe(false);
  });

  it("A: a held-button tap (pen down/up while held) does not toggle again on the next hover move", () => {
    // Samsung Internet, measured 2026-10-25: hover move buttons 1 (A toggles),
    // then an ordinary pen down/up while the button is still held, then hover
    // moves with buttons 1 until the button is released.
    const d = new PenShortcutDetector();
    expect(d.pointerMove("pen", 1, 0)).toBe(true);
    d.pointerDown("pen", 1, 200);
    d.pointerEnd("pen", 1, 260);
    expect(d.pointerMove("pen", 1, 270)).toBe(false);
    expect(d.pointerMove("pen", 0, 600)).toBe(false);
    expect(d.pointerMove("pen", 1, 3000)).toBe(true); // the next press
  });

  it("A: pressed while the pen was out of range counts when it comes back", () => {
    const d = new PenShortcutDetector();
    d.pointerMove("pen", 0, 0);
    d.pointerDown("pen", 1, 100);
    d.pointerEnd("pen", 1, 300); // lifted away: no more pen events
    expect(d.pointerMove("pen", 1, 2000)).toBe(true); // back with the button down
    expect(d.pointerMove("pen", 1, 2010)).toBe(false);
  });

  it("A: a held button with the pen hovering on does not toggle again", () => {
    const d = new PenShortcutDetector();
    expect(d.pointerMove("pen", 1, 0)).toBe(true);
    for (let t = 10; t < 3000; t += 10) expect(d.pointerMove("pen", 1, t)).toBe(false);
  });

  it("A: an ordinary stroke never toggles", () => {
    const d = new PenShortcutDetector();
    d.pointerMove("pen", 0, 0);
    d.pointerDown("pen", 1, 100);
    expect(d.pointerMove("pen", 1, 150)).toBe(false);
    d.pointerEnd("pen", 1, 400);
    expect(d.pointerMove("pen", 0, 420)).toBe(false);
  });

  it("B: a contextmenu with no pointerdown before it toggles and is swallowed", () => {
    const d = new PenShortcutDetector();
    expect(d.contextMenu("mouse", 5000)).toEqual({ swallow: true, toggle: true });
    expect(d.contextMenu("", 9000)).toEqual({ swallow: true, toggle: true });
  });

  it("B: finger and pen long-press menus are left alone", () => {
    const d = new PenShortcutDetector();
    d.pointerDown("touch", 1, 4000);
    expect(d.contextMenu("touch", 4600)).toEqual({ swallow: false, toggle: false });
    d.pointerDown("pen", 2, 8000);
    expect(d.contextMenu("pen", 8600)).toEqual({ swallow: false, toggle: false });
    // Even a "mouse"-typed menu while a pointer is down, or right after one
    // went down or up (a right-click), is that pointer's.
    expect(d.contextMenu("mouse", 9000)).toEqual({ swallow: false, toggle: false });
    d.pointerEnd("pen", 2, 9000);
    d.pointerEnd("touch", 1, 9000);
    expect(d.contextMenu("mouse", 9000 + PEN_SHORTCUT_QUIET_MS - 1)).toEqual({ swallow: false, toggle: false });
  });

  it("B: a press soon after an ordinary stroke still toggles (Chrome)", () => {
    const d = new PenShortcutDetector();
    // A long stroke: down at 0, up at 2000. The button press-and-tap that
    // follows sends no pointer events; its menu arrives 900 ms after the lift.
    d.pointerDown("pen", 1, 0);
    d.pointerEnd("pen", 1, 2000);
    expect(d.contextMenu("mouse", 2900)).toEqual({ swallow: true, toggle: true });
  });

  it("A+B (Samsung Internet) toggles once; a later separate press toggles again", () => {
    const d = new PenShortcutDetector();
    expect(d.pointerMove("pen", 1, 10000)).toBe(true);
    expect(d.contextMenu("mouse", 10150)).toEqual({ swallow: true, toggle: false }); // held
    d.pointerMove("pen", 0, 10200);
    expect(d.contextMenu("mouse", 10400)).toEqual({ swallow: true, toggle: false }); // within 3 s
    expect(d.contextMenu("mouse", 10000 + PEN_SHORTCUT_DOUBLE_MS + 1)).toEqual({ swallow: true, toggle: true });
  });
});

describe("PenShortcutDetector: a held button (Chrome repeats B)", () => {
  it("menus every ~200 ms while held toggle once; a new press after a pause toggles again", () => {
    const d = new PenShortcutDetector();
    expect(d.contextMenu("", 5000)).toEqual({ swallow: true, toggle: true });
    for (const t of [5220, 5440, 5660, 5880]) expect(d.contextMenu("", t)).toEqual({ swallow: true, toggle: false });
    expect(d.contextMenu("", 5880 + PEN_SHORTCUT_REPEAT_MS + 1)).toEqual({ swallow: true, toggle: true });
  });
});

describe("penShortcutTool", () => {
  it("eraser ↔ the last non-eraser tool (pen when none)", () => {
    expect(penShortcutTool("pen", null)).toBe("eraser");
    expect(penShortcutTool("highlighter", null)).toBe("eraser");
    expect(penShortcutTool("hand", null)).toBe("eraser");
    expect(penShortcutTool("eraser", "highlighter")).toBe("highlighter");
    expect(penShortcutTool("eraser", "hand")).toBe("hand");
    expect(penShortcutTool("eraser", null)).toBe("pen");
  });
});

describe("InkInputPolicy: a cancelled pen is kept, a cancelled finger is not", () => {
  it("pen cancel → draw-cancel with keep; touch cancel → plain draw-cancel", () => {
    const pen = new InkInputPolicy({ gestures: true });
    pen.down({ id: 1, kind: "pen", x: 0, y: 0, t: 0 });
    expect(pen.cancel({ id: 1, kind: "pen", x: 0, y: 0, t: 50 })).toEqual([{ type: "draw-cancel", id: 1, keep: true }]);
    const finger = new InkInputPolicy({ gestures: true });
    finger.down({ id: 2, kind: "touch", x: 0, y: 0, t: 1000 });
    expect(finger.cancel({ id: 2, kind: "touch", x: 0, y: 0, t: 1050 })).toEqual([{ type: "draw-cancel", id: 2 }]);
  });
});

function stubRenderer(): ICommittedRenderer {
  return { kind: "canvas2d", commitStrokes() {}, setView() {}, resize() {}, destroy() {} };
}

type PType = "pen" | "touch" | "mouse" | "";
function pointer(
  type: string,
  o: { id?: number; pointerType: PType; x?: number; y?: number; buttons?: number; t?: number },
): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, {
    pointerId: o.id ?? 1,
    pointerType: o.pointerType,
    button: 0,
    buttons: o.buttons ?? 0,
    clientX: o.x ?? 0,
    clientY: o.y ?? 0,
    pressure: 0.5,
    getCoalescedEvents: () => [],
  });
  if (o.t !== undefined) Object.defineProperty(e, "timeStamp", { value: o.t });
  return e;
}

function makeEngine(onPenShortcut?: () => void) {
  const el = document.createElement("div");
  Object.assign(el, { setPointerCapture() {}, releasePointerCapture() {} });
  document.body.appendChild(el);
  const engine = new InkEngine({
    committedRenderer: stubRenderer(),
    wetCanvas: document.createElement("canvas"),
    manageCanvasSize: false,
    onPenShortcut,
  });
  engine.addPointerHandlers(el);
  return { engine, el };
}

describe("InkEngine S Pen button", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("A: a hover click switches the tool", () => {
    const onPenShortcut = vi.fn();
    const { el } = makeEngine(onPenShortcut);
    el.dispatchEvent(pointer("pointermove", { pointerType: "pen", buttons: 0, t: 1 }));
    el.dispatchEvent(pointer("pointermove", { pointerType: "pen", buttons: 1, t: 2 }));
    el.dispatchEvent(pointer("pointermove", { pointerType: "pen", buttons: 0, t: 3 }));
    expect(onPenShortcut).toHaveBeenCalledTimes(1);
  });

  it("B: a pointerless mouse contextmenu switches and is preventDefaulted", () => {
    const onPenShortcut = vi.fn();
    const { el } = makeEngine(onPenShortcut);
    const menu = pointer("contextmenu", { pointerType: "mouse", t: 5000 });
    el.dispatchEvent(menu);
    expect(onPenShortcut).toHaveBeenCalledTimes(1);
    expect(menu.defaultPrevented).toBe(true);
  });

  it("Samsung Internet A+B switches once but still swallows the menu", () => {
    const onPenShortcut = vi.fn();
    const { el } = makeEngine(onPenShortcut);
    el.dispatchEvent(pointer("pointermove", { pointerType: "pen", buttons: 1, t: 5000 }));
    const menu = pointer("contextmenu", { pointerType: "mouse", t: 5150 });
    el.dispatchEvent(menu);
    expect(onPenShortcut).toHaveBeenCalledTimes(1);
    expect(menu.defaultPrevented).toBe(true);
  });

  it("finger and pen long-press menus neither switch nor are prevented", () => {
    const onPenShortcut = vi.fn();
    const { el } = makeEngine(onPenShortcut);
    el.dispatchEvent(pointer("pointerdown", { id: 1, pointerType: "touch", t: 5000 }));
    const finger = pointer("contextmenu", { pointerType: "touch", t: 5600 });
    el.dispatchEvent(finger);
    el.dispatchEvent(pointer("pointerup", { id: 1, pointerType: "touch", t: 5700 }));
    el.dispatchEvent(pointer("pointerdown", { id: 2, pointerType: "pen", t: 9000 }));
    const pen = pointer("contextmenu", { id: 2, pointerType: "pen", t: 9600 });
    el.dispatchEvent(pen);
    expect(onPenShortcut).not.toHaveBeenCalled();
    expect(finger.defaultPrevented).toBe(false);
    expect(pen.defaultPrevented).toBe(false);
  });

  it("without onPenShortcut the contextmenu is left alone", () => {
    const { el } = makeEngine();
    const menu = pointer("contextmenu", { pointerType: "mouse", t: 5000 });
    el.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(false);
  });

  it("read-only drawings: no switch, no preventDefault", () => {
    const onPenShortcut = vi.fn();
    const { engine, el } = makeEngine(onPenShortcut);
    engine.load({ version: 1, strokes: [], requires: ["future-feature"] } as never);
    expect(engine.readOnly).toBe(true);
    el.dispatchEvent(pointer("pointermove", { pointerType: "pen", buttons: 0, t: 1 }));
    el.dispatchEvent(pointer("pointermove", { pointerType: "pen", buttons: 1, t: 2 }));
    const menu = pointer("contextmenu", { pointerType: "mouse", t: 9000 });
    el.dispatchEvent(menu);
    expect(onPenShortcut).not.toHaveBeenCalled();
    expect(menu.defaultPrevented).toBe(false);
  });

  it("C: a pen stroke cancelled mid-way keeps what was drawn (>= 2 points)", () => {
    const { engine, el } = makeEngine();
    el.dispatchEvent(pointer("pointerdown", { pointerType: "pen", x: 10, y: 10, t: 1 }));
    el.dispatchEvent(pointer("pointermove", { pointerType: "pen", x: 20, y: 20, buttons: 1, t: 2 }));
    el.dispatchEvent(pointer("pointercancel", { pointerType: "pen", x: 0, y: 0, t: 3 }));
    const strokes = engine.serialize().strokes;
    expect(strokes).toHaveLength(1);
    // The cancel event's own (0,0) position is not part of the stroke.
    expect(strokes[0].points.every((p) => p[0] >= 10)).toBe(true);
  });

  it("C: a pen cancelled before a second point is dropped", () => {
    const { engine, el } = makeEngine();
    el.dispatchEvent(pointer("pointerdown", { pointerType: "pen", x: 10, y: 10, t: 1 }));
    el.dispatchEvent(pointer("pointercancel", { pointerType: "pen", t: 2 }));
    expect(engine.serialize().strokes).toHaveLength(0);
  });

  it("a finger cancelled by the pen (palm rejection) is still discarded", () => {
    const { engine, el } = makeEngine();
    el.dispatchEvent(pointer("pointerdown", { id: 2, pointerType: "touch", x: 5, y: 5, t: 1000 }));
    el.dispatchEvent(pointer("pointermove", { id: 2, pointerType: "touch", x: 50, y: 50, t: 1010 }));
    el.dispatchEvent(pointer("pointerdown", { id: 1, pointerType: "pen", x: 100, y: 100, t: 1020 }));
    el.dispatchEvent(pointer("pointerup", { id: 1, pointerType: "pen", x: 100, y: 100, t: 1030 }));
    el.dispatchEvent(pointer("pointercancel", { id: 2, pointerType: "touch", t: 1040 }));
    const strokes = engine.serialize().strokes;
    expect(strokes).toHaveLength(1);
    expect(strokes[0].points.every((p) => p[0] >= 100)).toBe(true);
  });

  it("a finger cancelled by the browser is discarded", () => {
    const { engine, el } = makeEngine();
    el.dispatchEvent(pointer("pointerdown", { id: 2, pointerType: "touch", x: 5, y: 5, t: 1000 }));
    el.dispatchEvent(pointer("pointermove", { id: 2, pointerType: "touch", x: 50, y: 50, t: 1010 }));
    el.dispatchEvent(pointer("pointercancel", { id: 2, pointerType: "touch", t: 1020 }));
    expect(engine.serialize().strokes).toHaveLength(0);
  });
});
