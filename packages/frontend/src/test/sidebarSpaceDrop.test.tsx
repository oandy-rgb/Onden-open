// Dragging a note in the sidebar onto another space asks first (MoveToSpaceConfirm), then moves it
// (moveToSpace): mouse and touch hold alike. Dropping inside the note's own space stays a reparent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../lib/localDb", () => ({ searchNodes: vi.fn(async () => []), getPendingWrites: vi.fn(async () => []), upsertNode: vi.fn(async () => {}), removeNode: vi.fn(async () => {}), addPendingWrite: vi.fn(async () => {}) }));
vi.mock("../components/SidebarTagTree", () => ({ default: () => null }));
const moved = vi.hoisted(() => vi.fn(async () => ({ moved: 1 })));
vi.mock("../lib/moveToSpace", () => ({ moveToSpace: moved }));

import WorkspaceSidebar from "../components/workspace/WorkspaceSidebar";
import { useSidebarDrag } from "../hooks/useSidebarDrag";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { noteStructure, reads } from "../lib/data";
import { setLocalePref } from "../lib/i18n";
import { refreshSpaces, resetSpacesForTest, spaceApi, type MovePreviewNumericEpoch, type Space } from "../lib/spaces";

const space = (id: string, name: string, over: Partial<Space> = {}): Space => ({
  id, name, kind: "shared", is_default: false, owner_actor_id: null, capabilities: {}, permission: "edit", can_manage: false, ...over,
});
const ME = space("sp-me", "me", { kind: "personal", can_manage: true });
const TEAM = space("sp-team", "Team");
const READ = space("sp-read", "Reading", { permission: "view" });
const note = (id: string, space_id: string, parent_id: string | null = null): ContentNode =>
  ({ id, title: id, slug: id, markdown: "", node_type: "content", source_type: "manual", parent_id, space_id }) as ContentNode;
const NODES = [note("a", "sp-me"), note("a2", "sp-me"), note("t1", "sp-team"), note("t2", "sp-team", "t1"), note("r1", "sp-read")];

const preview: MovePreviewNumericEpoch = {
  node_id: "a", from: { id: "sp-me", name: "me", kind: "personal" }, to: { id: "sp-team", name: "Team", kind: "shared" },
  notes: 1, gain: [{ id: "ann", name: "Ann", type: "human" }], lose: [], membership_epoch: 3,
};

function Harness() {
  const drag = useSidebarDrag({ nodes: NODES, online: true, selectedNodeId: null, selectedNodeParentId: null });
  return (
    <WorkspaceSidebar drag={drag}
      rename={{ renamingNodeId: null, setRenamingNodeId: () => {}, renameDraft: "", setRenameDraft: () => {} }}
      lifecycle={{ renameNode: async () => true, openCtxMenu: () => {} } as never} creation={{ create: async () => null } as never}
      nav={{ openNote: () => {}, openTag: () => {} }} onCreateTag={async () => {}} />
  );
}

const rect = (r: { top: number; height: number }) => ({ top: r.top, bottom: r.top + r.height, left: 0, right: 200, height: r.height, width: 200, x: 0, y: r.top, toJSON() {} }) as DOMRect;
function over(el: Element, top = 0) { el.getBoundingClientRect = () => rect({ top, height: 34 }); }
const select = (id: string) => document.querySelector<HTMLElement>(`[data-sb-id="${id}"]`)!;
const heading = (spaceId: string) => document.querySelector<HTMLElement>(`[data-sb-space-id="${spaceId}"]`)!;
const pointer = (type: string, x: number, y: number, pointerType: string) =>
  window.dispatchEvent(new PointerEvent(type, { pointerType, isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y, bubbles: true, cancelable: true }));

/** Presses `from`, drags over `hit` and lets go there (a mouse past a few px, or a touch held then moved). */
async function drag(from: HTMLElement, hit: Element | null, pointerType: "mouse" | "touch") {
  document.elementFromPoint = (() => hit) as typeof document.elementFromPoint;
  over(from, 0);
  if (hit) { over(hit, 100); const header = hit.querySelector(".obsidian-group-header"); if (header) over(header, 100); }
  from.dispatchEvent(new PointerEvent("pointerdown", { pointerType, isPrimary: true, button: 0, buttons: 1, clientX: 10, clientY: 17, bubbles: true }));
  if (pointerType === "touch") await act(async () => { vi.advanceTimersByTime(350); });
  await act(async () => { pointer("pointermove", 10, 120, pointerType); });
  await act(async () => { pointer("pointerup", 10, 120, pointerType); await vi.runOnlyPendingTimersAsync(); });
}

async function setup(spaces: Space[]) {
  resetSpacesForTest();
  vi.spyOn(reads.people, "spaces").mockResolvedValue({ spaces } as never);
  await refreshSpaces();
  resetAppState({ data: { ...noWorkspaceData, nodes: NODES }, online: true });
  render(<Harness />);
  for (const n of NODES) if (select(n.id)) over(select(n.id), 100);
}

beforeEach(() => {
  setLocalePref("en");
  Element.prototype.scrollIntoView = vi.fn();
  moved.mockClear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (h: number) => clearTimeout(h));
  vi.spyOn(spaceApi, "previewMove").mockResolvedValue(preview);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); resetSpacesForTest(); });

describe.each(["mouse", "touch"] as const)("a note dropped on another space (%s)", (pointerType) => {
  it("drops on a space heading: asks first, moves only on 「Move」", async () => {
    await setup([ME, TEAM]);
    await drag(select("a"), heading("sp-team"), pointerType);
    expect(moved).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Team");
    await waitFor(() => expect(dialog).toHaveTextContent("Will be able to see it: Ann"));
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole("button", { name: "Move" }));
    expect(moved).toHaveBeenCalledExactlyOnceWith("a", "sp-team", preview);
  });

  it("cancel changes nothing", async () => {
    await setup([ME, TEAM]);
    await drag(select("a"), heading("sp-team"), pointerType);
    await screen.findByRole("dialog");
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole("button", { name: "Cancel" }));
    expect(moved).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("dropped into a note of the other space: moves, then places it under that note", async () => {
    await setup([ME, TEAM]);
    const appendChild = vi.spyOn(noteStructure, "appendChild").mockResolvedValue(undefined as never);
    await drag(select("a"), select("t1"), pointerType); // y=120 is the middle of the row at top 100: "into"
    await screen.findByRole("dialog");
    await waitFor(() => expect(screen.getByRole("button", { name: "Move" })).toBeEnabled());
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole("button", { name: "Move" }));
    expect(moved).toHaveBeenCalledExactlyOnceWith("a", "sp-team", preview);
    await waitFor(() => expect(appendChild).toHaveBeenCalledExactlyOnceWith("t1", "a"));
  });

  it("a space this person can only read takes no drop", async () => {
    await setup([ME, READ]);
    await drag(select("a"), heading("sp-read"), pointerType);
    expect(screen.queryByRole("dialog")).toBeNull();
    await drag(select("a"), select("r1"), pointerType);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(moved).not.toHaveBeenCalled();
  });
});

describe("within one space", () => {
  it("dropping on a note of the same space still just reparents", async () => {
    await setup([ME, TEAM]);
    const appendChild = vi.spyOn(noteStructure, "appendChild").mockResolvedValue(undefined as never);
    await drag(select("a"), select("a2"), "mouse");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(appendChild).toHaveBeenCalledExactlyOnceWith("a2", "a");
  });

  it("dropping on its own space's heading does nothing", async () => {
    await setup([ME, TEAM]);
    await drag(select("a"), heading("sp-me"), "mouse");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
