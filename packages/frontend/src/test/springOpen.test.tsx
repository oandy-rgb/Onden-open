import { bindAccountStorage } from "../lib/accountStorage";
// Spring-loaded folders: a held note that stays over a folded row opens it for this drag only
// (lib/springOpen, hooks/useSidebarDrag); a drop keeps open just where it landed.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../lib/localDb", () => ({ getPendingWrites: vi.fn(async () => []), upsertNode: vi.fn(async () => {}), removeNode: vi.fn(async () => {}), addPendingWrite: vi.fn(async () => {}) }));
import { renderHook, act, cleanup } from "@testing-library/react";

const apiMock = vi.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve({}));
vi.mock("../lib/api", async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, api: (...a: unknown[]) => apiMock(...a) };
});

import { useSidebarDrag } from "../hooks/useSidebarDrag";
import { ApiError, noWorkspaceData, type ContentNode } from "../lib/api";
import { resetAppState, getAppState } from "../lib/appStore";
import { refreshSpaces, resetSpacesForTest, type Space } from "../lib/spaces";
import { reads } from "../lib/data";
import { PREFS, getPrefJson } from "../lib/prefs";
import { SPRING_OPEN_MS, SPRING_OPEN_TOUCH_MS, createSpringOpen } from "../lib/springOpen";

const makeNode = (id: string, over: Partial<ContentNode> = {}): ContentNode => ({
  id, title: id, slug: id, markdown: "", node_type: "content", source_type: "manual", parent_id: null, ...over,
});

function makeRow(id: string, kind: "node" | "group", top: number, expanded?: boolean) {
  const el = document.createElement("div");
  el.dataset.sbId = id;
  el.dataset.sbKind = kind;
  if (kind === "group") el.dataset.sbExpanded = String(!!expanded);
  const height = 34;
  el.getBoundingClientRect = () => ({ top, bottom: top + height, left: 0, right: 200, height, width: 200, x: 0, y: top, toJSON() {} }) as DOMRect;
  document.body.appendChild(el);
  return el;
}
const mid = (top: number) => top + 17; // the "into" band of a 34px row

function pointer(type: string, x: number, y: number, pointerType = "mouse") {
  window.dispatchEvent(new PointerEvent(type, { pointerType, isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y, bubbles: true, cancelable: true }));
}

function setup(nodes: ContentNode[]) {
  resetAppState({ data: { ...noWorkspaceData, nodes }, online: true });
  return renderHook(() => useSidebarDrag({ nodes, online: true, selectedNodeId: null, selectedNodeParentId: null }));
}

/** Row elements by their top; elementFromPoint answers the one whose 34px band holds y. */
function layout(rows: Array<[HTMLElement, number]>) {
  document.elementFromPoint = ((_x: number, y: number) => rows.find(([, top]) => y >= top && y < top + 34)?.[0] ?? null) as typeof document.elementFromPoint;
}

function startMouseDrag(result: { current: ReturnType<typeof useSidebarDrag> }, node: ContentNode, row: HTMLElement) {
  act(() => {
    result.current.onSbPointerDown(
      { button: 0, pointerType: "mouse", clientX: 10, clientY: 17, target: row, currentTarget: row, stopPropagation() {} } as unknown as React.PointerEvent,
      node, false,
    );
  });
  act(() => pointer("pointermove", 10, 40)); // past the drag slop
}

beforeEach(() => {
  vi.useFakeTimers();
  apiMock.mockReset();
  apiMock.mockImplementation(() => Promise.resolve({}));
  localStorage.clear();
  expect(bindAccountStorage("u", "")).toBe(true);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (h: number) => clearTimeout(h));
});
afterEach(() => {
  cleanup(); // unmount while the fake animation-frame stubs are still in place
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("createSpringOpen", () => {
  it("opens only after the row has been stayed on for the whole delay", () => {
    const calls: string[] = [];
    const spring = createSpringOpen(700, { onArm: (id) => calls.push(`arm ${id}`), onDisarm: () => calls.push("disarm"), onOpen: (id) => calls.push(`open ${id}`) });
    spring.hover("a");
    vi.advanceTimersByTime(699);
    expect(calls).toEqual(["arm a"]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(["arm a", "open a"]);
  });

  it("staying on the same row keeps the timer; passing through does not open", () => {
    const calls: string[] = [];
    const spring = createSpringOpen(700, { onArm: (id) => calls.push(`arm ${id}`), onDisarm: () => calls.push("disarm"), onOpen: (id) => calls.push(`open ${id}`) });
    spring.hover("a");
    vi.advanceTimersByTime(400);
    spring.hover("a");
    vi.advanceTimersByTime(300);
    expect(calls).toEqual(["arm a", "open a"]);
    const passing: string[] = [];
    const other = createSpringOpen(700, { onArm: () => {}, onDisarm: () => passing.push("disarm"), onOpen: (id) => passing.push(`open ${id}`) });
    other.hover("b");
    vi.advanceTimersByTime(600);
    other.hover(null);
    vi.advanceTimersByTime(5000);
    expect(passing).toEqual(["disarm"]);
  });

  it("cancel clears the timer", () => {
    const onOpen = vi.fn();
    const spring = createSpringOpen(700, { onArm: () => {}, onDisarm: () => {}, onOpen });
    spring.hover("a");
    spring.cancel();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe("sidebar drag spring-open", () => {
  const nodes = () => [
    makeNode("src"),
    makeNode("host"),
    makeNode("kid", { parent_id: "host" }),
    makeNode("leaf"),
  ];

  it("opens a folded group after the wait, shows it open, and does not save it", () => {
    const { result } = setup(nodes());
    const src = makeRow("src", "node", 0);
    const host = makeRow("host", "group", 100);
    layout([[src, 0], [host, 100]]);
    startMouseDrag(result, nodes()[0], src);

    act(() => pointer("pointermove", 10, mid(100)));
    expect(result.current.springHint).toEqual({ id: "host", ms: SPRING_OPEN_MS });
    act(() => { vi.advanceTimersByTime(SPRING_OPEN_MS - 1); });
    expect(result.current.expandedGroups.has("host")).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.expandedGroups.has("host")).toBe(true);
    expect(result.current.springHint).toBeNull();
    expect(getPrefJson(PREFS.expandedGroups)).toEqual([]);
  });

  it("small movement on the same row does not restart the wait", () => {
    const { result } = setup(nodes());
    const src = makeRow("src", "node", 0);
    const host = makeRow("host", "group", 100);
    layout([[src, 0], [host, 100]]);
    startMouseDrag(result, nodes()[0], src);
    act(() => pointer("pointermove", 10, mid(100)));
    act(() => { vi.advanceTimersByTime(500); });
    act(() => pointer("pointermove", 14, mid(100) + 3));
    act(() => { vi.advanceTimersByTime(200); });
    expect(result.current.expandedGroups.has("host")).toBe(true);
  });

  it("passing over a row does not open it", () => {
    const { result } = setup(nodes());
    const src = makeRow("src", "node", 0);
    const host = makeRow("host", "group", 100);
    layout([[src, 0], [host, 100]]);
    startMouseDrag(result, nodes()[0], src);
    act(() => pointer("pointermove", 10, mid(100)));
    act(() => { vi.advanceTimersByTime(400); });
    act(() => pointer("pointermove", 10, 300)); // off every row
    act(() => { vi.advanceTimersByTime(2000); });
    expect(result.current.expandedGroups.has("host")).toBe(false);
    expect(result.current.springHint).toBeNull();
  });

  it("only the into band of the row waits; its top edge (a reorder) does not", () => {
    const { result } = setup(nodes());
    const src = makeRow("src", "node", 0);
    const host = makeRow("host", "group", 100);
    layout([[src, 0], [host, 100]]);
    startMouseDrag(result, nodes()[0], src);
    act(() => pointer("pointermove", 10, 101));
    act(() => { vi.advanceTimersByTime(2000); });
    expect(result.current.expandedGroups.has("host")).toBe(false);
  });

  it("a row without children does not open; the drop is still 'into' it", () => {
    const { result } = setup(nodes());
    const src = makeRow("src", "node", 0);
    const leaf = makeRow("leaf", "node", 100);
    layout([[src, 0], [leaf, 100]]);
    startMouseDrag(result, nodes()[0], src);
    act(() => pointer("pointermove", 10, mid(100)));
    expect(result.current.sbDropTarget).toMatchObject({ id: "leaf", pos: "into" });
    expect(result.current.springHint).toBeNull();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(result.current.expandedGroups.size).toBe(0);
  });

  it("an already open group is not waited on", () => {
    const { result } = setup(nodes());
    const src = makeRow("src", "node", 0);
    const host = makeRow("host", "group", 100, true);
    layout([[src, 0], [host, 100]]);
    startMouseDrag(result, nodes()[0], src);
    act(() => pointer("pointermove", 10, mid(100)));
    expect(result.current.springHint).toBeNull();
  });

  it("a note held over its own descendant never opens it", () => {
    const ns = [makeNode("top"), makeNode("mid", { parent_id: "top" }), makeNode("deep", { parent_id: "mid" }), makeNode("under", { parent_id: "deep" })];
    const { result } = setup(ns);
    const top = makeRow("top", "group", 0, true);
    const deep = makeRow("deep", "group", 100); // folded, inside top's subtree
    layout([[top, 0], [deep, 100]]);
    startMouseDrag(result, ns[0], top);
    act(() => pointer("pointermove", 10, mid(100)));
    expect(result.current.sbDropTarget).toBeNull();
    expect(result.current.springHint).toBeNull();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(result.current.expandedGroups.has("deep")).toBe(false);
  });

  it("Esc ends the drag and folds back everything opened on the way, several levels deep", () => {
    const ns = [makeNode("src"), makeNode("a"), makeNode("b", { parent_id: "a" }), makeNode("c", { parent_id: "b" })];
    const { result } = setup(ns);
    const src = makeRow("src", "node", 0);
    const a = makeRow("a", "group", 100);
    const b = makeRow("b", "group", 200);
    layout([[src, 0], [a, 100], [b, 200]]);
    startMouseDrag(result, ns[0], src);
    act(() => pointer("pointermove", 10, mid(100)));
    act(() => { vi.advanceTimersByTime(SPRING_OPEN_MS); });
    expect(result.current.expandedGroups.has("a")).toBe(true);
    a.dataset.sbExpanded = "true"; // the list now draws it open; b sits under the pointer
    act(() => pointer("pointermove", 10, mid(200)));
    act(() => { vi.advanceTimersByTime(SPRING_OPEN_MS); });
    expect([...result.current.expandedGroups].sort()).toEqual(["a", "b"]);

    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(result.current.sbDragId).toBeNull();
    expect(result.current.expandedGroups.size).toBe(0);
    expect(getPrefJson(PREFS.expandedGroups)).toEqual([]);
    act(() => pointer("pointerup", 10, mid(200)));
    expect(apiMock.mock.calls.filter(([p]) => p !== "/api/spaces")).toEqual([]);
  });

  it("dropping into the opened group keeps it open and saves it; unrelated openings fold back", async () => {
    const ns = [makeNode("src"), makeNode("a"), makeNode("b", { parent_id: "a" }), makeNode("x"), makeNode("y", { parent_id: "x" })];
    const { result } = setup(ns);
    const src = makeRow("src", "node", 0);
    const x = makeRow("x", "group", 50);
    const a = makeRow("a", "group", 100);
    const b = makeRow("b", "node", 200);
    layout([[src, 0], [x, 50], [a, 100], [b, 200]]);
    startMouseDrag(result, ns[0], src);
    act(() => pointer("pointermove", 10, mid(50)));
    act(() => { vi.advanceTimersByTime(SPRING_OPEN_MS); }); // x opens on the way
    act(() => pointer("pointermove", 10, mid(100)));
    act(() => { vi.advanceTimersByTime(SPRING_OPEN_MS); }); // a opens, and the drop target stays a
    expect(result.current.sbDropTarget).toMatchObject({ id: "a", pos: "into" });
    await act(async () => {
      pointer("pointerup", 10, mid(100));
      await vi.runOnlyPendingTimersAsync();
    });
    expect(apiMock).toHaveBeenCalledWith("/api/nodes/src", expect.objectContaining({ method: "PATCH" }));
    expect([...result.current.expandedGroups]).toEqual(["a"]);
    expect(getPrefJson(PREFS.expandedGroups)).toEqual(["a"]);
  });

  it("a group that was open before the drag stays open after it", () => {
    const { result } = setup(nodes());
    act(() => result.current.toggleGroup("host"));
    const src = makeRow("src", "node", 0);
    layout([[src, 0]]);
    startMouseDrag(result, nodes()[0], src);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(result.current.expandedGroups.has("host")).toBe(true);
  });

  it("the finger waits longer than the mouse, and wobble within one row does not reset it", () => {
    const { result } = setup(nodes());
    const src = makeRow("src", "node", 0);
    const host = makeRow("host", "group", 100);
    layout([[src, 0], [host, 100]]);
    act(() => {
      result.current.onSbPointerDown(
        { button: 0, pointerType: "touch", clientX: 10, clientY: 17, target: src, currentTarget: src, stopPropagation() {} } as unknown as React.PointerEvent,
        nodes()[0], false,
      );
      vi.advanceTimersByTime(350);
    });
    act(() => pointer("pointermove", 10, mid(100), "touch"));
    expect(result.current.springHint).toEqual({ id: "host", ms: SPRING_OPEN_TOUCH_MS });
    act(() => { vi.advanceTimersByTime(500); });
    act(() => pointer("pointermove", 16, mid(100) + 4, "touch"));
    act(() => { vi.advanceTimersByTime(SPRING_OPEN_MS - 500); });
    expect(result.current.expandedGroups.has("host")).toBe(false); // the mouse wait has passed; the finger's not yet
    act(() => { vi.advanceTimersByTime(SPRING_OPEN_TOUCH_MS - SPRING_OPEN_MS + 1); });
    expect(result.current.expandedGroups.has("host")).toBe(true);
  });

  it("unmounting mid-wait leaves no timer behind", () => {
    const { result, unmount } = setup(nodes());
    const src = makeRow("src", "node", 0);
    const host = makeRow("host", "group", 100);
    layout([[src, 0], [host, 100]]);
    startMouseDrag(result, nodes()[0], src);
    act(() => pointer("pointermove", 10, mid(100)));
    expect(result.current.springHint).not.toBeNull();
    unmount();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the list moves under a still pointer (wheel scroll): the row armed before is not opened, the new one waits", () => {
    const ns = [...nodes(), makeNode("other"), makeNode("otherKid", { parent_id: "other" })];
    const { result } = setup(ns);
    const src = makeRow("src", "node", 0);
    const host = makeRow("host", "group", 100);
    const other = makeRow("other", "group", 100); // where it will sit after the scroll
    layout([[src, 0], [host, 100]]);
    startMouseDrag(result, nodes()[0], src);
    act(() => pointer("pointermove", 10, mid(100)));
    act(() => { vi.advanceTimersByTime(400); });
    layout([[src, 0], [other, 100]]); // scrolled: another folded row is under the same point; no pointermove came
    act(() => { vi.advanceTimersByTime(SPRING_OPEN_MS - 400); });
    expect(result.current.expandedGroups.has("host")).toBe(false);
    expect(result.current.springHint?.id).toBe("other");
    act(() => { vi.advanceTimersByTime(SPRING_OPEN_MS); });
    expect(result.current.expandedGroups.has("other")).toBe(true);
  });

  it("a finger drifting into the row's upper quarter keeps the wait running", () => {
    const { result } = setup(nodes());
    const src = makeRow("src", "node", 0);
    const host = makeRow("host", "group", 100);
    layout([[src, 0], [host, 100]]);
    startMouseDrag(result, nodes()[0], src);
    act(() => pointer("pointermove", 10, mid(100)));
    act(() => { vi.advanceTimersByTime(400); });
    act(() => pointer("pointermove", 10, 102)); // the "above" band of the same row
    act(() => { vi.advanceTimersByTime(SPRING_OPEN_MS - 400); });
    expect(result.current.expandedGroups.has("host")).toBe(true);
  });

  it("pointercancel ends the drag and folds back what it opened", () => {
    const { result } = setup(nodes());
    const src = makeRow("src", "node", 0);
    const host = makeRow("host", "group", 100);
    layout([[src, 0], [host, 100]]);
    startMouseDrag(result, nodes()[0], src);
    act(() => pointer("pointermove", 10, mid(100)));
    act(() => { vi.advanceTimersByTime(SPRING_OPEN_MS); });
    expect(result.current.expandedGroups.has("host")).toBe(true);
    act(() => pointer("pointercancel", 10, mid(100)));
    expect(result.current.sbDragId).toBeNull();
    expect(result.current.expandedGroups.size).toBe(0);
    expect(result.current.springHint).toBeNull();
  });

  it("Esc cancels even when the focused editor already handled it", () => {
    const { result } = setup(nodes());
    const src = makeRow("src", "node", 0);
    const host = makeRow("host", "group", 100);
    layout([[src, 0], [host, 100]]);
    const editor = document.createElement("div");
    editor.addEventListener("keydown", (e) => e.preventDefault()); // what a text editor does with Esc
    document.body.appendChild(editor);
    startMouseDrag(result, nodes()[0], src);
    act(() => pointer("pointermove", 10, mid(100)));
    act(() => { vi.advanceTimersByTime(SPRING_OPEN_MS); });
    act(() => { editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(result.current.sbDragId).toBeNull();
    expect(result.current.expandedGroups.size).toBe(0);
  });

  it("a move the server refuses leaves the folders as they were, and nothing is saved open", async () => {
    const { result } = setup(nodes());
    apiMock.mockImplementation((path: unknown, init?: unknown) =>
      (init as { method?: string } | undefined)?.method === "PATCH" ? Promise.reject(new ApiError(403, "forbidden")) : Promise.resolve({}));
    const src = makeRow("src", "node", 0);
    const host = makeRow("host", "group", 100);
    layout([[src, 0], [host, 100]]);
    startMouseDrag(result, nodes()[0], src);
    act(() => pointer("pointermove", 10, mid(100)));
    act(() => { vi.advanceTimersByTime(SPRING_OPEN_MS); });
    await act(async () => {
      pointer("pointerup", 10, mid(100));
      await vi.runOnlyPendingTimersAsync();
    });
    expect(getAppState().data.nodes.find((n) => n.id === "src")?.parent_id ?? null).toBeNull();
    expect(result.current.expandedGroups.has("host")).toBe(false);
    expect(getPrefJson(PREFS.expandedGroups)).toEqual([]);
    expect(result.current.springOpened.size).toBe(0);
  });

  it("opened on the way to another space's note: the drop asks to move; nothing stays open", async () => {
    const space = (id: string, kind: "personal" | "shared"): Space =>
      ({ id, name: id, kind, is_default: false, owner_actor_id: null, capabilities: {}, permission: "edit", can_manage: true }) as Space;
    resetSpacesForTest();
    vi.spyOn(reads.people, "spaces").mockResolvedValue({ spaces: [space("sp-me", "personal"), space("sp-team", "shared")] } as never);
    await refreshSpaces();
    const ns = [makeNode("a", { space_id: "sp-me" }), makeNode("t1", { space_id: "sp-team" }), makeNode("t2", { space_id: "sp-team", parent_id: "t1" })];
    const { result } = setup(ns);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const a = makeRow("a", "node", 0);
    const t1 = makeRow("t1", "group", 100);
    const t2 = makeRow("t2", "node", 200);
    layout([[a, 0], [t1, 100]]);
    startMouseDrag(result, ns[0], a);
    act(() => pointer("pointermove", 10, mid(100)));
    expect(result.current.springHint?.id).toBe("t1");
    act(() => { vi.advanceTimersByTime(SPRING_OPEN_MS); });
    expect(result.current.expandedGroups.has("t1")).toBe(true);
    layout([[a, 0], [t1, 100], [t2, 200]]);
    act(() => pointer("pointermove", 10, mid(200)));
    await act(async () => { pointer("pointerup", 10, mid(200)); await vi.runOnlyPendingTimersAsync(); });
    expect(result.current.sbSpaceMove).toMatchObject({ parentId: "t2", to: { id: "sp-team" } });
    expect(result.current.expandedGroups.has("t1")).toBe(false);
    expect(getPrefJson(PREFS.expandedGroups)).toEqual([]);
  });
});

describe("tag rows", () => {
  const tag = (id: string, parent_id: string | null) => ({ id, name: id, parent_id, color: null, reserved_key: null }) as never;
  function tagRow(id: string, top: number, expanded?: boolean) {
    const el = makeRow(id, "node", top);
    delete el.dataset.sbId;
    el.dataset.sbTagId = id;
    if (expanded !== undefined) el.dataset.sbExpanded = String(expanded);
    return el;
  }

  it("holding a note over a folded tag opens it; dropping on its sub-tag keeps the path open", async () => {
    const ns = [makeNode("src")];
    resetAppState({ data: { ...noWorkspaceData, nodes: ns, tags: [tag("P", null), tag("C", "P")] }, online: true });
    // The kept tags are handed over in one render (the tag list takes them in its effect) and then let go.
    const handedOver: string[][] = [];
    const { result } = renderHook(() => {
      const drag = useSidebarDrag({ nodes: ns, online: true, selectedNodeId: null, selectedNodeParentId: null });
      if (drag.springKept.size > 0) handedOver.push([...drag.springKept]);
      return drag;
    });
    const src = makeRow("src", "node", 0);
    const p = tagRow("P", 100, false);
    const c = tagRow("C", 200);
    layout([[src, 0], [p, 100]]);
    startMouseDrag(result, ns[0], src);
    act(() => pointer("pointermove", 10, mid(100)));
    expect(result.current.springHint).toEqual({ id: "P", ms: SPRING_OPEN_MS });
    act(() => { vi.advanceTimersByTime(SPRING_OPEN_MS); });
    expect(result.current.springOpened.has("P")).toBe(true);
    layout([[src, 0], [p, 100], [c, 200]]);
    act(() => pointer("pointermove", 10, mid(200)));
    await act(async () => { pointer("pointerup", 10, mid(200)); await vi.runOnlyPendingTimersAsync(); });
    expect(apiMock.mock.calls.some(([path]) => String(path).includes("tags") || String(path).includes("src"))).toBe(true);
    expect(handedOver).toEqual([["P"]]);
    expect(result.current.springKept.size).toBe(0); // a tag list mounted later does not reopen it
    expect(result.current.springOpened.size).toBe(0);
    expect(getPrefJson(PREFS.expandedGroups)).toEqual([]); // the tag list keeps its own open set
  });

  it("a tag row that is already open or has no sub-tags is not waited on", () => {
    const ns = [makeNode("src")];
    resetAppState({ data: { ...noWorkspaceData, nodes: ns, tags: [tag("P", null), tag("L", null)] }, online: true });
    const { result } = renderHook(() => useSidebarDrag({ nodes: ns, online: true, selectedNodeId: null, selectedNodeParentId: null }));
    const src = makeRow("src", "node", 0);
    const open = tagRow("P", 100, true);
    const leaf = tagRow("L", 200);
    layout([[src, 0], [open, 100], [leaf, 200]]);
    startMouseDrag(result, ns[0], src);
    act(() => pointer("pointermove", 10, mid(100)));
    expect(result.current.springHint).toBeNull();
    act(() => pointer("pointermove", 10, mid(200)));
    expect(result.current.springHint).toBeNull();
  });
});

