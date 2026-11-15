// @vitest-environment jsdom
// Model test of focus and keyboard for the shared UI primitives
// (components/ui: Modal, Popover/Menu via usePopover, Tabs) and PlacePicker,
// the "Move to…" picker's content. A random sequence of user steps (open, Esc,
// Tab / Shift+Tab, arrows, Home / End, press outside, remove the trigger, a
// modal over a modal, a field with autoFocus) runs against one harness page and
// a small model of what is open; the invariants are checked after every step:
//
//   • a surface that closes hands focus back to whatever had it when it opened;
//     if that is gone, to the trigger; never to <body> while either exists
//     (a surface closed after focus moved on elsewhere leaves focus alone)
//   • while a modal is open, focus is inside it (or inside a popover opened in it)
//   • Esc closes only the topmost surface
//   • Tabs: exactly one panel shown, aria-selected matches it, arrows cycle the
//     enabled tabs (a disabled one is skipped) and never stick
//   • with everything unmounted, document / window listeners and <body>'s
//     overflow are back to what they were
//
// jsdom has no top layer: test/setup.ts stubs dialog open / Esc; this file adds
// showModal's "focus the first control" step, which browsers do and jsdom does not.

import { createElement } from "react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import fc from "fast-check";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";
import { DISABLED_TAB, Harness, TAB_NAMES, type Cfg, type Setters } from "../helpers/uiFocusPage";

const fcOpts = { seed: PROPS_SEED, numRuns: PROPS_RUNS };
const PROPS_TIMEOUT_MS = Math.max(20_000, PROPS_RUNS * 100);
const MAX_COMMANDS = 20;

// ── Browser steps jsdom lacks ────────────────────────────────────────────────

const REAL_SHOW_MODAL = HTMLDialogElement.prototype.showModal;
beforeAll(() => {
  // showModal's dialog focusing steps: when nothing inside has focus, the first control gets it.
  HTMLDialogElement.prototype.showModal = function () {
    REAL_SHOW_MODAL.call(this);
    if (this.contains(document.activeElement)) return;
    this.querySelector<HTMLElement>("button:not(:disabled), input, [href], [tabindex]:not([tabindex='-1'])")?.focus();
  };
  // The popover measures itself with ResizeObserver when it exists.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} disconnect() {} };
});
afterAll(() => { HTMLDialogElement.prototype.showModal = REAL_SHOW_MODAL; });

// Live listeners on document / window / <html>, to see a leak.
type Reg = { target: EventTarget; type: string; fn: unknown; capture: boolean };
const live: Reg[] = [];
const realAdd = EventTarget.prototype.addEventListener;
const realRemove = EventTarget.prototype.removeEventListener;
// <body> is left out: React hangs its delegated listeners on a portal's container (body) for good.
const watched = (t: EventTarget) => t === document || t === window || t === document.documentElement;
const captureOf = (o: unknown) => (typeof o === "boolean" ? o : !!(o as AddEventListenerOptions | undefined)?.capture);
function trackListeners() {
  EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, fn: never, opts?: never) {
    if (watched(this) && fn && !live.some((r) => r.target === this && r.type === type && r.fn === fn && r.capture === captureOf(opts))) {
      live.push({ target: this, type, fn, capture: captureOf(opts) });
    }
    return realAdd.call(this, type, fn, opts);
  } as typeof realAdd;
  EventTarget.prototype.removeEventListener = function (this: EventTarget, type: string, fn: never, opts?: never) {
    const i = live.findIndex((r) => r.target === this && r.type === type && r.fn === fn && r.capture === captureOf(opts));
    if (i >= 0) live.splice(i, 1);
    return realRemove.call(this, type, fn, opts);
  } as typeof realRemove;
}
function untrackListeners() { EventTarget.prototype.addEventListener = realAdd; EventTarget.prototype.removeEventListener = realRemove; }
const describeLive = () => live.map((r) => `${r.target === window ? "window" : r.target === document ? "document" : "html"}:${r.type}${r.capture ? ":capture" : ""}`).sort();

// ── World: the rendered page + the model of what is open ───────────────────

type Id = "menu" | "pop" | "m1" | "m2";
const SURFACE: Record<Id, { role: string; name: string; kind: "popover" | "modal"; trigger: string }> = {
  menu: { role: "menu", name: "Things", kind: "popover", trigger: "menu-trigger" },
  pop: { role: "dialog", name: "Pop", kind: "popover", trigger: "pop-trigger" },
  m1: { role: "dialog", name: "M1", kind: "modal", trigger: "modal-trigger" },
  m2: { role: "dialog", name: "M2", kind: "modal", trigger: "open-m2" },
};
// Query the DOM directly: a closed <dialog> is hidden to role queries, and an open one is not in jsdom's "accessible" tree reliably.
function surfaceEl(id: Id): HTMLElement | null {
  const { role, name } = SURFACE[id];
  const sel = SURFACE[id].kind === "modal" ? `dialog[aria-label="${name}"]` : `[role="${role}"][aria-label="${name}"]`;
  const found = document.querySelector<HTMLElement>(sel);
  return found && found.isConnected && (!(found instanceof HTMLDialogElement) || found.open) ? found : null;
}
const byId = (id: string) => document.querySelector<HTMLElement>(`[data-id="${id}"]`);
const IDS: Id[] = ["menu", "pop", "m1", "m2"];

type World = {
  cfg: Cfg;
  user: ReturnType<typeof userEvent.setup>;
  setters: { current: Setters | null };
  /** Open surfaces, bottom first. */
  stack: Id[];
  /** What had focus when each opened. */
  opener: Partial<Record<Id, Element>>;
  /** Each surface's element and the focus just before the current step. */
  el: Partial<Record<Id, HTMLElement>>;
  focusBefore: Element | null;
  tabModel: number;
  log: string[];
  /** The step was a Tab: a menu closes on it by design and focus moves on from its trigger. */
  tabbing: boolean;
};
type Real = World;

function step(world: World, name: string, fn: () => void | Promise<void>) {
  world.log.push(name);
  return fn();
}

/** After every step: compare the page to the model, check what closed handed focus back. */
function reconcile(w: World) {
  const open = IDS.filter((id) => surfaceEl(id));
  const closed = w.stack.filter((id) => !open.includes(id));
  const unexpected = open.filter((id) => !w.stack.includes(id));
  expect(unexpected, `opened without a command: ${w.log.join(" > ")}`).toEqual([]);

  if (closed.length === 1) {
    const id = closed[0]!;
    const info = SURFACE[id];
    const was = w.el[id]!;
    const before = w.focusBefore;
    const now = document.activeElement;
    const movedOn = !!before && before !== document.body && !was.contains(before) && before.isConnected;
    const opener = w.opener[id];
    const trigger = byId(info.trigger);
    const ctx = `${id} closed (${w.log.join(" > ")})`;
    if (w.tabbing && id === "menu") {
      expect(now, `${ctx}: focus moves on, not to <body>`).not.toBe(document.body);
    } else if (info.kind === "popover" && movedOn) {
      expect(now, `${ctx}: focus had moved on and must stay`).toBe(before);
    } else if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected && !was.contains(opener)) {
      expect(now, `${ctx}: focus returns to what opened it`).toBe(opener);
    } else if (info.kind === "popover" && trigger?.isConnected) {
      expect(now, `${ctx}: opener gone, focus falls back to the trigger`).toBe(trigger);
    } else if (info.kind === "modal" && opener === document.body) {
      // Opened from <body> with no trigger to return to: nothing to assert.
    }
  }
  w.stack = w.stack.filter((id) => open.includes(id));
  for (const id of open) w.el[id] = surfaceEl(id)!;

  // Modal open → focus is inside the top modal; never <body>.
  const topModal = [...w.stack].reverse().find((id) => SURFACE[id].kind === "modal");
  if (topModal) {
    const active = document.activeElement;
    const inside = !!active && surfaceEl(topModal)!.contains(active);
    expect(inside, `focus escaped the modal (on ${describeEl(active)}): ${w.log.join(" > ")}`).toBe(true);
  }
  w.focusBefore = document.activeElement;
}
const describeEl = (el: Element | null) => (el ? `${el.tagName.toLowerCase()}${el.getAttribute("data-id") ? `[${el.getAttribute("data-id")}]` : ""}${el.getAttribute("aria-label") ? `"${el.getAttribute("aria-label")}"` : ""}${el.textContent && el.children.length === 0 ? `"${el.textContent}"` : ""}` : "null");

function checkTabs(w: World) {
  const tabs = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'));
  const panels = Array.from(document.querySelectorAll<HTMLElement>('[role="tabpanel"]'));
  const selected = tabs.filter((t) => t.getAttribute("aria-selected") === "true");
  const shown = panels.filter((p) => !p.hidden);
  expect(selected.length, `selected tabs: ${w.log.join(" > ")}`).toBe(1);
  expect(shown.length, `shown panels: ${w.log.join(" > ")}`).toBe(1);
  expect(selected[0]!.getAttribute("aria-controls")).toBe(shown[0]!.id);
  expect(shown[0]!.getAttribute("aria-labelledby")).toBe(selected[0]!.id);
  expect(tabs.indexOf(selected[0]!), `selected tab vs model: ${w.log.join(" > ")}`).toBe(w.tabModel);
  // Only the selected tab is in the tab order.
  expect(tabs.filter((t) => t.tabIndex === 0)).toEqual(selected);
}

// ── Commands ─────────────────────────────────────────────────────────────────

type Mode = "trigger" | "elsewhere" | "body";
const modeArb = fc.constantFrom<Mode>("trigger", "elsewhere", "body");
/** Tab as a browser does it: the keydown first, and only if nobody cancelled it, focus moves to the next
 *  tabbable in document order (user-event's own tab() throws when the keydown unmounts the focused element). */
function pressTab(shift: boolean) {
  const target = document.activeElement ?? document.body;
  let allowed = true;
  act(() => { allowed = fireEvent.keyDown(target, { key: "Tab", shiftKey: shift }); });
  if (!allowed) return;
  const tabbable = Array.from(document.querySelectorAll<HTMLElement>("button, input, a[href], [tabindex]"))
    .filter((el) => !el.matches(":disabled") && el.tabIndex >= 0 && !el.closest("[hidden]") && !el.closest("dialog:not([open])"));
  const at = tabbable.indexOf(document.activeElement as HTMLElement);
  const next = at < 0 ? (shift ? tabbable.length - 1 : 0) : at + (shift ? -1 : 1);
  const to = tabbable[(next + tabbable.length) % tabbable.length];
  act(() => to?.focus());
}
const flush = async () => { await act(async () => {}); };

function prepareFocus(mode: Mode, trigger: HTMLElement | null) {
  act(() => {
    if (mode === "trigger") trigger?.focus();
    else if (mode === "elsewhere") byId("elsewhere")!.focus();
    else (document.activeElement as HTMLElement | null)?.blur();
  });
}

const noModal = (w: World) => !w.stack.includes("m1");
const noPopover = (w: World) => !w.stack.includes("menu") && !w.stack.includes("pop");

class OpenPopoverCmd implements fc.AsyncCommand<World, Real> {
  constructor(readonly which: "menu" | "pop", readonly mode: Mode) {}
  check = (m: Readonly<World>) => noModal(m) && noPopover(m) && !!byId(SURFACE[this.which].trigger);
  async run(m: World) {
    await step(m, `open ${this.which} (focus: ${this.mode})`, async () => {
      prepareFocus(this.mode, byId(SURFACE[this.which].trigger));
      m.focusBefore = document.activeElement;
      m.opener[this.which] = document.activeElement!;
      m.stack.push(this.which);
      act(() => { fireEvent.click(byId(SURFACE[this.which].trigger)!); });
      await flush();
      m.el[this.which] = surfaceEl(this.which)!;
      expect(m.el[this.which], `${this.which} opens`).toBeTruthy();
      if (this.which === "pop" && m.cfg.popField) expect(document.activeElement?.getAttribute("aria-label"), "autoFocus field keeps focus").toBe("Pop field");
      reconcile(m);
    });
  }
  toString = () => `open ${this.which} (${this.mode})`;
}

class OpenModalCmd implements fc.AsyncCommand<World, Real> {
  constructor(readonly mode: Mode) {}
  check = (m: Readonly<World>) => noModal(m) && noPopover(m) && !!byId("modal-trigger");
  async run(m: World) {
    await step(m, `open m1 (focus: ${this.mode})`, async () => {
      prepareFocus(this.mode, byId("modal-trigger"));
      m.focusBefore = document.activeElement;
      m.opener.m1 = document.activeElement!;
      m.stack.push("m1");
      act(() => { fireEvent.click(byId("modal-trigger")!); });
      await flush();
      m.el.m1 = surfaceEl("m1")!;
      expect(m.el.m1, "m1 opens").toBeTruthy();
      if (m.cfg.modalField) expect(document.activeElement?.getAttribute("aria-label"), "autoFocus field keeps focus").toBe(m.cfg.picker ? "Where" : "M1 field");
      reconcile(m);
    });
  }
  toString = () => `open modal (${this.mode})`;
}

class OpenModal2Cmd implements fc.AsyncCommand<World, Real> {
  check = (m: Readonly<World>) => m.stack[m.stack.length - 1] === "m1";
  async run(m: World) {
    await step(m, "open m2 from m1", async () => {
      const trigger = byId("open-m2")!;
      act(() => trigger.focus());
      m.focusBefore = document.activeElement;
      m.opener.m2 = document.activeElement!;
      m.stack.push("m2");
      act(() => { fireEvent.click(trigger); });
      await flush();
      m.el.m2 = surfaceEl("m2")!;
      expect(m.el.m2, "m2 opens").toBeTruthy();
      reconcile(m);
    });
  }
  toString = () => "open m2 from m1";
}

class KeyCmd implements fc.AsyncCommand<World, Real> {
  constructor(readonly key: string, readonly label: string) {}
  check = () => true;
  async run(m: World) {
    await step(m, this.label, async () => {
      m.focusBefore = document.activeElement;
      const before = m.stack.slice();
      const onTab = document.activeElement?.getAttribute("role") === "tab";
      m.tabbing = this.key === "Tab" || this.key === "Shift+Tab";
      if (m.tabbing) pressTab(this.key === "Shift+Tab");
      else await m.user.keyboard(this.key);
      await flush();
      if (onTab && !m.tabbing) m.tabModel = tabAfterKey(m.tabModel, this.key.slice(1, -1));
      if (this.key === "{Escape}") {
        const open = IDS.filter((id) => surfaceEl(id));
        const closed = before.filter((id) => !open.includes(id));
        const top = before[before.length - 1];
        expect(closed.length, `Esc closes at most one surface (${before.join(",")} → ${open.join(",")}): ${m.log.join(" > ")}`).toBeLessThanOrEqual(1);
        // A popover only gets Esc while focus is in it; a modal gets it wherever focus is (even on <body>).
        const focusInTop = !!top && !!m.focusBefore && !!m.el[top]?.contains(m.focusBefore);
        if (top && (SURFACE[top].kind === "modal" || focusInTop)) expect(closed, `Esc closes the topmost surface: ${m.log.join(" > ")}`).toEqual([top]);
      }
      reconcile(m);
      m.tabbing = false;
    });
  }
  toString = () => this.label;
}

class OutsidePressCmd implements fc.AsyncCommand<World, Real> {
  check = (m: Readonly<World>) => noModal(m) && noPopover(m) === false;
  async run(m: World) {
    await step(m, "press outside", async () => {
      m.focusBefore = document.activeElement;
      act(() => { fireEvent.pointerDown(byId("elsewhere")!); });
      await flush();
      reconcile(m);
    });
  }
  toString = () => "press outside";
}

class PressLayerCmd implements fc.AsyncCommand<World, Real> {
  check = (m: Readonly<World>) => m.stack[m.stack.length - 1] === "m1" || m.stack[m.stack.length - 1] === "m2";
  async run(m: World) {
    await step(m, "press the layer of the top modal", async () => {
      const top = m.stack[m.stack.length - 1]!;
      const dialog = m.el[top]!;
      m.focusBefore = document.activeElement;
      act(() => { fireEvent.pointerDown(dialog); fireEvent.click(dialog); });
      await flush();
      expect(surfaceEl(top), `a press on the layer closes ${top}`).toBeNull();
      reconcile(m);
    });
  }
  toString = () => "press modal layer";
}

class ChooseItemCmd implements fc.AsyncCommand<World, Real> {
  check = (m: Readonly<World>) => m.stack.includes("menu");
  async run(m: World) {
    await step(m, "choose a menu item", async () => {
      m.focusBefore = document.activeElement;
      const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((el) => el.textContent === "First")!;
      act(() => { fireEvent.click(item); });
      await flush();
      expect(surfaceEl("menu")).toBeNull();
      reconcile(m);
    });
  }
  toString = () => "choose menu item";
}

class CloseButtonCmd implements fc.AsyncCommand<World, Real> {
  constructor(readonly which: "close-m1" | "close-m2") {}
  check = (m: Readonly<World>) => this.which === "close-m1" ? m.stack.includes("m1") : m.stack.includes("m2");
  async run(m: World) {
    await step(m, `click ${this.which}`, async () => {
      m.focusBefore = document.activeElement;
      act(() => { fireEvent.click(byId(this.which)!); });
      await flush();
      reconcile(m);
    });
  }
  toString = () => `click ${this.which}`;
}

class RemoveTriggerCmd implements fc.AsyncCommand<World, Real> {
  constructor(readonly which: "menu" | "pop" | "modal") {}
  check = () => !!byId(`${this.which}-trigger`);
  async run(m: World) {
    await step(m, `remove the ${this.which} trigger`, async () => {
      m.focusBefore = document.activeElement;
      act(() => {
        if (this.which === "menu") m.setters.current!.setShowMenuTrigger(false);
        else if (this.which === "pop") m.setters.current!.setShowPopTrigger(false);
        else m.setters.current!.setShowModalTrigger(false);
      });
      await flush();
      // The trigger's removal can itself take focus with it; that is not a close.
      reconcile(m);
    });
  }
  toString = () => `remove ${this.which} trigger`;
}

/** Where a key on a focused tab moves the selection, among the enabled tabs (the disabled one is skipped). */
function tabAfterKey(selected: number, key: string): number {
  const enabled = TAB_NAMES.map((_, i) => i).filter((i) => i !== DISABLED_TAB);
  const at = enabled.indexOf(selected);
  const to = key === "ArrowRight" ? at + 1 : key === "ArrowLeft" ? at - 1 : key === "Home" ? 0 : key === "End" ? enabled.length - 1 : at;
  return enabled[(to + enabled.length) % enabled.length]!;
}

class TabsKeyCmd implements fc.AsyncCommand<World, Real> {
  constructor(readonly key: "ArrowRight" | "ArrowLeft" | "Home" | "End") {}
  check = (m: Readonly<World>) => m.stack.length === 0;
  async run(m: World) {
    await step(m, `tabs: focus the selected tab, ${this.key}`, async () => {
      const tabs = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'));
      act(() => tabs[m.tabModel]!.focus());
      await m.user.keyboard(`{${this.key}}`);
      await flush();
      m.tabModel = tabAfterKey(m.tabModel, this.key);
      checkTabs(m);
      expect(document.activeElement, `focus follows the selection: ${m.log.join(" > ")}`).toBe(tabs[m.tabModel]);
      m.focusBefore = document.activeElement;
    });
  }
  toString = () => `tabs ${this.key}`;
}

class ClickTabCmd implements fc.AsyncCommand<World, Real> {
  constructor(readonly index: number) {}
  check = (m: Readonly<World>) => m.stack.length === 0;
  async run(m: World) {
    await step(m, `click tab ${this.index}`, async () => {
      act(() => { fireEvent.click(document.querySelectorAll<HTMLElement>('[role="tab"]')[this.index]!); });
      await flush();
      if (this.index !== DISABLED_TAB) m.tabModel = this.index;
      checkTabs(m);
      m.focusBefore = document.activeElement;
    });
  }
  toString = () => `click tab ${this.index}`;
}

const commandArbs = [
  fc.tuple(fc.constantFrom<"menu" | "pop">("menu", "pop"), modeArb).map(([w, mode]) => new OpenPopoverCmd(w, mode)),
  fc.tuple(fc.constantFrom<"menu" | "pop">("menu", "pop"), modeArb).map(([w, mode]) => new OpenPopoverCmd(w, mode)),
  modeArb.map((mode) => new OpenModalCmd(mode)),
  fc.constant(new OpenModal2Cmd()),
  fc.constant(new OpenModal2Cmd()),
  fc.constant(new KeyCmd("{Escape}", "Esc")),
  fc.constant(new KeyCmd("{Escape}", "Esc")),
  fc.constant(new KeyCmd("Tab", "Tab")),
  fc.constant(new KeyCmd("Shift+Tab", "Shift+Tab")),
  fc.constant(new KeyCmd("Tab", "Tab")),
  fc.constant(new KeyCmd("Shift+Tab", "Shift+Tab")),
  fc.constantFrom("ArrowDown", "ArrowUp", "Home", "End").map((k) => new KeyCmd(`{${k}}`, k)),
  fc.constantFrom("ArrowDown", "ArrowUp", "Home", "End").map((k) => new KeyCmd(`{${k}}`, k)),
  fc.constant(new OutsidePressCmd()),
  fc.constant(new PressLayerCmd()),
  fc.constant(new ChooseItemCmd()),
  fc.constantFrom<"close-m1" | "close-m2">("close-m1", "close-m2").map((w) => new CloseButtonCmd(w)),
  fc.constantFrom<"menu" | "pop" | "modal">("menu", "pop", "modal").map((w) => new RemoveTriggerCmd(w)),
  fc.constantFrom<"ArrowRight" | "ArrowLeft" | "Home" | "End">("ArrowRight", "ArrowLeft", "Home", "End").map((k) => new TabsKeyCmd(k)),
  fc.constantFrom<"ArrowRight" | "ArrowLeft" | "Home" | "End">("ArrowRight", "ArrowLeft", "Home", "End").map((k) => new TabsKeyCmd(k)),
  fc.integer({ min: 0, max: TAB_NAMES.length - 1 }).map((i) => new ClickTabCmd(i)),
];

// Modal content that takes focus on mount (a field with autoFocus, the PlacePicker's search box) is its own
// property below: ui/Modal remembers the wrong "previous" focus for it.
const plainCfg: fc.Arbitrary<Cfg> = fc.record({ modalField: fc.constant(false), popField: fc.boolean(), picker: fc.constant(false) });
const autoFocusCfg: fc.Arbitrary<Cfg> = fc.record({ modalField: fc.boolean(), popField: fc.boolean(), picker: fc.boolean() })
  .filter((c) => c.modalField || c.picker);

/** Mount, run the commands, unmount everything; the listener count is checked against a warm-up mount. */
async function runSequence(cfg: Cfg, commands: Iterable<fc.AsyncCommand<World, Real>>) {
  const setters: { current: Setters | null } = { current: null };
  const { unmount } = render(createElement(Harness, { cfg, setters }));
  const user = userEvent.setup({ delay: null });
  const world: World = { cfg, user, setters, stack: [], opener: {}, el: {}, focusBefore: document.activeElement, tabModel: 0, log: [], tabbing: false };
  try {
    await fc.asyncModelRun(() => ({ model: world, real: world }), commands as never);
    // The final state, then everything goes at once: whatever is open is unmounted with the page.
    checkTabs(world);
    act(() => unmount());
    expect(document.querySelectorAll("dialog").length, `dialogs left in the document: ${world.log.join(" > ")}`).toBe(0);
    expect(document.body.style.overflow, `<body> scroll lock released: ${world.log.join(" > ")}`).toBe("");
  } finally {
    cleanup();
    document.body.replaceChildren();
  }
}

async function checkProperty(cfgs: fc.Arbitrary<Cfg>) {
  // Warm-up: whatever React and the ui modules attach once for good is the baseline.
  {
    const setters = { current: null as Setters | null };
    const { unmount } = render(createElement(Harness, { cfg: { modalField: false, popField: false, picker: false }, setters }));
    userEvent.setup({ delay: null }); // user-event hangs its own focus / blur listeners on document once
    unmount();
    document.body.replaceChildren();
  }
  trackListeners();
  try {
    await fc.assert(
      fc.asyncProperty(cfgs, fc.commands(commandArbs, { maxCommands: MAX_COMMANDS }), async (cfg, commands) => {
        const baseline = describeLive();
        await runSequence(cfg, commands as Iterable<fc.AsyncCommand<World, Real>>);
        expect(describeLive(), "document/window listeners back to the baseline").toEqual(baseline);
      }),
      fcOpts,
    );
  } finally {
    untrackListeners();
  }
}

describe("ui focus and keyboard: random user sequences", () => {
  it("surfaces hand focus back, trap Tab in modals, close one at a time; tabs stay consistent; nothing leaks", async () => {
    await checkProperty(plainCfg);
  }, PROPS_TIMEOUT_MS);

  it("same, with modal content that takes focus on mount (autoFocus field, PlacePicker)", async () => {
    await checkProperty(autoFocusCfg);
  }, PROPS_TIMEOUT_MS);
});
