import { bindAccountStorage } from "../lib/accountStorage";
// Mobile sidebar long-press drag → reparent ("into").
//
// Regression for [e2e-mobile-sidebar-longpress-reparent]: on touch the
// long-press drag's final pointermove and the pointerup can land on different
// rows when a live re-render shifts the list between them, leaving the drop
// target stale/null and silently dropping the reparent. onUp now RE-hit-tests
// at the release coordinates so performSidebarDrop('into') is reached wherever
// the finger actually lifts. These tests drive the hook with synthetic touch
// PointerEvents (the same shape the Pixel-5 e2e dispatches) in jsdom.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../lib/localDb", () => ({ getPendingWrites: vi.fn(async () => []), upsertNode: vi.fn(async () => {}), removeNode: vi.fn(async () => {}), addPendingWrite: vi.fn(async () => {}) }));
import { renderHook, act, cleanup } from "@testing-library/react";

const apiMock = vi.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve({}));
// The calls that write (the capabilities hook also reads /api/spaces).
const writes = () => apiMock.mock.calls.filter(([path]) => path !== "/api/spaces");
vi.mock("../lib/api", async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, api: (...a: unknown[]) => apiMock(...a) };
});

import { useSidebarDrag } from "../hooks/useSidebarDrag";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { noteStructure } from "../lib/data";
import { onSplitDrop, splitDrag } from "../lib/splitViewStore";

const makeNode = (id: string, over: Partial<ContentNode> = {}): ContentNode => ({
  id,
  title: id,
  slug: id,
  markdown: "",
  node_type: "content",
  source_type: "manual",
  parent_id: null,
  ...over,
});

// A row element with the data-sb-* attributes the hook reads + a stubbed
// getBoundingClientRect so the into-band (y 25–75%) math is deterministic.
function makeRow(id: string, kind: "node" | "group", rect: { top: number; height: number; width: number }) {
  const el = document.createElement("div");
  el.dataset.sbId = id;
  el.dataset.sbKind = kind;
  el.getBoundingClientRect = () =>
    ({ top: rect.top, bottom: rect.top + rect.height, left: 0, right: rect.width, height: rect.height, width: rect.width, x: 0, y: rect.top, toJSON() {} }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

function pointer(type: string, x: number, y: number, target: EventTarget = window) {
  const ev = new PointerEvent(type, {
    pointerType: "touch", isPrimary: true, button: 0, buttons: 1,
    clientX: x, clientY: y, bubbles: true, cancelable: true,
  });
  target.dispatchEvent(ev);
}

function setup(nodes: ContentNode[]) {
  // Moves go through the note writer, which works on the live store.
  resetAppState({ data: { ...noWorkspaceData, nodes }, online: true });
  const { result } = renderHook(() =>
    useSidebarDrag({ nodes, online: true, selectedNodeId: null, selectedNodeParentId: null }),
  );
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
  apiMock.mockClear();
  // jsdom has no real layout — animation frames must still fire so the drag's
  // auto-scroll loop doesn't wedge. Resolve rAF on the macrotask queue.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (h: number) => clearTimeout(h));
});
afterEach(() => {
  cleanup(); // unmount (stops the auto-scroll loop) while the fake animation-frame stubs are still in place
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("useSidebarDrag long-press reparent", () => {
  it("reparents on release even when the last move missed the target row", async () => {
    const child = makeNode("child");
    const host = makeNode("host");
    const childRow = makeRow("child", "node", { top: 0, height: 34, width: 200 });
    const hostRow = makeRow("host", "node", { top: 100, height: 34, width: 200 });
    const result = setup([child, host]);

    // elementFromPoint returns the host row ONLY for the release coordinates;
    // the prior pointermove resolves to nothing (simulating a row that shifted
    // out from under the finger between the last move and lift). jsdom has no
    // layout, so define the method outright rather than spying on a missing one.
    document.elementFromPoint = ((_x: number, y: number) => (y === 117 ? hostRow : null)) as typeof document.elementFromPoint;

    // pointerdown on the child row, hold past the 300ms long-press window
    act(() => {
      result.current.onSbPointerDown(
        { button: 0, pointerType: "touch", clientX: 10, clientY: 17, target: childRow, currentTarget: childRow, stopPropagation() {} } as unknown as React.PointerEvent,
        child, false,
      );
      vi.advanceTimersByTime(350);
    });
    expect(result.current.sbDragId).toBe("child"); // long-press activated

    // a move that lands on nothing (target shifted) → drop target stays null
    act(() => pointer("pointermove", 10, 200));
    expect(result.current.sbDropTarget).toBeNull();

    // release at the host's into-band center (y=117 → 50% of the 100..134 row)
    await act(async () => {
      pointer("pointerup", 10, 117);
      await vi.runOnlyPendingTimersAsync();
    });

    // recompute-at-release reached performSidebarDrop('into') → PATCH parent_id
    expect(apiMock).toHaveBeenCalledWith(
      "/api/nodes/child",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ parent_id: "host", sort_order: 0 }) }),
    );
  });

  it("does not reparent when the release lands off any row", () => {
    const child = makeNode("child");
    const host = makeNode("host");
    const childRow = makeRow("child", "node", { top: 0, height: 34, width: 200 });
    makeRow("host", "node", { top: 100, height: 34, width: 200 });
    const result = setup([child, host]);

    document.elementFromPoint = (() => null) as typeof document.elementFromPoint;

    act(() => {
      result.current.onSbPointerDown(
        { button: 0, pointerType: "touch", clientX: 10, clientY: 17, target: childRow, currentTarget: childRow, stopPropagation() {} } as unknown as React.PointerEvent,
        child, false,
      );
      vi.advanceTimersByTime(350);
    });
    act(() => pointer("pointermove", 10, 60));
    act(() => {
      pointer("pointerup", 10, 999);
      vi.runOnlyPendingTimers();
    });

    expect(writes()).toEqual([]);
  });

  it("held and let go in place: the row's menu opens and nothing moves", async () => {
    const child = makeNode("child");
    const host = makeNode("host");
    const childRow = makeRow("child", "node", { top: 0, height: 34, width: 200 });
    makeRow("host", "node", { top: 100, height: 34, width: 200 });
    const result = setup([child, host]);
    document.elementFromPoint = (() => childRow) as typeof document.elementFromPoint;
    const onHoldRelease = vi.fn();

    act(() => {
      result.current.onSbPointerDown(
        { button: 0, pointerType: "touch", clientX: 10, clientY: 17, target: childRow, currentTarget: childRow, stopPropagation() {} } as unknown as React.PointerEvent,
        child, false, onHoldRelease,
      );
      vi.advanceTimersByTime(350);
    });
    // The browser's own long-press menu fires during the hold: swallowed.
    const native = { preventDefault: vi.fn() } as unknown as React.MouseEvent;
    expect(result.current.consumeTouchContextMenu(native)).toBe(true);
    expect(native.preventDefault).toHaveBeenCalled();
    // A tremble within the slop is still a hold, not a drag.
    act(() => pointer("pointermove", 13, 20));
    await act(async () => {
      pointer("pointerup", 13, 20);
      await vi.runOnlyPendingTimersAsync();
    });

    expect(onHoldRelease).toHaveBeenCalledWith(10, 17);
    expect(result.current.sbDragId).toBeNull();
    expect(writes()).toEqual([]);
    // After the press the next right click is a plain one again.
    act(() => { vi.advanceTimersByTime(500); });
    expect(result.current.consumeTouchContextMenu({ preventDefault() {} } as unknown as React.MouseEvent)).toBe(false);
  });

  it("held then moved: a drag, and no menu", () => {
    const child = makeNode("child");
    const host = makeNode("host");
    const childRow = makeRow("child", "node", { top: 0, height: 34, width: 200 });
    makeRow("host", "node", { top: 100, height: 34, width: 200 });
    const result = setup([child, host]);
    document.elementFromPoint = (() => null) as typeof document.elementFromPoint;
    const onHoldRelease = vi.fn();
    act(() => {
      result.current.onSbPointerDown(
        { button: 0, pointerType: "touch", clientX: 10, clientY: 17, target: childRow, currentTarget: childRow, stopPropagation() {} } as unknown as React.PointerEvent,
        child, false, onHoldRelease,
      );
      vi.advanceTimersByTime(350);
    });
    act(() => pointer("pointermove", 10, 60));
    act(() => { pointer("pointerup", 10, 999); vi.runOnlyPendingTimers(); });
    expect(onHoldRelease).not.toHaveBeenCalled();
  });
});

// D64: a drop renumbers only the target's siblings, and only the rows whose
// sort_order has to change — not every note in the workspace.
describe("useSidebarDrag reorder", () => {
  const at = (i: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString();
  const patches = () => apiMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")
    .map(([path, init]) => ({ id: String(path).split("/").pop(), body: JSON.parse(String((init as RequestInit).body)) }));
  // 200 top-level notes all at sort_order 0 (the default), a tag, and a
  // parent with three ordered children.
  const workspace = () => [
    ...Array.from({ length: 200 }, (_, i) => makeNode(`n${i}`, { sort_order: 0, created_at: at(i) })),
    makeNode("tag", { node_type: "class_tag", sort_order: 0, created_at: at(0) }),
    makeNode("p", { sort_order: 0, created_at: at(300) }),
    ...["a", "b", "c"].map((id, i) => makeNode(id, { parent_id: "p", sort_order: i, created_at: at(301 + i) })),
  ];

  it("dragging one note to the top of 200 writes that note only", async () => {
    vi.useRealTimers();
    const result = setup(workspace());
    await act(async () => { await result.current.performSidebarDrop("n150", "n0", false, "above"); });
    expect(patches()).toEqual([{ id: "n150", body: { sort_order: expect.any(Number) } }]);
    expect(noteStructure.children(null)[0].id).toBe("n150");
  });

  it("a drop between equal siblings writes the shorter side once, then one note", async () => {
    vi.useRealTimers();
    const result = setup(workspace());
    await act(async () => { await result.current.performSidebarDrop("n150", "n3", false, "above"); });
    // n0–n2 and n150 must sort before n3's sort_order 0: four writes, not 200.
    expect(patches().map((p) => p.id).sort()).toEqual(["n0", "n1", "n150", "n2"]);
    let ids = noteStructure.children(null).map((n) => n.id);
    expect(ids.slice(0, 5)).toEqual(["n0", "n1", "n2", "n150", "n3"]);
    // The rows just written are spaced: a move among them writes one row.
    apiMock.mockClear();
    await act(async () => { await result.current.performSidebarDrop("n2", "n0", false, "below"); });
    expect(patches().map((p) => p.id)).toEqual(["n2"]);
    ids = noteStructure.children(null).map((n) => n.id);
    expect(ids.slice(0, 5)).toEqual(["n0", "n2", "n1", "n150", "n3"]);
  });

  it("reorders within a parent without touching other notes or tags", async () => {
    vi.useRealTimers();
    const result = setup(workspace());
    await act(async () => { await result.current.performSidebarDrop("c", "a", false, "below"); });
    expect(patches().map((p) => p.id)).toEqual(["c"]);
    expect(noteStructure.children("p").map((n) => n.id)).toEqual(["a", "c", "b"]);
  });

  it("a note moved next to another parent's child joins that parent in one write", async () => {
    vi.useRealTimers();
    const result = setup(workspace());
    await act(async () => { await result.current.performSidebarDrop("n5", "b", false, "above"); });
    expect(patches()).toEqual([{ id: "n5", body: expect.objectContaining({ parent_id: "p" }) }]);
    expect(noteStructure.children("p").map((n) => n.id)).toEqual(["a", "n5", "b", "c"]);
  });

  it("dropping into a parent puts the note last among its children", async () => {
    vi.useRealTimers();
    const result = setup(workspace());
    await act(async () => { await result.current.performSidebarDrop("n5", "p", true, "into"); });
    expect(patches()).toEqual([{ id: "n5", body: { parent_id: "p", sort_order: 3 } }]);
    expect(noteStructure.children("p").map((n) => n.id)).toEqual(["a", "b", "c", "n5"]);
  });
});

// D101: the drop target is the placement rule (lib/data canPlaceUnder). A drop
// the server would refuse (409 parent_in_other_space, a tag, a descendant)
// shows no target at all — not a target that then rolls back.
describe("useSidebarDrag drop target follows the placement rule (D101)", () => {
  // A drag an earlier test left open still listens on window; end it so its
  // release cannot land on this test's rows.
  beforeEach(() => { pointer("pointercancel", 0, 0); });
  function dragOver(nodes: ContentNode[], dragId: string, targetId: string) {
    const dragRow = makeRow(dragId, "node", { top: 0, height: 34, width: 200 });
    const targetRow = makeRow(targetId, "node", { top: 100, height: 34, width: 200 });
    const result = setup(nodes);
    document.elementFromPoint = ((_x: number, y: number) => (y >= 100 && y < 134 ? targetRow : null)) as typeof document.elementFromPoint;
    act(() => {
      result.current.onSbPointerDown(
        { button: 0, pointerType: "touch", clientX: 10, clientY: 17, target: dragRow, currentTarget: dragRow, stopPropagation() {} } as unknown as React.PointerEvent,
        nodes.find((n) => n.id === dragId)!, false,
      );
      vi.advanceTimersByTime(350);
    });
    act(() => pointer("pointermove", 10, 117)); // the into band
    return result;
  }

  it("a note of another space shows no drop target, and releasing there writes nothing", async () => {
    const result = dragOver([makeNode("child", { space_id: "s1" }), makeNode("host", { space_id: "s2" })], "child", "host");
    expect(result.current.sbDropTarget).toBeNull();
    await act(async () => {
      pointer("pointerup", 10, 117);
      await vi.runOnlyPendingTimersAsync();
    });
    expect(writes()).toEqual([]);
  });

  it("a note of the same space shows the drop target", () => {
    const result = dragOver([makeNode("child", { space_id: "s1" }), makeNode("host", { space_id: "s1" })], "child", "host");
    expect(result.current.sbDropTarget).toEqual({ id: "host", pos: "into" });
  });

  it("a tag or the note's own descendant shows no drop target", () => {
    let result = dragOver([makeNode("child"), makeNode("tag", { node_type: "class_tag" })], "child", "tag");
    expect(result.current.sbDropTarget).toBeNull();
    document.body.innerHTML = "";
    result = dragOver([makeNode("child"), makeNode("grandkid", { parent_id: "child" })], "child", "grandkid");
    expect(result.current.sbDropTarget).toBeNull();
  });

  it("beside another space's top-level row shows no drop line (the note would stay in its own space)", () => {
    const nodes = [makeNode("child", { space_id: "s1" }), makeNode("host", { space_id: "s2" })];
    const dragRow = makeRow("child", "node", { top: 0, height: 34, width: 200 });
    const targetRow = makeRow("host", "node", { top: 100, height: 34, width: 200 });
    const result = setup(nodes);
    document.elementFromPoint = ((_x: number, y: number) => (y >= 100 && y < 134 ? targetRow : null)) as typeof document.elementFromPoint;
    act(() => {
      result.current.onSbPointerDown(
        { button: 0, pointerType: "touch", clientX: 10, clientY: 17, target: dragRow, currentTarget: dragRow, stopPropagation() {} } as unknown as React.PointerEvent,
        nodes[0]!, false,
      );
      vi.advanceTimersByTime(350);
    });
    act(() => pointer("pointermove", 10, 102)); // the above band
    expect(result.current.sbDropTarget).toBeNull();
  });

  it("performSidebarDrop refuses a cross-space drop too (no PATCH)", async () => {
    vi.useRealTimers();
    const result = setup([makeNode("child", { space_id: "s1" }), makeNode("host", { space_id: "s2" })]);
    await act(async () => { await result.current.performSidebarDrop("child", "host", false, "into"); });
    expect(writes()).toEqual([]);
  });
});

beforeEach(() => { bindAccountStorage("unit-test-account", ""); });

// A resting fingertip jitters; the hold must survive that, and give way to a real scroll.
describe("useSidebarDrag hold vs scroll", () => {
  beforeEach(() => { pointer("pointercancel", 0, 0); });
  function press(pointerType: "touch" | "pen") {
    const child = makeNode("child");
    const host = makeNode("host");
    const childRow = makeRow("child", "node", { top: 0, height: 34, width: 200 });
    const hostRow = makeRow("host", "node", { top: 100, height: 34, width: 200 });
    const result = setup([child, host]);
    document.elementFromPoint = ((_x: number, y: number) => (y >= 100 && y < 134 ? hostRow : null)) as typeof document.elementFromPoint;
    act(() => {
      result.current.onSbPointerDown(
        { button: 0, pointerType, clientX: 10, clientY: 17, target: childRow, currentTarget: childRow, stopPropagation() {} } as unknown as React.PointerEvent,
        child, false,
      );
    });
    return result;
  }
  const move = (x: number, y: number, pointerType = "touch") =>
    window.dispatchEvent(new PointerEvent("pointermove", { pointerType, isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  const touchMove = (cancelable: boolean) => {
    const ev = new Event("touchmove", { bubbles: true, cancelable });
    window.dispatchEvent(ev);
    return ev;
  };

  it("a 6px wobble before the hold still lifts the row, and the list does not scroll once lifted", () => {
    const result = press("touch");
    act(() => { move(10, 23); vi.advanceTimersByTime(350); });
    expect(result.current.sbDragId).toBe("child");
    expect(touchMove(true).defaultPrevented).toBe(true);
    act(() => move(10, 117));
    expect(result.current.sbDropTarget).toEqual({ id: "host", pos: "into" });
  });

  it("a quick swipe is a scroll: nothing lifts, and touchmove is left to the browser", () => {
    const result = press("touch");
    act(() => { move(10, 40); vi.advanceTimersByTime(350); });
    expect(result.current.sbDragId).toBeNull();
    expect(touchMove(true).defaultPrevented).toBe(false);
  });

  it("the browser already scrolling (touchmove not cancelable) cancels the lifted row instead of dragging beside the scroll", () => {
    const result = press("touch");
    act(() => { vi.advanceTimersByTime(350); });
    expect(result.current.sbDragId).toBe("child");
    act(() => { touchMove(false); });
    expect(result.current.sbDragId).toBeNull();
    expect(result.current.sbDragOverlay).toBeNull();
  });

  it("an S Pen hold drags like a finger", () => {
    const result = press("pen");
    act(() => move(10, 22, "pen"));
    expect(result.current.sbDragId).toBeNull(); // moving never starts a drag: the browser would scroll the list
    act(() => { vi.advanceTimersByTime(350); });
    expect(result.current.sbDragId).toBe("child");
    act(() => move(10, 117, "pen"));
    expect(result.current.sbDropTarget).toEqual({ id: "host", pos: "into" });
  });

  it("a short tap lifts nothing", () => {
    const result = press("touch");
    act(() => { vi.advanceTimersByTime(100); window.dispatchEvent(new PointerEvent("pointerup", { pointerType: "touch", button: 0, clientX: 10, clientY: 17 })); });
    vi.advanceTimersByTime(350);
    expect(result.current.sbDragId).toBeNull();
  });

  it("held and let go in place calls the menu, not a drop", () => {
    const row = makeRow("child", "node", { top: 0, height: 34, width: 200 });
    const result = setup([makeNode("child")]);
    const onHold = vi.fn();
    act(() => {
      result.current.onSbPointerDown(
        { button: 0, pointerType: "touch", clientX: 10, clientY: 17, target: row, currentTarget: row, stopPropagation() {} } as unknown as React.PointerEvent,
        makeNode("child"), false, onHold,
      );
      vi.advanceTimersByTime(350);
      move(10, 21); // jitter inside the slop
      window.dispatchEvent(new PointerEvent("pointerup", { pointerType: "touch", button: 0, clientX: 10, clientY: 21 }));
    });
    expect(onHold).toHaveBeenCalledWith(10, 17);
    expect(result.current.sbDragId).toBeNull();
  });
});

describe("side by side: a note dragged from the sidebar", () => {
  beforeEach(() => { document.elementFromPoint = () => null; });
  const mouse = (type: string, x: number, y: number) => act(() => {
    window.dispatchEvent(new PointerEvent(type, { pointerType: "mouse", isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  });
  const press = (result: ReturnType<typeof setup>, row: HTMLElement) => act(() => {
    result.current.onSbPointerDown(
      { button: 0, pointerType: "mouse", clientX: 10, clientY: 17, target: row, currentTarget: row, stopPropagation() {} } as unknown as React.PointerEvent,
      makeNode("a"), false,
    );
  });

  it("released over the right half it opens beside, and the sidebar does not also move it", () => {
    vi.stubGlobal("innerWidth", 1280);
    const drops: unknown[] = [];
    const stop = onSplitDrop((target, side) => { drops.push([target, side]); });
    const result = setup([makeNode("a"), makeNode("b")]);
    const row = makeRow("a", "node", { top: 0, height: 34, width: 240 });
    press(result, row);
    mouse("pointermove", 400, 20);
    expect(splitDrag.active()).toBe(true);
    mouse("pointermove", 1000, 20);
    mouse("pointerup", 1000, 20);
    expect(drops).toEqual([[{ kind: "note", id: "a", tab: "content" }, "right"]]);
    expect(writes()).toEqual([]);
    expect(splitDrag.active()).toBe(false);
    stop();
  });

  it("released over the sidebar it is the sidebar's own drop: nothing opens on the right", () => {
    vi.stubGlobal("innerWidth", 1280);
    const drops: unknown[] = [];
    const stop = onSplitDrop((target, side) => { drops.push([target, side]); });
    const result = setup([makeNode("a"), makeNode("b")]);
    const row = makeRow("a", "node", { top: 0, height: 34, width: 240 });
    press(result, row);
    mouse("pointermove", 100, 20);
    mouse("pointerup", 100, 20);
    expect(drops).toEqual([]);
    expect(splitDrag.active()).toBe(false);
    stop();
  });
});
