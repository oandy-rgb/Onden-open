// The phone's Info screen is a page of its own (hooks/usePhoneInfoScreen): Back = the previous page.
import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { navigate, useUrlSync, type AppView } from "../hooks/useUrlLocation";
import { usePhoneInfoScreen } from "../hooks/usePhoneInfoScreen";
import type { NodeLens } from "../lib/nodeLens";
import type { OverviewMobileTab } from "../hooks/useUiMode";

/** The same wiring BuilderWorkspace has: the location owns the note, the Info screen owns its entry. */
function usePhoneNotes() {
  const [view, setView] = useState<AppView>("notes");
  const [node, setNode] = useState<string | null>("a");
  const [lens, setLens] = useState<NodeLens>("editor");
  const [tab, setTab] = useState<OverviewMobileTab>("edit");
  const info = usePhoneInfoScreen({ phone: true, tab, selectedId: node, setTab, setSelectedId: setNode });
  useUrlSync(view, node, lens, setView, info.setNoteFromHistory, setLens, null, () => {}, () => false, null, true);
  return { node, tab, setTab, openNote: (id: string) => navigate(() => setNode(id), { history: "push" }), closeInfo: info.closeInfo };
}

const urlNode = () => new URLSearchParams(window.location.search).get("node");
const back = () => act(() => window.history.back());

describe("phone Info screen and system Back", () => {
  beforeEach(() => {
    window.history.replaceState({ ondenDepth: 1 }, "", "/?view=notes&node=a&lens=editor");
  });

  it("Back from Info returns to the same note's content", async () => {
    const { result } = renderHook(usePhoneNotes);
    act(() => result.current.setTab("info"));
    back();
    await waitFor(() => expect(result.current.tab).toBe("edit"));
    expect(result.current.node).toBe("a");
    expect(urlNode()).toBe("a");
  });

  it("the on-screen ‹ closes Info without leaving a dead history entry", async () => {
    const { result } = renderHook(usePhoneNotes);
    const before = window.history.state;
    act(() => result.current.setTab("info"));
    act(() => result.current.closeInfo());
    expect(result.current.tab).toBe("edit");
    await waitFor(() => expect(window.history.state).toEqual(before));
    expect(urlNode()).toBe("a");
  });

  it("A → B, Info of B, Back: B's content; Back again: A's content (never A's Info)", async () => {
    const { result } = renderHook(usePhoneNotes);
    act(() => result.current.openNote("b"));
    expect(urlNode()).toBe("b");
    act(() => result.current.setTab("info"));
    back();
    await waitFor(() => expect(result.current.tab).toBe("edit"));
    expect(result.current.node).toBe("b");
    back();
    await waitFor(() => expect(result.current.node).toBe("a"));
    expect(urlNode()).toBe("a");
    expect(result.current.tab).toBe("edit");
  });

  it("a jump back across pages from Info lands on the other note's content", async () => {
    const { result } = renderHook(usePhoneNotes);
    act(() => result.current.openNote("b"));
    act(() => result.current.setTab("info"));
    act(() => window.history.go(-2)); // Info's entry and B's page at once
    await waitFor(() => expect(result.current.node).toBe("a"));
    expect(result.current.tab).toBe("edit");
  });
});
