import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { arriveAtScreen, clearPageScrollMemory, markHistoryStep, scrollClaimedFor, watchScrolling } from "../lib/pageScrollRestore";
import { usePageScrollRestore } from "../hooks/usePageScrollRestore";
import { setPendingFind, takePendingFind } from "../lib/findInNote";
import { revealBlockInNote, clearReveal } from "../lib/noteReveal";
import { setPendingCursor } from "../lib/cursorHandoff";
import { removeSession, SESSION_KEYS } from "../lib/sessionPrefs";

let entry: string | null = "e1";
vi.mock("../hooks/useUrlLocation", () => ({ currentEntryId: () => entry }));

/** A scroller whose content height the test controls (jsdom has no layout). */
function makeScroller(name: string, height = 5000, view = 800) {
  const el = document.createElement("section");
  el.setAttribute("data-scroll-memory", name);
  const size = { height };
  Object.defineProperty(el, "scrollHeight", { get: () => size.height });
  Object.defineProperty(el, "clientHeight", { get: () => view });
  document.body.appendChild(el);
  return { el, size };
}

/** The person scrolls `el` (or the window) to `y`: the scroll event the browser sends. */
function scrollTo(el: HTMLElement | null, y: number) {
  if (el) { el.scrollTop = y; el.dispatchEvent(new Event("scroll")); } else { Object.defineProperty(window, "scrollY", { configurable: true, value: y }); document.dispatchEvent(new Event("scroll")); }
}

let stopWatching: () => void;
let at: { entry: string; screen: string } | null;
beforeEach(() => {
  clearPageScrollMemory(); entry = "e1"; at = { entry: "e1", screen: "notes|edit|A" };
  stopWatching = watchScrolling(() => at);
  document.body.innerHTML = "";
});
afterEach(() => { // the explicit targets are one-shot per note: none may outlive its test
  stopWatching(); vi.restoreAllMocks(); vi.unstubAllGlobals(); clearReveal(); takePendingFind("A"); removeSession(SESSION_KEYS.pendingCursor("A"));
});

/** The person scrolls the page of entry `e` to `y` and leaves it: its screen is gone (nothing is shown under an entry). */
const leave = (e: string, screen: string, y: number, name = "note-edit") => {
  at = { entry: e, screen };
  if (name === "window") scrollTo(null, y);
  else { const s = makeScroller(name); scrollTo(s.el, y); s.el.remove(); }
  at = null;
};
const arrive = (e: string | null, screen: string, over: Partial<Parameters<typeof arriveAtScreen>[0]> = {}) =>
  arriveAtScreen({ entry: e, screen, noteId: "A", explicitTarget: false, ...over });

describe("pageScrollRestore: entry-keyed positions", () => {
  it("Back puts the note back where its entry was left", () => {
    leave("e1", "notes|edit|A", 3000);
    const note = makeScroller("note-edit");
    markHistoryStep("entry");
    const stop = arrive("e1", "notes|edit|A");
    expect(note.el.scrollTop).toBe(3000); // at once, before any frame: a layout effect shows no jump
    stop();
  });

  it("Forward restores the same way: the mark says a step, not which direction", () => {
    leave("e2", "notes|edit|B", 1200);
    const note = makeScroller("note-edit");
    markHistoryStep("entry");
    arrive("e2", "notes|edit|B")();
    expect(note.el.scrollTop).toBe(1200);
  });

  it("a note opened any other way starts at the top and the stale position is not used later", () => {
    leave("e1", "notes|edit|A", 3000);
    const note = makeScroller("note-edit");
    arrive("e1", "notes|edit|A")(); // no step mark: a fresh open
    expect(note.el.scrollTop).toBe(0);
    arrive("e1", "notes|edit|A")(); // the mark was never set; a later arrival is no step either
    expect(note.el.scrollTop).toBe(0);
  });

  it("the same note in two entries has two positions", () => {
    leave("e1", "notes|edit|A", 3000);
    leave("e3", "notes|edit|A", 700);
    const note = makeScroller("note-edit");
    markHistoryStep("entry"); arrive("e3", "notes|edit|A")();
    expect(note.el.scrollTop).toBe(700);
    markHistoryStep("entry"); arrive("e1", "notes|edit|A")();
    expect(note.el.scrollTop).toBe(3000);
  });

  it("an entry nobody scrolled starts at the top, even when the same note was left elsewhere", () => {
    leave("e1", "notes|edit|A", 3000);
    const note = makeScroller("note-edit");
    markHistoryStep("entry"); arrive("e9", "notes|edit|A")();
    expect(note.el.scrollTop).toBe(0);
  });

  it("only the lens the entry was left in is put back", () => {
    leave("e1", "notes|edit|A", 3000, "note-edit");
    const preview = makeScroller("note-preview");
    markHistoryStep("entry"); arrive("e1", "notes|edit|A")();
    expect(preview.el.scrollTop).toBe(0);
  });

  it("a step without an entry of its own (the deleted note's list) finds the latest page of that name that was left", () => {
    leave("e0", "notes|list|", 1600, "window");
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(5000);
    const to = vi.fn(); vi.stubGlobal("scrollTo", to);
    markHistoryStep("in place"); arrive("e1", "notes|list|", { noteId: null })();
    expect(to).toHaveBeenCalledWith(0, 1600);
  });

  it("the browser's step stays the entry's even when the link trail then steps in state", () => {
    leave("e1", "notes|edit|A", 3000);
    markHistoryStep("entry"); markHistoryStep("in place");
    const note = makeScroller("note-edit");
    arrive("e9", "notes|edit|A")(); // an entry with no position: the trail's step must not find another entry's
    expect(note.el.scrollTop).toBe(0);
  });

  it("remembers the 50 latest entries only", () => {
    for (let i = 0; i < 51; i++) leave(`x${i}`, "s", 100 + i);
    const note = makeScroller("note-edit");
    markHistoryStep("entry"); arrive("x0", "s")();
    expect(note.el.scrollTop).toBe(0); // the oldest is forgotten
    markHistoryStep("entry"); arrive("x1", "s")();
    expect(note.el.scrollTop).toBe(101);
  });

  it("a mark nothing used lapses: the next opening is no step", () => {
    leave("e1", "notes|edit|A", 3000);
    const note = makeScroller("note-edit");
    vi.spyOn(Date, "now").mockReturnValue(1000);
    markHistoryStep("entry");
    vi.spyOn(Date, "now").mockReturnValue(5000);
    arrive("e1", "notes|edit|A")();
    expect(note.el.scrollTop).toBe(0);
  });

  it("records only while the entry is known: a clamp in the middle of a screen change is nobody's position", () => {
    at = null;
    const note = makeScroller("note-edit"); scrollTo(note.el, 10);
    markHistoryStep("entry"); arrive("e1", "notes|edit|A")();
    expect(note.el.scrollTop).toBe(0); // nothing was recorded for e1, so nothing is put back: the page is at the top
  });

  it("a step reads where the page is at that moment: the last scroll events can arrive after the screen has changed", () => {
    const note = makeScroller("note-edit");
    at = { entry: "e1", screen: "notes|edit|A" };
    note.el.scrollTop = 1800; // scrolled, its event not delivered yet
    markHistoryStep("entry");
    at = null; // the screen changes; the event, delivered now, is nobody's
    scrollTo(note.el, 0);
    note.el.scrollTop = 0;
    markHistoryStep("entry"); arrive("e1", "notes|edit|A")();
    expect(note.el.scrollTop).toBe(1800);
  });

  it("a page opened any other way is put at the top: the scroller outlives the note it showed", () => {
    const note = makeScroller("note-edit");
    note.el.scrollTop = 2500; // the previous note's scroll, kept by the same element
    arrive("e5", "notes|edit|B")();
    expect(note.el.scrollTop).toBe(0);
  });

  it("...and so is the phone's window", () => {
    const to = vi.fn(); vi.stubGlobal("scrollTo", to);
    Object.defineProperty(window, "scrollY", { configurable: true, value: 6100 });
    arrive("e5", "notes|edit|B")();
    expect(to).toHaveBeenCalledWith(0, 0);
  });
});

describe("pageScrollRestore: explicit targets win", () => {
  it.each([
    ["a line to reveal", () => revealBlockInNote("A", "blk1")],
    ["words to find", () => setPendingFind("A", "needle")],
    ["a caret handoff", () => setPendingCursor("A", 12)],
  ])("%s", (_name, ask) => {
    stopWatching();
    const note = makeScroller("note-edit");
    const hook = renderHook(({ screen }) => usePageScrollRestore(screen, "A"), { initialProps: { screen: "notes|edit|A" } });
    act(() => scrollTo(note.el, 3000)); // e1 is left at 3000
    entry = "e2";
    act(() => hook.rerender({ screen: "notes|edit|B" }));
    note.el.scrollTop = 0;
    entry = "e1";
    ask(); // the opening of A names a place of its own
    markHistoryStep("entry");
    act(() => hook.rerender({ screen: "notes|edit|A" }));
    expect(note.el.scrollTop).toBe(0); // the remembered position did not override it
    expect(scrollClaimedFor("A")).toBe(false);
    hook.unmount();
  });

  it("a Back to a note claims its scroll so the editor's caret scroll stays out of it, until the next screen", () => {
    leave("e1", "notes|edit|A", 3000);
    makeScroller("note-edit");
    markHistoryStep("entry"); const stop = arrive("e1", "notes|edit|A");
    expect(scrollClaimedFor("A")).toBe(true);
    stop(); arrive("e1", "notes|edit|A")();
    expect(scrollClaimedFor("A")).toBe(false);
  });
});

describe("restoring into content that arrives late", () => {
  it("an element scroller goes as far as it can now and the rest as the body grows, then stops", async () => {
    leave("e1", "notes|edit|A", 3000);
    const note = makeScroller("note-edit", 900); // the body is not here yet: a placeholder
    markHistoryStep("entry");
    const stop = arrive("e1", "notes|edit|A");
    expect(note.el.scrollTop).toBe(100); // as far as the placeholder allows
    note.size.height = 6000; // the body is hydrated
    await vi.waitFor(() => expect(note.el.scrollTop).toBe(3000));
    stop();
  });

  it("waits for a scroller that is not on the page yet", async () => {
    leave("e1", "notes|edit|A", 2000);
    markHistoryStep("entry");
    const stop = arrive("e1", "notes|edit|A");
    const note = makeScroller("note-edit", 6000);
    await vi.waitFor(() => expect(note.el.scrollTop).toBe(2000));
    stop();
  });

  it.each(["wheel", "keydown", "touchstart", "pointerdown"])("the person's own %s ends it: it never fights them", async (type) => {
    leave("e1", "notes|edit|A", 3000);
    const note = makeScroller("note-edit", 900);
    markHistoryStep("entry"); arrive("e1", "notes|edit|A");
    window.dispatchEvent(new Event(type));
    note.size.height = 6000;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(note.el.scrollTop).toBe(100);
  });

  it("gives up after a bounded time when the page never grows", async () => {
    leave("e1", "notes|edit|A", 3000);
    const note = makeScroller("note-edit", 900);
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(10_000);
    markHistoryStep("entry"); arrive("e1", "notes|edit|A");
    note.size.height = 6000;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(note.el.scrollTop).toBe(100);
  });
});

describe("usePageScrollRestore", () => {
  beforeEach(() => { vi.stubGlobal("scrollTo", vi.fn()); window.history.scrollRestoration = "auto"; });
  afterEach(() => { window.history.scrollRestoration = "auto"; });

  it("owns the page's scroll for as long as it is mounted: the browser's own restoring would move it again", () => {
    const hook = renderHook(() => usePageScrollRestore("notes|list|", null));
    expect(window.history.scrollRestoration).toBe("manual");
    hook.unmount();
    expect(window.history.scrollRestoration).toBe("auto");
  });

  it("puts the position back in the layout effect of the screen a Back arrives at, and records under the entry once it is known", () => {
    stopWatching(); // the hook watches for itself
    const note = makeScroller("note-edit");
    const hook = renderHook(({ screen }) => usePageScrollRestore(screen, "A"), { initialProps: { screen: "notes|edit|A" } });
    act(() => scrollTo(note.el, 2500)); // recorded under e1
    entry = "e2";
    act(() => hook.rerender({ screen: "notes|edit|B" })); // a forward open: entry e2 now; the person scrolls it
    act(() => scrollTo(note.el, 40));
    note.el.scrollTop = 0;
    entry = "e1";
    markHistoryStep("entry");
    act(() => hook.rerender({ screen: "notes|edit|A" }));
    expect(note.el.scrollTop).toBe(2500);
    hook.unmount();
  });
});
