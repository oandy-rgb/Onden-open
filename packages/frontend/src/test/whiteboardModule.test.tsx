import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen, within } from "@testing-library/react";
import ModuleLibrary from "../components/ModuleLibrary";
import { AppNavigation } from "../components/AppTopbar";
import NoteRelations from "../components/NoteRelations";
import ShortcutsCheatsheet from "../components/ShortcutsCheatsheet";
import { useCommandPalette } from "../hooks/useCommandPalette";
import { usePaletteState } from "../hooks/usePaletteState";
import { capabilitiesFor } from "../lib/capabilities";
import { type ContentNode } from "../lib/api";
import { getAppState, resetAppState, setAppState } from "../lib/appStore";
import { workspaceWriter } from "../lib/data/domainWriters";
import { ownerData } from "./ownerData";
import type { CanvasMembership } from "@onden/contract";

// The whiteboard (白板) is always on, like the view modules (docs/architecture/module-library.md,
// 「白板」): no switch and no row in Settings › Features, and a stored module list
// that lacks "canvas" (a workspace that turned it off before) still has every
// whiteboard entry; the boards are never touched.

vi.mock("../lib/auth-client", () => ({ authClient: { useSession: () => ({ data: null }) } }));
vi.mock("../lib/data/domainWriters", async (load) => {
  const actual = await load<typeof import("../lib/data/domainWriters")>();
  return { ...actual, workspaceWriter: { ...actual.workspaceWriter, setModuleImported: vi.fn() } };
});

const note: ContentNode = { id: "n1", title: "Lecture", slug: "lecture", markdown: "", node_type: "content", source_type: "manual" };
// A board exists, so the whiteboard is in use and the nav lists it while it is on.
const board: ContentNode = { id: "c1", title: "Course board", slug: "course-board", markdown: "", node_type: "canvas", source_type: "manual" };
const memberships: CanvasMembership[] = [{ canvas_id: "c1", canvas_title: "Course board", node_id: "n1" }];

function workspace(modules: string[] | null, role: "admin" | "editor" = "admin") {
  resetAppState({
    data: { ...ownerData, actor_role: role, nodes: [note, board], canvas_memberships: memberships,
      workspace: { ...ownerData.workspace, modules } },
    online: true,
  });
}

afterEach(() => { vi.mocked(workspaceWriter.setModuleImported).mockReset(); resetAppState(); });

describe("whiteboard module", () => {
  it("Settings › Features does not list it, and no feature count includes it", () => {
    workspace(["rss"]);
    render(<ModuleLibrary online />);
    expect(screen.queryByRole("button", { name: "Canvas" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Canvas" })).toBeNull();
    expect(document.querySelector('[data-module="canvas"]')).toBeNull();
  });

  it("the top bar never has a whiteboard destination: boards are notes", () => {
    workspace(["rss"]);
    render(<AppNavigation mode="notes" setMode={vi.fn()} onOpenModule={vi.fn()} onOpenFeature={vi.fn()} />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).queryByRole("button", { name: "Canvas" })).toBeNull();
    act(() => setAppState((s) => ({ data: { ...s.data, workspace: { ...s.data.workspace, modules: ["rss", "canvas"] } } })));
    expect(within(nav).queryByRole("button", { name: "Canvas" })).toBeNull();
  });

  it("the palette keeps its board actions and boards whatever the stored list says", () => {
    const options = { setMode: vi.fn(), showTags: vi.fn(), setNotesView: vi.fn(), setSelectedId: vi.fn(), setCreateOpen: vi.fn(),
      setOverviewPane: vi.fn(), refresh: vi.fn(async () => {}), nodes: [], activeCanvasId: null,
      canvases: [{ id: "c1", title: "Course board", created_at: "", updated_at: "" }],
      selectedNode: null, selectCanvas: vi.fn(), capabilities: capabilitiesFor(true, [], false) };
    const ids = (result: { current: ReturnType<typeof useCommandPalette> }) => {
      act(() => result.current.setPaletteOpen(true));
      return result.current.paletteItems.map((item) => item.id);
    };
    for (const modules of [["rss"], ["rss", "canvas"], null]) {
      workspace(modules);
      const hook = renderHook(() => useCommandPalette(options, usePaletteState()));
      expect(ids(hook.result)).toEqual(expect.arrayContaining(["a-new-canvas", "a-tidy-canvas", "a-arrange-tree", "cv-c1"]));
      hook.unmount();
    }
  });

  it("a note's boards show under the note whatever the stored list says", () => {
    const inspector = () => render(<NoteRelations node={note}
      onOpenNote={() => {}} onOpenCanvas={() => {}} />);
    workspace(["canvas"]);
    const { unmount } = inspector();
    expect(screen.getByText("Appears on canvases")).toBeInTheDocument();
    unmount();
    workspace([]);
    inspector();
    expect(screen.getByText("Appears on canvases")).toBeInTheDocument();
    // The membership data is kept.
    expect(getAppState().data.canvas_memberships).toEqual(memberships);
  });

  it("the shortcut list keeps the board shortcut whatever the stored list says", () => {
    workspace([]);
    render(<ShortcutsCheatsheet />);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "?" })); });
    expect(screen.getByText("Toggle inspector")).toBeInTheDocument();
    expect(screen.getByText("Remove selected cards from board")).toBeInTheDocument();
  });

  it("a workspace from before the library (no list) has every module, the whiteboard included", () => {
    workspace(null);
    render(<ShortcutsCheatsheet />);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "?" })); });
    expect(screen.getByText("Remove selected cards from board")).toBeInTheDocument();
  });
});
