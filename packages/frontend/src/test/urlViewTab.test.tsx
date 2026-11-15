// The open view tab is in the URL (?lens=editor&tab=<view id>): a reload keeps
// it, and the browser's Back/Forward put it back (hooks/useUrlLocation).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { useUrlSync, type AppView } from "../hooks/useUrlLocation";
import type { NodeLens } from "../lib/nodeLens";
import { bindAccountStorage } from "../lib/accountStorage";

function useLocationState(initial: { view?: AppView; nodeId?: string | null; lens?: NodeLens; viewTab?: string | null } = {}) {
  const [view, setView] = useState<AppView>(initial.view ?? "notes");
  const [nodeId, setNodeId] = useState<string | null>(initial.nodeId ?? "n1");
  const [lens, setLens] = useState<NodeLens>(initial.lens ?? "editor");
  const [viewTab, setViewTab] = useState<string | null>(initial.viewTab ?? null);
  useUrlSync(view, nodeId, lens, setView, setNodeId, setLens, viewTab, setViewTab);
  return { view, nodeId, lens, viewTab, setLens, setViewTab, setNodeId, setView };
}

describe("the view tab in the URL", () => {
  beforeEach(() => { bindAccountStorage("url-tab-test", ""); window.history.replaceState(null, "", "/?view=notes&node=n1&lens=editor"); });
  afterEach(() => vi.restoreAllMocks());

  it("choosing a tab rewrites the URL without adding history; content and canvas drop the parameter", () => {
    const push = vi.spyOn(window.history, "pushState");
    const { result } = renderHook(() => useLocationState());
    act(() => result.current.setViewTab("v1"));
    expect(window.location.search).toBe("?view=notes&node=n1&lens=editor&tab=v1");
    act(() => result.current.setViewTab(null));
    expect(window.location.search).toBe("?view=notes&node=n1&lens=editor");
    act(() => { result.current.setViewTab("v1"); result.current.setLens("canvas"); });
    expect(window.location.search).toBe("?view=notes&node=n1&lens=canvas");
    expect(push).not.toHaveBeenCalled();
  });

  it("Back restores the tab the URL names, including leaving a tab for 內容", () => {
    const { result } = renderHook(() => useLocationState({ viewTab: "v1" }));
    expect(window.location.search).toBe("?view=notes&node=n1&lens=editor&tab=v1");
    act(() => {
      window.history.replaceState(null, "", "/?view=notes&node=n2&lens=editor&tab=v2");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current.nodeId).toBe("n2");
    expect(result.current.viewTab).toBe("v2");
    act(() => {
      window.history.replaceState(null, "", "/?view=notes&node=n2&lens=editor");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current.viewTab).toBeNull();
  });
});
