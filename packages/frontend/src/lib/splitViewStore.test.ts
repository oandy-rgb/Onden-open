import { afterEach, describe, expect, it, vi } from "vitest";
import { applySavedSplit, applyUrlRight, canSplit, getSplit, onSplitDrop, refuseRight, requestSplitOpen, rightSearch, setRatio, setRight, splitDrag } from "./splitViewStore";
import type { PaneTarget } from "./splitView";

// The phone layout is one media query (lib/mediaQuery); the tests flip it here.
const layout = vi.hoisted(() => ({ phone: false }));
vi.mock("./mediaQuery", async (importOriginal) => ({ ...(await importOriginal<object>()), isMobileLayout: () => layout.phone }));

const note = (id: string, tab = "content"): PaneTarget => ({ kind: "note", id, tab });
const page = (mode: string): PaneTarget => ({ kind: "page", mode });

afterEach(() => { layout.phone = false; splitDrag.cancel(); setRight(null); setRatio(0.5); applyUrlRight(null); vi.unstubAllGlobals(); });

describe("which destinations may go to the right", () => {
  it("refuses the left's own saved view and the left's own page, allows other views and 並排", () => {
    expect(refuseRight(note("a", "v1"), note("a", "v1"))).toBe("same-view");
    expect(refuseRight(note("a"), note("a"))).toBeNull();
    expect(refuseRight(page("tasks"), page("tasks"))).toBe("same-page");
    expect(refuseRight(note("a"), note("a", "canvas"))).toBeNull();
    expect(refuseRight(null, note("a"))).toBeNull();
  });
});

describe("the right side in the address bar", () => {
  it("is written after the location and read back; nothing when closed", () => {
    expect(rightSearch(null)).toBe("");
    expect(rightSearch(page("tasks"))).toBe("&right=page%3Atasks");
    applyUrlRight("note:n1:canvas");
    expect(getSplit().right).toEqual(note("n1", "canvas"));
    applyUrlRight(null);
    expect(getSplit().right).toBeNull();
  });
  it("keeps the ratio inside its bounds", () => {
    setRatio(0.9);
    expect(getSplit().ratio).toBe(0.75);
    setRatio(0.5);
  });
});

describe("dragging into a side", () => {
  const drops: Array<[PaneTarget, string, string]> = [];
  const listen = () => onSplitDrop((target, side, from) => { drops.push([target, side, from]); });
  const width = (px: number) => vi.stubGlobal("innerWidth", px);

  it("a drop on the right half opens the destination on the right — from a tab, a note or a function alike", () => {
    width(1280);
    const stop = listen();
    for (const [target, from] of [[note("n", "canvas"), "tab"], [note("n"), "note"], [page("tasks"), "function"]] as const) {
      splitDrag.begin(target, from);
      splitDrag.move(1000);
      expect(splitDrag.drop(1000)).toBe(true);
    }
    expect(drops.map(([target, side, from]) => [target.kind, side, from])).toEqual([["note", "right", "tab"], ["note", "right", "note"], ["page", "right", "function"]]);
    expect(splitDrag.active()).toBe(false);
    drops.length = 0; stop();
  });

  it("a drop on the left half does nothing for a new destination (the click already loads the left)", () => {
    width(1280);
    const stop = listen();
    splitDrag.begin(note("n"), "tab");
    expect(splitDrag.drop(100)).toBe(false);
    expect(drops).toEqual([]);
    stop();
  });

  it("the right pane's own header can be dropped on the left to read it there", () => {
    width(1280);
    const stop = listen();
    splitDrag.begin(note("n"), "right-header");
    expect(splitDrag.drop(100)).toBe(true);
    expect(drops.pop()).toEqual([note("n"), "left", "right-header"]);
    stop();
  });

  it("giving the drag up (Esc, through SplitDropHint) opens nothing", () => {
    width(1280);
    const stop = listen();
    splitDrag.begin(page("tasks"), "function");
    splitDrag.move(1000);
    expect(splitDrag.cancel()).toBe(true);
    expect(splitDrag.active()).toBe(false);
    expect(splitDrag.drop(1000)).toBe(false);
    expect(drops).toEqual([]);
    stop();
  });

  it("a menu entry asks for the same thing a drop does", () => {
    const stop = listen();
    requestSplitOpen(page("graph"), "right");
    expect(drops.pop()).toEqual([page("graph"), "right", "menu"]);
    stop();
  });
});

describe("a phone has no side by side (owner, 2026-11-08)", () => {
  it("canSplit follows the layout", () => {
    expect(canSplit()).toBe(true);
    layout.phone = true;
    expect(canSplit()).toBe(false);
  });

  it("ignores right= in the address and the account's saved pane", () => {
    layout.phone = true;
    applyUrlRight("note:n1:content", true);
    applySavedSplit({ right: "page:tasks", ratio: 0.4 });
    expect(getSplit().right).toBeNull();
    expect(getSplit().ratio).toBe(0.5);
  });

  it("applies both on a desktop", () => {
    applyUrlRight("note:n1:content");
    expect(getSplit().right).toEqual(note("n1"));
    applyUrlRight(null);
    applySavedSplit({ right: "page:tasks", ratio: 0.4 });
    expect(getSplit().right).toEqual(page("tasks"));
    expect(getSplit().ratio).toBe(0.4);
  });

  it("opens nothing: not setRight, not a menu entry, not a drag", () => {
    layout.phone = true;
    const drops: unknown[] = [];
    const stop = onSplitDrop((...args) => { drops.push(args); });
    setRight(note("n"));
    requestSplitOpen(page("tasks"), "right");
    splitDrag.begin(note("n"), "note");
    expect(getSplit().right).toBeNull();
    expect(drops).toEqual([]);
    expect(splitDrag.active()).toBe(false);
    stop();
  });
});
