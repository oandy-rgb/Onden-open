// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { resetAppState, setAppState } from "../lib/appStore";
import { notePress } from "../lib/splitView";

// The function page in the pane IS SecondaryLensOutlet: a stub that shows the view and lets a test open a note from it.
vi.mock("../components/SecondaryLensOutlet", () => ({
  default: (props: { mode: string; onOpenNote: (id: string) => void }) => (
    <button type="button" data-testid="outlet" onClick={() => props.onOpenNote("n2")}>{`page:${props.mode}`}</button>
  ),
}));
vi.mock("../lib/localDb", async (original) => ({ ...await original<typeof import("../lib/localDb")>(), getPendingWrites: vi.fn(async () => []) }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn(async () => ({ views: [] })) }));
vi.mock("../modules", async (original) => ({ ...(await original<object>()), loadRssQuote: async () => ({ appendToNote: vi.fn(), appendQuote: vi.fn() }) }));

import SplitPane from "../components/splitView/SplitPane";
import { dataSync } from "../lib/data";

const node = (id: string, title: string, markdown = ""): ContentNode =>
  ({ id, title, slug: id, markdown, node_type: "content", source_type: "manual", parent_id: null }) as ContentNode;

const handlers = () => ({
  outlet: { refresh: vi.fn(async () => {}), dueSoon: {} as never, openModule: vi.fn() },
  onOpenNoteLeft: vi.fn(), onChangeTarget: vi.fn(), onSwap: vi.fn(), onClose: vi.fn(), refresh: vi.fn(async () => {}),
});

beforeEach(() => resetAppState({ data: { ...noWorkspaceData, nodes: [node("n1", "Reading notes", "Some **text**"), node("n2", "Other")] }, online: true }));
afterEach(() => cleanup());

describe("SplitPane", () => {
  it("a function page is the same outlet the left uses, named in the header", () => {
    const h = handlers();
    render(<SplitPane target={{ kind: "page", mode: "tasks" }} {...h} />);
    expect(screen.getByTestId("outlet").textContent).toBe("page:tasks");
    expect(screen.getByRole("complementary", { name: /Tasks/ })).toBeInTheDocument();
  });

  it("a note opened from a function page in the pane goes to the other side, the page stays", () => {
    const h = handlers();
    render(<SplitPane target={{ kind: "page", mode: "tasks" }} {...h} />);
    fireEvent.click(screen.getByTestId("outlet"));
    expect(h.onOpenNoteLeft).toHaveBeenCalledWith("n2");
    expect(h.onChangeTarget).not.toHaveBeenCalled();
  });

  it("a note's text is read here, with the name in the header and a box to jot into it", async () => {
    render(<SplitPane target={{ kind: "note", id: "n1", tab: "content" }} {...handlers()} />);
    expect(screen.getByRole("heading", { name: "Reading notes" })).toBeInTheDocument();
    expect(await screen.findByText("text")).toBeInTheDocument();
    expect(screen.getByLabelText("Jot down")).toBeInTheDocument();
  });

  it("並排: the note in the left editor shows here as it is typed, with no second box to write in", async () => {
    resetAppState({ data: { ...noWorkspaceData, nodes: [node("n1", "Reading notes", "Some **text**")] }, online: true, selectedId: "n1", overviewDraft: "Typed **just now**" });
    render(<SplitPane target={{ kind: "note", id: "n1", tab: "content" }} {...handlers()} />);
    expect(await screen.findByText("just now")).toBeInTheDocument();
    expect(screen.queryByText("text")).toBeNull();
    expect(screen.queryByLabelText("Jot down")).toBeNull();
  });

  it("⇄ swaps and ✕ closes", () => {
    const h = handlers();
    render(<SplitPane target={{ kind: "page", mode: "graph" }} {...h} />);
    fireEvent.click(screen.getByRole("button", { name: "Swap sides" }));
    fireEvent.click(screen.getByRole("button", { name: "Close the right side" }));
    expect(h.onSwap).toHaveBeenCalledTimes(1);
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it("a note whose body is not in memory (a large, slim workspace) is fetched, not shown empty", () => {
    const hydrate = vi.spyOn(dataSync, "hydrateNode").mockResolvedValue();
    resetAppState({ data: { ...noWorkspaceData, nodes: [{ ...node("n3", "Slim note"), body_len: 120 } as ContentNode] }, online: true });
    render(<SplitPane target={{ kind: "note", id: "n3", tab: "content" }} {...handlers()} />);
    expect(hydrate).toHaveBeenCalledWith("n3");
    hydrate.mockRestore();
  });

  it("a slim note opened offline is fetched when the connection comes back", () => {
    const hydrate = vi.spyOn(dataSync, "hydrateNode").mockResolvedValue();
    resetAppState({ data: { ...noWorkspaceData, nodes: [{ ...node("n3", "Slim note"), body_len: 120 } as ContentNode] }, online: false });
    render(<SplitPane target={{ kind: "note", id: "n3", tab: "content" }} {...handlers()} />);
    expect(hydrate).not.toHaveBeenCalled();
    act(() => { setAppState({ online: true }); });
    expect(hydrate).toHaveBeenCalledWith("n3");
    hydrate.mockRestore();
  });

  it("a note that is gone says so instead of showing nothing", () => {
    render(<SplitPane target={{ kind: "note", id: "missing", tab: "content" }} {...handlers()} />);
    expect(screen.getByText("This note is no longer available.")).toBeInTheDocument();
  });

  it("the whiteboard is not drawn here: it says where it opens", () => {
    render(<SplitPane target={{ kind: "note", id: "n1", tab: "canvas" }} {...handlers()} />);
    expect(screen.getByText(/whiteboard opens on the left/i)).toBeInTheDocument();
  });

  it("the header is draggable (to the left it reads there)", () => {
    render(<SplitPane target={{ kind: "page", mode: "graph" }} {...handlers()} />);
    expect(screen.getByTitle("Drag to the left to read it there")).toHaveAttribute("draggable", "true");
    notePress({ ctrlKey: false, metaKey: false }, 0);
  });
});
