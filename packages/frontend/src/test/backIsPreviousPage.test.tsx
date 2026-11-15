// Back is "the page I was on before": which actions leave a history entry, the phone's default screen
// under the first page, no duplicate entries, and detail screens (hooks/useUrlLocation's table).
import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import {
  canGoBackInApp, goBackInApp, historyKindFor, navigate, useUrlSync, type AppView,
} from "../hooks/useUrlLocation";
import { useHistoryEntry } from "../hooks/useHistoryEntry";
import type { NodeLens } from "../lib/nodeLens";

const none = { fresh: false, intent: null, viewChanged: false, nodeChanged: false, hasNode: true } as const;

describe("historyKindFor (the table at the top of useUrlLocation)", () => {
  it("a place switch or another note is a page; lens/tab, clearing the selection and automatic moves are not", () => {
    expect(historyKindFor({ ...none, viewChanged: true })).toBe("push");
    expect(historyKindFor({ ...none, nodeChanged: true })).toBe("push");
    expect(historyKindFor(none)).toBe("replace"); // lens / tab / filter only
    expect(historyKindFor({ ...none, nodeChanged: true, hasNode: false })).toBe("replace");
    expect(historyKindFor({ ...none, nodeChanged: true, intent: "replace" })).toBe("replace");
    expect(historyKindFor({ ...none, intent: "push", nodeChanged: true })).toBe("push");
  });
  it("a link follow already opened its entry: one follow is one entry", () => {
    expect(historyKindFor({ ...none, fresh: true, viewChanged: true, nodeChanged: true, intent: "push" })).toBe("replace");
  });
});

function useLocationHarness(seed = false, startView: AppView = "notes", startNode: string | null = null) {
  const [view, setView] = useState<AppView>(startView);
  const [node, setNode] = useState<string | null>(startNode);
  const [lens, setLens] = useState<NodeLens>("editor");
  const [tab, setTab] = useState<string | null>(null);
  useUrlSync(view, node, lens, setView, setNode, setLens, tab, setTab, () => false, null, seed);
  return { view, node, lens, setView, setNode, setLens };
}

const urlNode = () => new URLSearchParams(window.location.search).get("node");
// How many pages deep the app is (jsdom trims history.length after a Back, so count our own mark).
const depth = () => (window.history.state as { ondenDepth?: number } | null)?.ondenDepth;
const flush = () => new Promise((r) => setTimeout(r, 30));

describe("what leaves a history entry", () => {
  beforeEach(async () => {
    await flush();
    window.history.replaceState(null, "", "/?view=notes");
  });

  it("opening notes pushes one entry each; the same note again, a tab switch and an automatic move add none", () => {
    const { result } = renderHook(() => useLocationHarness());
    expect(depth()).toBe(0);
    act(() => result.current.setNode("a"));
    act(() => result.current.setNode("b"));
    expect(depth()).toBe(2);
    act(() => result.current.setNode("b"));
    act(() => result.current.setLens("canvas"));
    expect(depth()).toBe(2);
    expect(window.location.search).toContain("lens=canvas");
    act(() => navigate(() => result.current.setNode("c"), { history: "replace" })); // deleted → neighbour
    expect(urlNode()).toBe("c");
    expect(depth()).toBe(2);
    act(() => result.current.setNode(null)); // selection cleared
    expect(depth()).toBe(2);
  });

  it("Back after three opened notes walks them in reverse, then leaves the first", async () => {
    const { result } = renderHook(() => useLocationHarness());
    act(() => result.current.setNode("a"));
    act(() => result.current.setNode("b"));
    act(() => result.current.setNode("c"));
    for (const expected of ["b", "a", null]) {
      act(() => window.history.back());
      await waitFor(() => expect(result.current.node).toBe(expected));
      expect(urlNode()).toBe(expected);
    }
  });

  it("a place switch is a page, and Back returns to the place and note it left", async () => {
    const { result } = renderHook(() => useLocationHarness());
    act(() => result.current.setNode("a"));
    act(() => result.current.setView("tasks"));
    expect(window.location.search).toContain("view=tasks");
    act(() => window.history.back());
    await waitFor(() => expect(result.current.view).toBe("notes"));
    expect(result.current.node).toBe("a");
  });
});

describe("the default screen under the first page (phone)", () => {
  beforeEach(async () => {
    await flush();
    window.history.replaceState(null, "", "/?view=notes&node=a&lens=editor");
  });

  it("a page entered with nothing in-app behind it gets the notes list under it: Back goes page → list", async () => {
    const { result } = renderHook(() => useLocationHarness(true, "notes", "a"));
    expect(canGoBackInApp()).toBe(true);
    act(() => window.history.back());
    await waitFor(() => expect(result.current.node).toBeNull());
    expect(window.location.search).toContain("view=notes");
    expect(canGoBackInApp()).toBe(false); // the list is the bottom: Back from here leaves the app
  });

  it("the ‹ agrees: a previous page when there is one, else the default screen in place", () => {
    const { result } = renderHook(() => useLocationHarness(true, "notes", "a"));
    let defaulted = 0;
    act(() => result.current.setNode("b"));
    expect(canGoBackInApp()).toBe(true);
    goBackInApp(() => { defaulted += 1; });
    expect(defaulted).toBe(0); // history.back() took it
    return flush().then(() => {
      expect(urlNode()).toBe("a");
      act(() => window.history.back());
      return flush();
    }).then(() => {
      goBackInApp(() => { defaulted += 1; });
      expect(defaulted).toBe(1);
    });
  });

  it("the list itself needs no extra entry, and a reload (state already marked) seeds nothing again", () => {
    window.history.replaceState(null, "", "/?view=notes");
    const start = window.history.length;
    renderHook(() => useLocationHarness(true));
    expect(window.history.length).toBe(start);
    window.history.replaceState({ ondenDepth: 1 }, "", "/?view=notes&node=a&lens=editor");
    renderHook(() => useLocationHarness(true, "notes", "a"));
    expect(window.history.length).toBe(start);
  });

  it("the desktop adds no entry of its own", () => {
    const start = window.history.length;
    renderHook(() => useLocationHarness(false, "notes", "a"));
    expect(window.history.length).toBe(start);
    expect(canGoBackInApp()).toBe(false);
  });
});

describe("a detail screen (reader article, settings level)", () => {
  beforeEach(async () => {
    await flush();
    window.history.replaceState({ ondenDepth: 0 }, "", "/?view=rss");
  });

  function useDetail() {
    const [open, setOpen] = useState(false);
    const [item, setItem] = useState("one");
    const entry = useHistoryEntry(open, () => setOpen(false), "ondenArticle");
    return { open, item, setOpen, setItem, entry };
  }

  it("opening pushes one entry; previous / next replace nothing and add nothing; Back closes to the list", async () => {
    const { result } = renderHook(useDetail);
    act(() => result.current.setOpen(true));
    expect(depth()).toBe(1);
    act(() => result.current.setItem("two"));
    act(() => result.current.setItem("three"));
    expect(depth()).toBe(1);
    act(() => window.history.back());
    await waitFor(() => expect(result.current.open).toBe(false));
  });

  it("the screen's own back button drops the entry instead of leaving a dead one", async () => {
    const { result } = renderHook(useDetail);
    act(() => result.current.setOpen(true));
    act(() => { result.current.entry.leave(); result.current.setOpen(false); });
    await flush();
    expect(window.history.state).toMatchObject({ ondenDepth: 0 });
  });

  // An article's linked page over the article (RSS reader): each is a screen of its own.
  function useNested() {
    const [outer, setOuter] = useState(false);
    const [inner, setInner] = useState(false);
    const outerEntry = useHistoryEntry(outer, () => setOuter(false), "ondenArticle");
    const innerEntry = useHistoryEntry(inner, () => setInner(false), "ondenRssLink");
    return { outer, inner, setOuter, setInner, outerEntry, innerEntry };
  }

  it("a screen over another: Back closes the top one only, then the one under it", async () => {
    const { result } = renderHook(useNested);
    act(() => result.current.setOuter(true));
    act(() => result.current.setInner(true));
    act(() => window.history.back());
    await waitFor(() => expect(result.current.inner).toBe(false));
    await flush();
    expect(result.current.outer).toBe(true);
    act(() => window.history.back());
    await waitFor(() => expect(result.current.outer).toBe(false));
  });

  it("the top screen's own back button leaves the screen under it open", async () => {
    const { result } = renderHook(useNested);
    act(() => result.current.setOuter(true));
    act(() => result.current.setInner(true));
    act(() => { result.current.innerEntry.leave(); result.current.setInner(false); });
    await flush();
    expect(result.current.outer).toBe(true);
    expect(window.history.state).toMatchObject({ ondenArticle: 2 });
  });
});
