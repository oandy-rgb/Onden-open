// Deleting the note that is open moves the focus to its neighbour by itself. That move replaces the deleted note's
// history entry, so Back goes to the page before it and never to the address of a note that no longer exists.
// A note that is not in the workspace (an old link, deleted elsewhere) says so and offers a way out, not a loading pane.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen, waitFor, fireEvent } from "@testing-library/react";
import { useUrlSync } from "../hooks/useUrlLocation";
import OverviewEditorHost from "../components/OverviewEditorHost";
import { nodeActions } from "../lib/data";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { bindAccountStorage } from "../lib/accountStorage";
import { getAppState, resetAppState, setSelectedId, useAppSelector } from "../lib/appStore";
import { setLocalePref } from "../lib/i18n";

vi.mock("../lib/localDb", async (original) => ({
  ...await original<typeof import("../lib/localDb")>(),
  getPendingWrites: vi.fn(async () => []),
  searchNodes: vi.fn(async () => []),
}));
vi.mock("../lib/api", async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, api: vi.fn(async () => ({})) };
});

const node = (id: string, order: number): ContentNode =>
  ({ id, title: id, node_type: "content", parent_id: null, hidden: false, markdown: "", source_type: "manual", slug: id, sort_order: order }) as ContentNode;

const flush = () => new Promise((r) => setTimeout(r, 30));
const urlNode = () => new URLSearchParams(window.location.search).get("node");

function useShell() {
  const nodeId = useAppSelector((s) => s.selectedId);
  useUrlSync("notes", nodeId, "editor", () => {}, (id) => setSelectedId(id), () => {});
  return nodeId;
}

beforeEach(async () => {
  localStorage.clear();
  bindAccountStorage("delete-history-test", "");
  setLocalePref("en");
  await flush();
  window.history.replaceState(null, "", "/?view=notes");
  resetAppState({ online: true, bootstrapped: true, data: { ...noWorkspaceData, nodes: [node("a", 1), node("b", 2), node("c", 3)], tags: [] } });
});

describe("deleting the open note", () => {
  it("replaces its history entry: Back goes to the page before it, not to the deleted note", async () => {
    renderHook(useShell);
    act(() => setSelectedId("a")); // a page of its own
    await flush();
    act(() => setSelectedId("b")); // another
    await flush();
    expect(urlNode()).toBe("b");
    const depth = window.history.length;

    await act(async () => { expect(await nodeActions.delete("b")).toBe(true); });
    await flush();
    expect(getAppState().data.nodes.some((n) => n.id === "b")).toBe(false);
    expect(urlNode()).not.toBe("b");
    expect(window.history.length).toBe(depth); // no entry added

    act(() => window.history.back());
    await waitFor(() => expect(getAppState().selectedId).toBe("a"));
    expect(urlNode()).toBe("a");
  });
});

describe("a note that is not in the workspace", () => {
  const host = () => render(<OverviewEditorHost onOpenWikilink={() => {}} onCreateFirst={() => {}} />);

  it("says it no longer exists and the button leaves the address", async () => {
    resetAppState({ online: true, bootstrapped: true, selectedId: "gone", data: { ...noWorkspaceData, nodes: [node("a", 1)], tags: [] } });
    host();
    expect(screen.getByText("It no longer exists, or you can't see it.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to notes list" }));
    expect(getAppState().selectedId).toBeNull();
  });

  it("while the workspace has not loaded yet it is still the loading pane (a cold boot's URL note is on its way)", () => {
    resetAppState({ online: true, bootstrapped: false, selectedId: "gone", data: { ...noWorkspaceData, nodes: [], tags: [] } });
    const { container } = host();
    expect(screen.queryByText("It no longer exists, or you can't see it.")).toBeNull();
    expect(container.querySelector(".lazy-loading-pane")).not.toBeNull();
  });
});
