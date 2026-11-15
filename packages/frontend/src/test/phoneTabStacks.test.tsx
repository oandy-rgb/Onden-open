// The phone's bottom bar as stacks: the notes list is a page, each tab remembers where it was left, tapping the
// tab on screen goes to its top, and Back from the first page of a tab goes to the notes list, then out of the app
// (hooks/useUrlLocation's header). One history, so the ‹ and the Back key agree (canGoBackInApp).
import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import {
  canGoBackInApp, destinationOfView, forgetLastLocations, landingHistory, navigate, reopenDestination, useUrlSync, type AppView,
} from "../hooks/useUrlLocation";
import { CORE_PAGES } from "../hooks/shellNavigation";
import { useHistoryEntry } from "../hooks/useHistoryEntry";
import type { NodeLens } from "../lib/nodeLens";

function useShell(startView: AppView = "notes", startNode: string | null = null) {
  const [view, setView] = useState<AppView>(startView);
  const [node, setNode] = useState<string | null>(startNode);
  const [lens, setLens] = useState<NodeLens>("editor");
  const [tab, setTab] = useState<string | null>(null);
  useUrlSync(view, node, lens, setView, setNode, setLens, tab, setTab, () => false, null, true);
  const [open, setOpen] = useState(false);
  const entry = useHistoryEntry(open, () => setOpen(false), "ondenArticle");
  return { view, node, setView, setNode, open, setOpen, entry };
}

const flush = () => new Promise((r) => setTimeout(r, 30));
const topOf = (id: string) => CORE_PAGES.find((page) => page.id === id)?.top;
const tap = (view: string, current: boolean) => reopenDestination(destinationOfView(view), current, topOf(view));
type Shell = ReturnType<typeof useShell>;
/** A tap on a bottom tab, the way the nav does it: return to where the tab was left, else open it. */
const openTab = (shell: { current: Shell }, view: string) => act(() => { if (!tap(view, false)) shell.current.setView(view); });
const back = async () => { act(() => window.history.back()); await flush(); };

describe("the phone's tabs are stacks", () => {
  beforeEach(async () => {
    await flush();
    forgetLastLocations();
    window.history.replaceState(null, "", "/?view=notes");
  });

  it("More → Review → Back is the notes list, Back again leaves the app", async () => {
    const { result } = renderHook(() => useShell("notes", null));
    act(() => result.current.setNode("a")); // a note opened from the list
    openTab(result, "review"); // More → Review
    await back();
    await waitFor(() => expect(result.current.view).toBe("notes"));
    expect(result.current.node).toBeNull(); // the list, not the note last opened
    expect(canGoBackInApp()).toBe(false); // the next Back leaves the app
  });

  it("a tab entered from the list: Back is the list", async () => {
    const { result } = renderHook(() => useShell("notes", null));
    openTab(result, "review");
    await back();
    await waitFor(() => expect(result.current.view).toBe("notes"));
    expect(canGoBackInApp()).toBe(false);
  });

  it("a note opened from another page's stack: Back returns to that page (tasks → note → Back = tasks)", async () => {
    const { result } = renderHook(() => useShell("notes", null));
    openTab(result, "tasks");
    act(() => { result.current.setView("notes"); result.current.setNode("t"); }); // the task's note (openNote)
    await back();
    await waitFor(() => expect(result.current.view).toBe("tasks"));
    await back(); // and the tasks page is the start of its stack: now the list
    await waitFor(() => expect(result.current.view).toBe("notes"));
    expect(result.current.node).toBeNull();
    expect(canGoBackInApp()).toBe(false);
  });

  it("notes → graph (opened from the note, not from the bar) → Back is that note", async () => {
    const { result } = renderHook(() => useShell("notes", null));
    act(() => result.current.setNode("a"));
    act(() => result.current.setView("graph"));
    await back();
    await waitFor(() => expect(result.current.view).toBe("notes"));
    expect(result.current.node).toBe("a");
  });

  it("a day's note opened from the journal page: Back is the journal", async () => {
    const { result } = renderHook(() => useShell("notes", null));
    openTab(result, "daily");
    act(() => { result.current.setView("notes"); result.current.setNode("d"); });
    await back();
    await waitFor(() => expect(result.current.view).toBe("daily"));
  });

  it("tapping 筆記 while a note is open shows the list", async () => {
    const { result } = renderHook(() => useShell("notes", null));
    act(() => result.current.setNode("a"));
    let handled = false;
    act(() => { handled = tap("notes", true); });
    expect(handled).toBe(true);
    await waitFor(() => expect(result.current.node).toBeNull());
    expect(window.location.search).not.toContain("node=");
    // on the list already: nothing more happens
    const before = window.history.length;
    act(() => { tap("notes", true); });
    expect(window.history.length).toBe(before);
  });

  it("tapping 筆記 from another tab returns to the note last viewed there", async () => {
    const { result } = renderHook(() => useShell("notes", null));
    act(() => result.current.setNode("a"));
    openTab(result, "daily");
    await waitFor(() => expect(window.location.search).toContain("view=daily"));
    act(() => { tap("notes", false); });
    await waitFor(() => expect(result.current.view).toBe("notes"));
    expect(result.current.node).toBe("a");
    // Back from there is the list again, not the diary the tab was entered from
    await back();
    await waitFor(() => expect(result.current.node).toBeNull());
    expect(result.current.view).toBe("notes");
    expect(canGoBackInApp()).toBe(false);
  });

  it("list → note → Back is the list", async () => {
    const { result } = renderHook(() => useShell("notes", null));
    act(() => result.current.setNode("a"));
    await back();
    await waitFor(() => expect(result.current.node).toBeNull());
  });

  it("inside a tab Back is still the previous page (note → note)", async () => {
    const { result } = renderHook(() => useShell("notes", null));
    act(() => result.current.setNode("a"));
    act(() => result.current.setNode("b"));
    await back();
    await waitFor(() => expect(result.current.node).toBe("a"));
  });

  it("tapping the tab on screen closes its detail screen (reader article → list); the entry is not left behind", async () => {
    const { result } = renderHook(() => useShell("notes", null));
    act(() => result.current.setView("rss"));
    act(() => result.current.setOpen(true));
    const depth = () => (window.history.state as { ondenDepth?: number }).ondenDepth;
    expect(depth()).toBe(2);
    act(() => { tap("rss", true); });
    await waitFor(() => expect(result.current.open).toBe(false));
    expect(depth()).toBe(1);
    // and at the list of the tab, tapping again does nothing
    act(() => { tap("rss", true); });
    await flush();
    expect(depth()).toBe(1);
  });

  it("tapping the graph again goes to its top (no centre), not out of it", async () => {
    const { result } = renderHook(() => useShell("notes", null));
    openTab(result, "graph");
    expect(tap("graph", true)).toBe(true); // already at its top: nothing more
  });

  it("a tab never opened has no place to return to: the caller opens it as before", () => {
    renderHook(() => useShell("notes", null));
    expect(tap("tasks", false)).toBe(false);
  });
});

describe("the app's own first move (the launch setting) on a phone started from the address '/'", () => {
  beforeEach(async () => {
    await flush();
    forgetLastLocations();
    window.history.replaceState(null, "", "/?view=notes"); // the PWA's start_url: the list
  });

  for (const [name, resume] of [["今天／首頁", false], ["上次離開的地方", true]] as const) {
    it(`${name}: the landing note sits above the list, so Back is the list and the list is the bottom`, async () => {
      const { result } = renderHook(() => useShell("notes", null));
      act(() => navigate(() => result.current.setNode("landing"), { history: landingHistory(resume) }));
      expect(window.location.search).toContain("node=landing");
      expect(canGoBackInApp()).toBe(true);
      // More → Review → Back is the list, not the landing note
      openTab(result, "review");
      await back();
      await waitFor(() => expect(result.current.view).toBe("notes"));
      expect(result.current.node).toBeNull();
      expect(canGoBackInApp()).toBe(false);
    });
  }

  it("the list is the notes stack's bottom: from the landing note, 筆記 → list, Back is the landing note again", async () => {
    const { result } = renderHook(() => useShell("notes", null));
    act(() => navigate(() => result.current.setNode("landing"), { history: landingHistory(false) }));
    act(() => { tap("notes", true); });
    await waitFor(() => expect(result.current.node).toBeNull());
    await back();
    await waitFor(() => expect(result.current.node).toBe("landing"));
    await back();
    await waitFor(() => expect(result.current.node).toBeNull());
    expect(canGoBackInApp()).toBe(false);
  });
});
