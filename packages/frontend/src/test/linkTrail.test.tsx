// The link trail: 「上一頁」 returns to the note a link was followed from,
// 「下一頁」 to the one it returned from; the top bar's pair of buttons and
// Alt+← / Alt+→ drive the same two operations (hooks/useWorkspaceFocus).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { useWorkspaceFocus } from "../hooks/useWorkspaceFocus";
import { destinationOfView, reopenDestination, useUrlSync, type AppView } from "../hooks/useUrlLocation";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import AppTopbar from "../components/AppTopbar";
import type { NodeLens } from "../lib/nodeLens";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { bindAccountStorage } from "../lib/accountStorage";
import { getAppState, resetAppState, setSelectedId, useAppSelector } from "../lib/appStore";
import { clearPageScrollMemory } from "../lib/pageScrollRestore";
import { setLocalePref } from "../lib/i18n";

vi.mock("../lib/localDb", async (original) => ({ ...await original<typeof import("../lib/localDb")>(), getPendingWrites: vi.fn(async () => []) }));
vi.mock("../lib/auth-client", () => ({ authClient: { useSession: () => ({ data: null }), signOut: vi.fn() } }));

const node = (id: string) =>
  ({ id, title: id, node_type: "content", parent_id: null, hidden: false, markdown: "", source_type: "manual", slug: id }) as ContentNode;

function useFocus() {
  const [notesView, setNotesView] = useState<NodeLens>("editor");
  const [viewTab, setViewTab] = useState<string | null>(null);
  const ui = { mode: "notes", setMode: vi.fn(), notesView, setNotesView, viewTab, setViewTab, setOverviewMobileTab: vi.fn() };
  return useWorkspaceFocus({
    ui: ui as never, initialLocation: { nodeId: "a", lens: "editor" },
    boards: { selectCanvas: vi.fn(async () => {}) as never, createCanvas: vi.fn() as never },
    canvasImported: false, setCanvasNavStack: vi.fn(),
  });
}
const selected = () => getAppState().selectedId;

beforeEach(() => {
  localStorage.clear();
  bindAccountStorage("link-trail-test", "");
  setLocalePref("en");
  resetAppState({ online: true, data: { ...noWorkspaceData, nodes: [node("a"), node("b"), node("c")], tags: [] } });
  setSelectedId("a");
});

describe("the link trail", () => {
  it("goes back along followed links and forward again, one note at a time", () => {
    const { result } = renderHook(useFocus);
    expect([result.current.canGoBack, result.current.canGoForward]).toEqual([false, false]);
    act(() => result.current.followLink("b"));
    act(() => result.current.followLink("c"));
    expect(selected()).toBe("c");
    act(() => result.current.goBack());
    expect(selected()).toBe("b");
    expect([result.current.canGoBack, result.current.canGoForward]).toEqual([true, true]);
    act(() => result.current.goBack());
    expect(selected()).toBe("a");
    expect([result.current.canGoBack, result.current.canGoForward]).toEqual([false, true]);
    act(() => result.current.goForward());
    act(() => result.current.goForward());
    expect(selected()).toBe("c");
    expect([result.current.canGoBack, result.current.canGoForward]).toEqual([true, false]);
  });

  it("a new link ends the forward trail, as a new page does in a browser", () => {
    const { result } = renderHook(useFocus);
    act(() => result.current.followLink("b"));
    act(() => result.current.goBack());
    expect(result.current.canGoForward).toBe(true);
    act(() => result.current.followLink("c"));
    expect(result.current.canGoForward).toBe(false);
    act(() => result.current.goForward()); // nothing to go to: stays
    expect(selected()).toBe("c");
  });

  it("opening a note from the sidebar ends the forward trail too, and keeps the way back", () => {
    const { result } = renderHook(useFocus);
    act(() => result.current.followLink("b"));
    act(() => result.current.goBack());
    act(() => result.current.openNote("c"));
    expect(result.current.canGoForward).toBe(false);
    expect(selected()).toBe("c");
  });
});

// The trail is a second copy of the browser history, so it has to leave with it: a Back from a bottom tab's page goes
// to the default screen (the notes list) in one jump over the link's entries, and notes opened from there are not
// steps of the trail that was left behind. Found on a phone: ‹ on a note opened from the list went to another note.
describe("the trail follows the browser history off a bottom tab's page", () => {
  function useTrailShell() {
    const [mode, setMode] = useState<AppView>("notes");
    const [notesView, setNotesView] = useState<NodeLens>("editor");
    const [viewTab, setViewTab] = useState<string | null>(null);
    const ui = { mode, setMode, notesView, setNotesView, viewTab, setViewTab, setOverviewMobileTab: vi.fn() };
    const focus = useWorkspaceFocus({
      ui: ui as never, initialLocation: { nodeId: "a", lens: "editor" },
      boards: { selectCanvas: vi.fn(async () => {}) as never, createCanvas: vi.fn() as never },
      canvasImported: false, setCanvasNavStack: vi.fn(),
    });
    const selectedId = useAppSelector((s) => s.selectedId);
    useUrlSync(mode, selectedId, notesView, setMode, setSelectedId, setNotesView, viewTab, setViewTab, focus.followBrowserStep, null, true);
    return { ...focus, mode, setMode, selectedId };
  }
  const urlNode = () => new URLSearchParams(window.location.search).get("node");
  const flush = () => new Promise((r) => setTimeout(r, 30));

  beforeEach(async () => {
    await flush();
    clearPageScrollMemory();
    window.history.replaceState(null, "", "/?view=notes&node=a");
  });

  it("a note opened from the list after Back from a tab has no way back through the link that was left", async () => {
    const { result } = renderHook(useTrailShell);
    act(() => result.current.followLink("b")); // a → b by a link: the trail holds a
    expect(result.current.canGoBack).toBe(true);
    act(() => { reopenDestination(destinationOfView("tasks"), false); result.current.setMode("tasks"); }); // the tasks tab
    act(() => window.history.back()); // Back from the tab's first page: the notes list, in one jump
    await waitFor(() => expect(result.current.selectedId).toBeNull());
    await flush();
    act(() => result.current.openNote("c")); // opened from the list
    expect(selected()).toBe("c");
    expect(result.current.canGoBack).toBe(false); // ‹ goes to the list (the previous page), never to a
    act(() => result.current.goBack());
    expect(selected()).toBe("c");
    expect(urlNode()).toBe("c");
  });

  it("a link followed after that still goes back to the note it was followed from", async () => {
    const { result } = renderHook(useTrailShell);
    act(() => result.current.followLink("b"));
    act(() => { reopenDestination(destinationOfView("tasks"), false); result.current.setMode("tasks"); });
    act(() => window.history.back());
    await waitFor(() => expect(result.current.selectedId).toBeNull());
    await flush();
    act(() => result.current.openNote("c"));
    act(() => result.current.followLink("a"));
    act(() => window.history.back());
    await waitFor(() => expect(result.current.selectedId).toBe("c"));
    expect(urlNode()).toBe("c");
    expect(result.current.canGoBack).toBe(false);
  });
});

describe("Alt+← / Alt+→", () => {
  function Keys({ history }: { history: Parameters<typeof useKeyboardShortcuts>[0]["history"] }) {
    const noop = () => {};
    useKeyboardShortcuts({
      mode: "notes", notesView: "editor", selectedId: null, setSelectedId: noop,
      createOpen: false, setCreateOpen: noop, createNote: noop, canvasSearch: "", setCanvasSearch: noop,
      onOpenOverviewSearch: noop, setPaletteOpen: noop, setPaletteQuery: noop, setPaletteIndex: noop,
      saveOverviewDraft: noop, setOverviewView: noop, openDailyNote: noop,
      setFocusMode: noop, history,
    });
    return null;
  }
  const trail = () => ({ canGoBack: true, goBack: vi.fn(), canGoForward: true, goForward: vi.fn() });

  it("go back and forward from the page", () => {
    const history = trail();
    render(<Keys history={history} />);
    fireEvent.keyDown(document.body, { key: "ArrowLeft", code: "ArrowLeft", altKey: true });
    fireEvent.keyDown(document.body, { key: "ArrowRight", code: "ArrowRight", altKey: true });
    expect(history.goBack).toHaveBeenCalledTimes(1);
    expect(history.goForward).toHaveBeenCalledTimes(1);
  });

  it("leave the keys alone while typing (the caret moves by word) and while an IME is composing", () => {
    const history = trail();
    render(<><Keys history={history} /><div contentEditable suppressContentEditableWarning data-testid="editor" /><input data-testid="field" /></>);
    for (const id of ["editor", "field"]) {
      const el = screen.getByTestId(id);
      if (id === "editor") Object.defineProperty(el, "isContentEditable", { value: true });
      el.focus();
      fireEvent.keyDown(el, { key: "ArrowLeft", code: "ArrowLeft", altKey: true });
    }
    fireEvent.keyDown(document.body, { key: "ArrowLeft", code: "ArrowLeft", altKey: true, isComposing: true });
    fireEvent.keyDown(document.body, { key: "ArrowLeft", code: "ArrowLeft", altKey: true, keyCode: 229 });
    expect(history.goBack).not.toHaveBeenCalled();
  });

  it("do nothing, and leave the key to the browser, where the trail has nowhere to go", () => {
    const history = { ...trail(), canGoBack: false, canGoForward: false };
    render(<Keys history={history} />);
    const event = new KeyboardEvent("keydown", { key: "ArrowLeft", code: "ArrowLeft", altKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(history.goBack).not.toHaveBeenCalled();
  });
});

describe("the top bar has no 上一頁 / 下一頁 pair: the browser's history takes those steps", () => {
  it("shows neither button, only the wordmark at the left", () => {
    render(<AppTopbar mode="notes" setMode={() => {}} activePanel={null} onOpenModule={() => {}} onOpenFeature={() => {}} onOpenPalette={() => {}}
      onOpenMembers={() => {}} onOpenSettings={() => {}} />);
    expect(screen.queryByRole("button", { name: "Previous page" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
    expect(document.querySelector(".topbar-history, .topbar-nav-back, .topbar-nav-forward")).toBeNull();
    expect(document.querySelector(".app-topbar-left")?.textContent).toBe("Onden");
  });
});

// A link follow is a browser history entry: Back, a mouse side button and Alt+←
// return to the note it was followed from, the same step as the trail's own.
describe("the link trail in the browser history", () => {
  function useTrailWithUrl(startMode = "notes") {
    const [mode, setMode] = useState(startMode);
    const [notesView, setNotesView] = useState<NodeLens>("editor");
    const [viewTab, setViewTab] = useState<string | null>(null);
    const selectedId = useAppSelector((s) => s.selectedId);
    const ui = { mode, setMode, notesView, setNotesView, viewTab, setViewTab, setOverviewMobileTab: vi.fn() };
    const focus = useWorkspaceFocus({
      ui: ui as never, initialLocation: { nodeId: "a", lens: "editor" },
      boards: { selectCanvas: vi.fn(async () => {}) as never, createCanvas: vi.fn() as never },
      canvasImported: false, setCanvasNavStack: vi.fn(),
    });
    useUrlSync(mode, selectedId, notesView, setMode, setSelectedId, setNotesView, viewTab, setViewTab, focus.followBrowserStep);
    return focus;
  }
  const urlNode = () => new URLSearchParams(window.location.search).get("node");

  beforeEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20)); // a traversal of the previous test, still on its way
    window.history.replaceState(null, "", "/?view=notes&node=a&lens=editor");
  });

  it("a followed link adds one entry; opening another note from the sidebar adds one more; the same note adds none", () => {
    const { result } = renderHook(useTrailWithUrl);
    expect(window.history.state).toMatchObject({ ondenDepth: 0 });
    act(() => result.current.followLink("b"));
    expect(urlNode()).toBe("b");
    expect(window.history.state).toMatchObject({ ondenTrail: expect.any(Number) }); // a new entry, made for the link
    const entry = window.history.length;
    act(() => result.current.openNote("c"));
    expect(urlNode()).toBe("c");
    expect(window.history.length).toBe(entry + 1); // a page of its own: Back returns to b
    act(() => result.current.openNote("c"));
    expect(window.history.length).toBe(entry + 1); // the same address is no new page
  });

  it("the browser's Back returns to the note the link came from, and Forward goes on again", async () => {
    const { result } = renderHook(useTrailWithUrl);
    act(() => result.current.followLink("b"));
    act(() => result.current.followLink("c"));
    act(() => window.history.back());
    await waitFor(() => expect(selected()).toBe("b"));
    expect([result.current.canGoBack, result.current.canGoForward]).toEqual([true, true]);
    expect(urlNode()).toBe("b");
    act(() => window.history.back());
    await waitFor(() => expect(selected()).toBe("a"));
    expect([result.current.canGoBack, result.current.canGoForward]).toEqual([false, true]);
    act(() => window.history.forward());
    await waitFor(() => expect(selected()).toBe("b"));
    expect(result.current.canGoBack).toBe(true);
  });

  it("the trail's own goBack / goForward (Alt+←, →, the phone's ‹) take the same steps through the history", async () => {
    const { result } = renderHook(useTrailWithUrl);
    act(() => result.current.followLink("b"));
    act(() => result.current.goBack());
    await waitFor(() => expect(selected()).toBe("a"));
    expect(urlNode()).toBe("a");
    expect(window.history.state).toMatchObject({ ondenDepth: 0 }); // back at the entry before the link's: the browser stepped
    expect([result.current.canGoBack, result.current.canGoForward]).toEqual([false, true]);
    act(() => result.current.goForward());
    await waitFor(() => expect(selected()).toBe("b"));
    expect(urlNode()).toBe("b");
    expect(window.history.state).toMatchObject({ ondenTrail: expect.any(Number) });
    expect(result.current.canGoForward).toBe(false);
  });

  it("a link followed from another page is one history entry: Back returns to that page (and Alt+← agrees)", async () => {
    window.history.replaceState(null, "", "/?view=tasks&node=a");
    const { result } = renderHook(() => useTrailWithUrl("tasks"));
    act(() => result.current.followLink("b")); // an agenda item, from the tasks page
    expect(window.location.search).toContain("view=notes");
    expect(urlNode()).toBe("b");
    expect(window.history.state).toMatchObject({ ondenTrail: expect.any(Number) }); // the link's entry holds the new page; the view change rewrote it
    act(() => window.history.back());
    await waitFor(() => expect(window.location.search).toContain("view=tasks"));
    expect(window.location.search).not.toContain("view=notes");
    expect(selected()).toBe("a");
    act(() => window.history.forward());
    await waitFor(() => expect(selected()).toBe("b"));
    act(() => result.current.goBack()); // Alt+←
    await waitFor(() => expect(window.location.search).toContain("view=tasks"));
    expect(selected()).toBe("a");
  });

  it("a popstate that is no trail step leaves the trail alone (the settings dialog's own history.back())", async () => {
    const { result } = renderHook(useTrailWithUrl);
    act(() => result.current.followLink("b"));
    act(() => result.current.openNote("a")); // the sidebar, back on a: the entry is rewritten, its mark kept
    act(() => window.history.pushState(null, "", window.location.href)); // the dialog opens
    act(() => window.history.back()); // and closes
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(selected()).toBe("a");
    expect([result.current.canGoBack, result.current.canGoForward]).toEqual([true, false]); // the trail still holds a
  });

  it("a trail step made after the page was reloaded (no trail entry to use) still works in state", () => {
    const { result } = renderHook(useTrailWithUrl);
    act(() => result.current.followLink("b"));
    window.history.replaceState(null, "", window.location.href); // the entry's mark is gone
    act(() => result.current.goBack());
    expect(selected()).toBe("a");
  });
});
