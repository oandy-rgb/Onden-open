import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import SidebarTagTree from "../components/SidebarTagTree";
import { type Tag } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { bindAccountStorage } from "../lib/accountStorage";
import { sidebarTagsStore } from "../lib/sidebarTagsStore";
import { ownerData } from "./ownerData";

// Phone: hold a tag row → it lifts; move → it drags onto another tag (the move confirm);
// let go in place → its menu. Same gesture as the note rows (useSidebarDrag.test).

vi.mock("../lib/localDb", () => ({ searchNodes: vi.fn(async () => []) }));

const tag = (id: string, name: string, over: Partial<Tag> = {}): Tag => ({ id, name, color: "", schema_id: null, ...over });
const PROJ = tag("t-proj", "proj");
const DRAFT = tag("t-draft", "draft", { parent_id: "t-proj" });
const SOLO = tag("t-solo", "solo");
const rename = { nodeId: null, setNodeId: vi.fn(), draft: "", setDraft: vi.fn() } as never;

function pointer(type: string, x: number, y: number, target: EventTarget = window) {
  act(() => {
    target.dispatchEvent(new PointerEvent(type, {
      pointerType: "touch", isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y, bubbles: true, cancelable: true,
    }));
  });
}
const rowOf = (name: string) => screen.getByRole("button", { name: `Open #${name}` }).closest("li") as HTMLLIElement;
const pressOf = (name: string) => screen.getByRole("button", { name: `Open #${name}` });

// jsdom has no layout: the point (x, 0) is over the row registered for x.
const rowsAtX = new Map<number, HTMLElement>();
function placeRows() {
  rowsAtX.clear();
  ["proj", "draft", "solo"].forEach((name, i) => rowsAtX.set(100 * (i + 1), rowOf(name)));
}
const originalMatchMedia = window.matchMedia;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (h: number) => clearTimeout(h));
  localStorage.clear();
  bindAccountStorage("unit-test-account", "");
  sidebarTagsStore.save(null);
  window.matchMedia = vi.fn((query: string) => ({
    matches: query.includes("max-width: 900px"), media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  document.elementFromPoint = (x: number) => rowsAtX.get(x) ?? null;
  navigator.vibrate = vi.fn(() => true);
  resetAppState({ data: { ...ownerData, actor_is_owner: true, nodes: [], tags: [PROJ, DRAFT, SOLO] }, online: true });
  render(<SidebarTagTree nav={{ openTag: vi.fn() }} rename={rename} />);
  // The sub-tag row is folded under its parent: open it.
  act(() => { fireEvent.click(screen.getByRole("button", { name: /Show sub-tags of #proj/ })); });
  placeRows();
});
afterEach(() => {
  // Let pending timers run out (a swallowed-click guard must not leak into the next test).
  act(() => { vi.runOnlyPendingTimers(); });
  vi.useRealTimers(); vi.unstubAllGlobals(); window.matchMedia = originalMatchMedia; resetAppState(); localStorage.clear();
});


describe("holding a tag row on the phone", () => {
  it("lifts the row with a short vibration", () => {
    fireEvent.pointerDown(pressOf("solo"), { pointerType: "touch", button: 0, clientX: 300, clientY: 0 });
    act(() => { vi.advanceTimersByTime(320); });
    expect(navigator.vibrate).toHaveBeenCalledWith(10);
    expect(rowOf("solo").className).toContain("sb-dragging");
    pointer("pointerup", 300, 0);
  });

  it("moved onto an allowed tag: highlights it and opens the move confirm on release", async () => {
    fireEvent.pointerDown(pressOf("solo"), { pointerType: "touch", button: 0, clientX: 300, clientY: 0 });
    act(() => { vi.advanceTimersByTime(320); });
    pointer("pointermove", 100, 0);
    expect(rowOf("proj").hasAttribute("data-tag-drop")).toBe(true);
    pointer("pointerup", 100, 0);
    expect(rowOf("proj").hasAttribute("data-tag-drop")).toBe(false);
    // The confirm's code loads when it first shows (components/lateShell.ts).
    await act(async () => { await import("../components/TagMoveConfirm"); });
    expect(screen.getByRole("alertdialog", { name: "Move #solo" })).toBeTruthy();
  });

  it("moved onto its own descendant: no highlight, nothing opens", () => {
    fireEvent.pointerDown(pressOf("proj"), { pointerType: "touch", button: 0, clientX: 100, clientY: 0 });
    act(() => { vi.advanceTimersByTime(320); });
    pointer("pointermove", 200, 0);
    expect(rowOf("draft").hasAttribute("data-tag-drop")).toBe(false);
    pointer("pointerup", 200, 0);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(rowOf("proj").className).not.toContain("sb-dragging");
  });

  it("let go in place: opens the menu and moves nothing", () => {
    fireEvent.pointerDown(pressOf("solo"), { pointerType: "touch", button: 0, clientX: 300, clientY: 0 });
    act(() => { vi.advanceTimersByTime(320); });
    pointer("pointermove", 303, 0);
    pointer("pointerup", 303, 0);
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("the touch's own click after letting go does not pick the menu's first item", () => {
    fireEvent.pointerDown(pressOf("solo"), { pointerType: "touch", button: 0, clientX: 300, clientY: 0 });
    act(() => { vi.advanceTimersByTime(320); });
    pointer("pointerup", 300, 0);
    // The browser's click lands where the finger was: on the menu that just opened there.
    const first = within(screen.getByRole("menu")).getAllByRole("menuitem")[0];
    fireEvent.click(first);
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(rowOf("solo").dataset.pinned).toBeUndefined();
    // A real tap a moment later works.
    act(() => { vi.advanceTimersByTime(600); });
    fireEvent.click(within(screen.getByRole("menu")).getAllByRole("menuitem")[0]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("swallows the browser's own contextmenu during the touch press", () => {
    fireEvent.pointerDown(pressOf("solo"), { pointerType: "touch", button: 0, clientX: 300, clientY: 0 });
    act(() => { vi.advanceTimersByTime(320); });
    const notPrevented = fireEvent.contextMenu(pressOf("solo"));
    expect(notPrevented).toBe(false);
    expect(screen.queryByRole("menu")).toBeNull();
    pointer("pointerup", 300, 0);
  });
});
