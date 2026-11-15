// Random pointer-event sequences through the pen side-button detector
// (lib/ink/penShortcut PenShortcutDetector) and the hover marker
// (lib/ink/penHover PenHoverPreview), fed the way lib/ink/engine feeds them.
//
// The side button is invisible to a web page: it shows up only as a hover
// `pointermove` whose buttons go 0 -> non-0 (signal A, Samsung Internet) or as
// a stray `contextmenu` after a stroke that never produced pointer events
// (signal B). A false toggle flips pen <-> eraser under someone who is writing,
// so the cost of a wrong guess is a ruined stroke; the cost of a missed press is
// one more tap. Hence:
//
//   a  no toggle without evidence: every toggle is explained by signal A (a pen
//      move with buttons != 0 while no pen is down) or signal B (a contextmenu
//      that is not a touch / pen menu and arrives with no pointer down at all)
//   b  one physical press toggles at most once; Samsung Internet sends A and
//      then B for the same press, and a lone A or lone B still toggles once
//   c  nothing throws, whatever the order or the values (also reset())
//   d  iPad Safari long-press scripts (touch or pen down, optionally cancelled
//      by iOS, then a contextmenu without pointerType inside the documented
//      windows) never toggle
//   e  hover marker: after any sequence, while a pen is down the marker is hidden
//
// Replay:  PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/penShortcut

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import {
  PEN_SHORTCUT_ABSENT_MS, PEN_SHORTCUT_CANCEL_MS, PEN_SHORTCUT_DOUBLE_MS, PEN_SHORTCUT_QUIET_MS, PenShortcutDetector,
} from "../../lib/ink/penShortcut";
import { PEN_HOVER_IDLE_MS, PenHoverPreview } from "../../lib/ink/penHover";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";

const cfg = { numRuns: PROPS_RUNS, seed: PROPS_SEED };

// ── event model ─────────────────────────────────────────────────────────────

type Kind = "pen" | "touch" | "mouse";
type Ev =
  | { type: "down" | "up" | "cancel"; kind: Kind; id: number; dt: number }
  | { type: "move"; kind: Kind; id: number; buttons: number; dt: number }
  | { type: "leave"; kind: Kind; dt: number }
  | { type: "context"; pointerType: string; dt: number };

const kindArb = fc.constantFrom<Kind>("pen", "touch", "mouse");
/** The browser gives every live pointer its own id, whatever its type: a mouse is 1, touches 10+, pens 20+. */
const idArb = fc.integer({ min: 0, max: 2 });
const ID_BASE: Record<Kind, number> = { mouse: 1, touch: 10, pen: 20 };
const idOf = (kind: Kind, i: number): number => (kind === "mouse" ? 1 : ID_BASE[kind] + i);
/** Gaps that straddle every window in the detector: 0, jitter, the 500 / 600 / 2000 / 3000 ms limits, long. */
const dtArb = fc.oneof(
  fc.constant(0), fc.integer({ min: 1, max: 40 }), fc.integer({ min: 100, max: 200 }),
  fc.constantFrom(PEN_SHORTCUT_ABSENT_MS - 1, PEN_SHORTCUT_ABSENT_MS, PEN_SHORTCUT_ABSENT_MS + 1,
    PEN_SHORTCUT_QUIET_MS - 1, PEN_SHORTCUT_QUIET_MS, PEN_SHORTCUT_CANCEL_MS - 1, PEN_SHORTCUT_CANCEL_MS,
    PEN_SHORTCUT_DOUBLE_MS - 1, PEN_SHORTCUT_DOUBLE_MS),
  fc.integer({ min: 0, max: 5000 }),
);
const evArb: fc.Arbitrary<Ev> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ type: fc.constantFrom("down", "up", "cancel"), kind: kindArb, id: idArb, dt: dtArb }) },
  { weight: 5, arbitrary: fc.record({ type: fc.constant("move" as const), kind: kindArb, id: idArb, buttons: fc.constantFrom(0, 0, 1, 2, 32, 3), dt: dtArb }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant("leave" as const), kind: kindArb, dt: dtArb }) },
  { weight: 3, arbitrary: fc.record({ type: fc.constant("context" as const), pointerType: fc.constantFrom("mouse", "", "pen", "touch", "unknown"), dt: dtArb }) },
) as fc.Arbitrary<Ev>;

/** What the engine does with each event; returns the toggles it caused. */
class Harness {
  readonly detector = new PenShortcutDetector();
  t = 1000;
  down = new Set<string>();
  toggles: { ev: Ev; t: number; noPointerDown: boolean; noPenDown: boolean }[] = [];
  apply(ev: Ev, hover?: PenHoverPreview): void {
    this.t += ev.dt;
    const noPointerDown = this.down.size === 0;
    const noPenDown = ![...this.down].some((k) => k.startsWith("pen:"));
    const id = ev.type === "context" || ev.type === "leave" ? 0 : idOf(ev.kind, ev.id);
    const key = ev.type === "context" || ev.type === "leave" ? "" : `${ev.kind}:${id}`;
    let toggled = false;
    switch (ev.type) {
      case "down": this.down.add(key); hover?.pointerDown(ev.kind, id); this.detector.pointerDown(ev.kind, id, this.t); break;
      case "up": this.down.delete(key); hover?.pointerEnd(ev.kind, id); this.detector.pointerEnd(ev.kind, id, this.t); break;
      case "cancel": this.down.delete(key); hover?.pointerEnd(ev.kind, id); this.detector.pointerEnd(ev.kind, id, this.t, true); break;
      case "move": hover?.pointerMove(ev.kind, 10, 10); toggled = this.detector.pointerMove(ev.kind, ev.buttons, this.t); break;
      case "leave": hover?.pointerLeave(ev.kind); break;
      case "context": toggled = this.detector.contextMenu(ev.pointerType, this.t).toggle; break;
    }
    if (toggled) this.toggles.push({ ev, t: this.t, noPointerDown, noPenDown });
  }
}

describe("pen shortcut detector", () => {
  it("a, c: every toggle has side-button evidence, and nothing throws", () => {
    fc.assert(fc.property(fc.array(evArb, { maxLength: 40 }), (events) => {
      const h = new Harness();
      for (const ev of events) h.apply(ev);
      for (const tog of h.toggles) {
        const ev = tog.ev;
        if (ev.type === "move") {
          expect(ev.kind).toBe("pen");
          expect(ev.buttons).not.toBe(0);
          expect(tog.noPenDown).toBe(true);
        } else {
          expect(ev.type).toBe("context");
          expect(["touch", "pen"]).not.toContain((ev as { pointerType: string }).pointerType);
          expect(tog.noPointerDown).toBe(true);
        }
      }
      h.detector.reset();
    }), cfg);
  });

  // ── one press, one toggle ──────────────────────────────────────────────

  /** A press as a browser reports it. A: hover move with a button, held, released. B: the contextmenu after. */
  type Press = { shape: "A" | "B" | "AB"; held: number; lag: number; contextType: string; hover: number };
  const pressArb = fc.record({
    shape: fc.constantFrom<Press["shape"]>("A", "B", "AB"),
    held: fc.integer({ min: 0, max: 800 }),
    // B arrives ~150ms after the pen lifts; allow far more
    lag: fc.integer({ min: 0, max: PEN_SHORTCUT_DOUBLE_MS - 1000 }),
    contextType: fc.constantFrom("mouse", ""),
    hover: fc.integer({ min: 0, max: 6 }),
  });
  /** Quiet time between two presses: longer than every window in the detector. */
  const GAP = PEN_SHORTCUT_DOUBLE_MS + PEN_SHORTCUT_QUIET_MS + 500;

  it("b: a press toggles exactly once, however many signals it sends", () => {
    fc.assert(fc.property(fc.array(pressArb, { minLength: 1, maxLength: 6 }), fc.boolean(), (presses, startsInRange) => {
      const h = new Harness();
      if (startsInRange) h.apply({ type: "move", kind: "pen", id: 1, buttons: 0, dt: 0 });
      const perPress: number[] = [];
      for (const p of presses) {
        h.t += GAP;
        const before = h.toggles.length;
        // hovering, in range
        for (let i = 0; i < p.hover; i++) h.apply({ type: "move", kind: "pen", id: 1, buttons: 0, dt: 16 });
        if (p.shape !== "B") {
          h.apply({ type: "move", kind: "pen", id: 1, buttons: 0, dt: 16 });
          h.apply({ type: "move", kind: "pen", id: 1, buttons: 2, dt: 16 });
          let held = p.held;
          while (held > 0) { const step = Math.min(held, 16); h.apply({ type: "move", kind: "pen", id: 1, buttons: 2, dt: step }); held -= step; }
          h.apply({ type: "move", kind: "pen", id: 1, buttons: 0, dt: 16 });
        }
        if (p.shape !== "A") h.apply({ type: "context", pointerType: p.contextType, dt: p.shape === "AB" ? p.lag : PEN_SHORTCUT_QUIET_MS });
        perPress.push(h.toggles.length - before);
      }
      expect(perPress).toEqual(presses.map(() => 1));
    }), cfg);
  });

  // ── iPad Safari ────────────────────────────────────────────────────────

  type LongPress = { kind: "pen" | "touch" | "mouse"; hovering: number; moves: number; ending: "contextWhileDown" | "upThenContext" | "cancelThenContext"; lag: number; contextType: string };
  const longPressArb = fc.record({
    kind: kindArb,
    hovering: fc.integer({ min: 0, max: 4 }),
    moves: fc.integer({ min: 0, max: 4 }),
    ending: fc.constantFrom<LongPress["ending"]>("contextWhileDown", "upThenContext", "cancelThenContext"),
    lag: fc.integer({ min: 0, max: 1900 }),
    // Safari's contextmenu is a MouseEvent: no pointerType at all (the engine passes "")
    contextType: fc.constantFrom("", "", "mouse"),
  });

  it("d: a finger / Pencil / mouse long-press is never the side button", () => {
    fc.assert(fc.property(fc.array(longPressArb, { minLength: 1, maxLength: 4 }), (presses) => {
      const h = new Harness();
      for (const p of presses) {
        h.t += 5000;
        if (p.kind === "pen") for (let i = 0; i < p.hovering; i++) h.apply({ type: "move", kind: "pen", id: 1, buttons: 0, dt: 16 });
        h.apply({ type: "down", kind: p.kind, id: 1, dt: 16 });
        for (let i = 0; i < p.moves; i++) h.apply({ type: "move", kind: p.kind, id: 1, buttons: p.kind === "mouse" ? 1 : 0, dt: 16 });
        // pointerType "mouse" for a mouse's own right-click; "" for Safari's callout
        const contextType = p.kind === "mouse" ? "mouse" : p.contextType;
        if (p.ending === "contextWhileDown") {
          h.apply({ type: "context", pointerType: contextType, dt: 500 + (p.lag % 400) });
          h.apply({ type: "up", kind: p.kind, id: 1, dt: 50 });
        } else if (p.ending === "upThenContext") {
          h.apply({ type: "up", kind: p.kind, id: 1, dt: 300 });
          h.apply({ type: "context", pointerType: contextType, dt: p.lag % PEN_SHORTCUT_QUIET_MS });
        } else {
          h.apply({ type: "cancel", kind: p.kind, id: 1, dt: 300 });
          h.apply({ type: "context", pointerType: contextType, dt: p.kind === "mouse" ? p.lag % PEN_SHORTCUT_QUIET_MS : p.lag });
        }
      }
      expect(h.toggles).toEqual([]);
    }), cfg);
  });
});

// ── hover marker ────────────────────────────────────────────────────────────

describe("pen hover marker", () => {
  let frames: (() => void)[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames[id - 1] = () => {}; });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  const runFrames = () => { const todo = frames; frames = []; for (const f of todo) f(); };

  it("e: while a pen is down the marker is hidden, after any sequence", () => {
    fc.assert(fc.property(fc.array(evArb, { maxLength: 40 }), (events) => {
      frames = [];
      const host = document.createElement("div");
      document.body.append(host);
      const hover = new PenHoverPreview(host, () => ({ diameter: 8, color: "#000", opacity: 1 }));
      const h = new Harness();
      for (const ev of events) {
        // keep the hover idle timer honest: real time passes between events (capped)
        vi.advanceTimersByTime(Math.min(ev.dt, PEN_HOVER_IDLE_MS * 2));
        h.apply({ ...ev, dt: 0 } as Ev, hover);
        runFrames();
        const marker = host.querySelector<HTMLElement>("[data-pen-hover]");
        const penDown = [...h.down].some((k) => k.startsWith("pen:"));
        if (penDown && marker) expect(marker.style.display, `after ${JSON.stringify(ev)}`).toBe("none");
      }
      hover.dispose();
      expect(host.querySelector("[data-pen-hover]")).toBeNull();
      host.remove();
    }), cfg);
  });
});
