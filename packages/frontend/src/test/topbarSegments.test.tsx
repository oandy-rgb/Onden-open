// The desktop top bar's three segments (the same on every page, never moved by
// a dragged column), the
// switch that folds the notes list on its own, and the ways to fold a column:
// the chord, the palette and a drag past the minimum width.
// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import AppTopbar from "../components/AppTopbar";
import PaneResizer from "../components/ui/PaneResizer";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { useCommandPalette } from "../hooks/useCommandPalette";
import { usePaletteState } from "../hooks/usePaletteState";
import { useWorkspacePanes } from "../hooks/useWorkspacePanes";
import { capabilitiesFor } from "../lib/capabilities";
import { noWorkspaceData } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { PREFS, getPref } from "../lib/prefs";
import { COLLAPSE_DRAG_OVERSHOOT, setPaneWidth, usePaneWidthVars } from "../lib/paneWidths";
import { SHORTCUTS } from "../lib/shortcuts";

vi.mock("../lib/auth-client", () => ({ authClient: { useSession: () => ({ data: null }), signOut: vi.fn() } }));
vi.mock("../lib/localDb", () => ({ getPendingWrites: vi.fn(async () => []) }));

const css = (path: string) => readFileSync(path, "utf8");

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  act(() => { window.dispatchEvent(new Event("resize")); });
}

beforeEach(() => { localStorage.clear(); setViewport(1920); act(() => { setPaneWidth("sidebar", null); setPaneWidth("inspector", null); }); resetAppState({ data: { ...noWorkspaceData }, online: true }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("the bar's three segments", () => {
  const bar = (props: Partial<Parameters<typeof AppTopbar>[0]> = {}) => render(
    <AppTopbar mode="notes" setMode={() => {}} onOpenModule={() => {}} onOpenFeature={() => {}} onOpenPalette={() => {}}
      onOpenMembers={() => {}} onOpenSettings={() => {}} {...props} />).container.querySelector<HTMLElement>(".app-topbar")!;

  it("holds the wordmark, the destinations with search, and the switch with the avatar, in that order", () => {
    const header = bar({ sidebarToggle: { pressed: true, onToggle: () => {} }, inspectorToggle: { pressed: true, onToggle: () => {} } });
    expect([...header.children].map((el) => el.className.split(" ")[0])).toEqual(["app-topbar-left", "app-topbar-center", "app-topbar-right"]);
    expect(header.querySelector(".app-topbar-left")?.textContent).toBe("Onden");
    const center = header.querySelector(".app-topbar-center")!;
    expect(center.querySelector(".app-primary-nav")).not.toBeNull();
    expect(center.lastElementChild).toBe(center.querySelector(".palette-trigger"));
    expect(header.querySelector(".app-topbar-right .topbar-pane-switch")).not.toBeNull();
  });

  it("is the same on every page and never follows a dragged column", () => {
    for (const mode of ["notes", "tasks"] as const) {
      expect(bar({ mode }).className).toBe("ui-layer app-topbar");
      cleanup();
    }
    const topbar = css("src/components/AppTopbar.css");
    expect(topbar).toContain("grid-template-columns: auto minmax(0, 1fr) auto;");
    expect(topbar).not.toMatch(/--onden-(sidebar|inspector)-width/);
    // The columns below keep their own (draggable) widths.
    for (const file of ["src/styles/global.css", "src/components/ObsidianImport.css"]) {
      expect(css(file)).toContain("var(--onden-sidebar-track, var(--onden-sidebar-width, 240px))");
    }
  });

  it("a folded list gives its grid column 0 on every page that has one", () => {
    const global = css("src/styles/global.css");
    expect(global).toMatch(/\.workspace-grid\.sidebar-collapsed,\s*\.obsidian-workspace\.sidebar-collapsed \{ --onden-sidebar-track: 0px; \}/);
  });
});

describe("the chord and the palette", () => {
  it("Ctrl+Shift+B folds and opens the notes list alone", () => {
    const toggleSidebar = vi.fn();
    const setFocusMode = vi.fn();
    const noop = () => {};
    function Keys() {
      useKeyboardShortcuts({
        mode: "notes", notesView: "editor", selectedId: null, setSelectedId: noop,
        createOpen: false, setCreateOpen: noop, createNote: noop, canvasSearch: "", setCanvasSearch: noop,
        onOpenOverviewSearch: noop, setPaletteOpen: noop, setPaletteQuery: noop, setPaletteIndex: noop,
        saveOverviewDraft: noop, setOverviewView: noop, openDailyNote: noop,
        toggleSidebar, setFocusMode,
      });
      return null;
    }
    render(<Keys />);
    fireEvent.keyDown(document.body, { key: "B", code: "KeyB", ctrlKey: true, shiftKey: true });
    expect(toggleSidebar).toHaveBeenCalledTimes(1);
    expect(setFocusMode).not.toHaveBeenCalled();
    expect(SHORTCUTS.find((s) => s.id === "toggle-sidebar")?.chord).toBe("$mod+shift+b");
  });

  it("Ctrl+. is the same switch as the palette and the top bar (toggleInspector), not a state flip of its own", () => {
    const toggleInspector = vi.fn();
    const noop = () => {};
    function Keys() {
      useKeyboardShortcuts({
        mode: "notes", notesView: "editor", selectedId: null, setSelectedId: noop,
        createOpen: false, setCreateOpen: noop, createNote: noop, canvasSearch: "", setCanvasSearch: noop,
        onOpenOverviewSearch: noop, setPaletteOpen: noop, setPaletteQuery: noop, setPaletteIndex: noop,
        saveOverviewDraft: noop, setOverviewView: noop, openDailyNote: noop,
        toggleInspector, setFocusMode: noop,
      });
      return null;
    }
    render(<Keys />);
    fireEvent.keyDown(document.body, { key: ".", code: "Period", ctrlKey: true });
    expect(toggleInspector).toHaveBeenCalledTimes(1);
  });

  it("finds the three switches and Settings in the palette, each running its own action", async () => {
    const calls = { toggleSidebar: vi.fn(), toggleInspector: vi.fn(), toggleFocusMode: vi.fn(), openSettings: vi.fn() };
    const { result } = renderHook(() => useCommandPalette({
      setMode: vi.fn(), showTags: vi.fn(), setNotesView: vi.fn(), setSelectedId: vi.fn(), setCreateOpen: vi.fn(),
      setOverviewPane: vi.fn(), refresh: vi.fn(async () => {}), nodes: [], canvases: [], activeCanvasId: null,
      selectedNode: null, selectCanvas: vi.fn(), capabilities: capabilitiesFor(true, [], false), ...calls,
    }, usePaletteState()));
    act(() => result.current.setPaletteOpen(true));
    const ids = result.current.paletteItems.map((item) => item.id);
    for (const id of ["a-toggle-sidebar", "a-toggle-inspector", "a-toggle-focus", "a-settings"]) expect(ids).toContain(id);
    const run = async (id: string) => { act(() => result.current.setPaletteOpen(true)); await act(async () => { await result.current.runPaletteItem(result.current.paletteItems.find((item) => item.id === id)!); }); };
    await run("a-toggle-sidebar"); await run("a-toggle-inspector"); await run("a-toggle-focus"); await run("a-settings");
    for (const call of Object.values(calls)) expect(call).toHaveBeenCalledTimes(1);
  });
});

describe("a drag past the minimum width folds the pane", () => {
  function Page() {
    const panes = useWorkspacePanes("notes");
    usePaneWidthVars({ sidebar: panes.sidebarVisible, inspector: panes.inspectorVisible });
    return <>
      <aside><PaneResizer side="sidebar" /></aside>
      <aside><PaneResizer side="inspector" /></aside>
      <output data-testid="state" data-sidebar={panes.sidebarVisible} data-inspector={panes.inspectorVisible} />
    </>;
  }
  const state = () => {
    const el = screen.getByTestId("state");
    return { sidebar: el.dataset.sidebar === "true", inspector: el.dataset.inspector === "true" };
  };
  const sidebar = () => screen.getByRole("separator", { name: /sidebar/i });
  const inspector = () => screen.getByRole("separator", { name: /info pane/i });
  const drag = (el: HTMLElement, from: number, to: number, release = true) => {
    fireEvent.pointerDown(el, { clientX: from, pointerId: 1, button: 0 });
    fireEvent.pointerMove(el, { clientX: to, pointerId: 1 });
    if (release) fireEvent.pointerUp(el, { pointerId: 1 });
  };

  it("folds the list when released more than the overshoot below the minimum, and keeps the stored width", () => {
    act(() => setPaneWidth("sidebar", 300));
    render(<Page />);
    drag(sidebar(), 300, 180 - COLLAPSE_DRAG_OVERSHOOT - 1);
    expect(state()).toEqual({ sidebar: false, inspector: true });
    expect(getPref(PREFS.sidebarWidth)).toBe("300");
    expect(getPref(PREFS.sidebarCollapsed)).toBe("1");
  });

  it("a drag that stops short of the overshoot only narrows the list to its minimum", () => {
    render(<Page />);
    drag(sidebar(), 240, 180 - COLLAPSE_DRAG_OVERSHOOT + 1);
    expect(state().sidebar).toBe(true);
    expect(getPref(PREFS.sidebarWidth)).toBe("180");
  });

  it("shows it will fold while the handle is past the line, and not after coming back", () => {
    render(<Page />);
    const el = sidebar();
    drag(el, 240, 100, false);
    expect(el).toHaveAttribute("data-collapsing");
    fireEvent.pointerMove(el, { clientX: 200, pointerId: 1 });
    expect(el).not.toHaveAttribute("data-collapsing");
    fireEvent.pointerUp(el, { pointerId: 1 });
    expect(state().sidebar).toBe(true);
  });

  it("a cancelled drag folds nothing", () => {
    render(<Page />);
    const el = sidebar();
    drag(el, 240, 0, false);
    fireEvent.pointerCancel(el, { pointerId: 1 });
    expect(state()).toEqual({ sidebar: true, inspector: true });
  });

  it("folds the info pane the same way, from its left edge, and opening it again restores the default width", () => {
    render(<Page />);
    drag(inspector(), 1500, 1500 + 240 - 300 + 240 - COLLAPSE_DRAG_OVERSHOOT + 100);
    expect(state()).toEqual({ sidebar: true, inspector: false });
    expect(getPref(PREFS.inspectorWidth)).toBeNull();
  });

  it("a width the person had before the drag comes back when the pane opens", () => {
    act(() => setPaneWidth("sidebar", 420));
    render(<Page />);
    drag(sidebar(), 420, 0);
    expect(getPref(PREFS.sidebarWidth)).toBe("420");
  });
});
