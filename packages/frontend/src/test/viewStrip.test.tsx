// The page's title strip (components/viewTabs/ViewStrip, NotesWorkspace): on a wide screen one full-width row
// at the top of the centre pane, the same on the content, whiteboard and table tabs; the view tabs at its left, the
// open tab's own buttons (the whiteboard's 「顯示」) and the note's ⋯ at its right; ＋ even for a note with only 內容.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, within } from "@testing-library/react";
import NotesWorkspace from "../components/workspace/NotesWorkspace";
import BoardViewMenu from "../components/BoardViewMenu";
import { ViewStripEnd } from "../components/viewTabs";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { resetOwnerViews } from "../lib/ownerViews";
import { clearPhoneLayout } from "./phoneMedia";

vi.mock("../lib/localDb", async (original) => ({ ...await original<typeof import("../lib/localDb")>(), getPendingWrites: vi.fn(async () => []) }));
vi.mock("../lib/api", async (original) => {
  const actual = await original<typeof import("../lib/api")>();
  return { ...actual, api: vi.fn(async (path: string) => {
    if (path.endsWith("/views")) return { views: [] };
    throw new Error(`unexpected ${path}`);
  }) };
});

const NODE = "00000000-0000-4000-8000-00000000a001";
const note = { id: NODE, title: "Reading list", node_type: "content", parent_id: null, markdown: "Body" } as unknown as ContentNode;
const display = { cardDefault: "folded", cardOverrides: {}, titleOnlyFar: true } as never;

type Tab = { notesView: "editor" | "canvas"; viewTab: string | null };
const CONTENT: Tab = { notesView: "editor", viewTab: null };
function renderWide({ notesView, viewTab }: Tab, center: React.ReactNode = <div />, selection: { selectedNode: ContentNode | null } = { selectedNode: note }) {
  return render(
    <NotesWorkspace
      sidebar={null} center={center} inspector={null} mobileTab="edit" onCloseInfo={() => {}}
      ui={{ mode: "notes", setMode: vi.fn(), notesView, setNotesView: vi.fn(), viewTab, setOverviewMobileTab: vi.fn() } as never}
      nav={{ goBack: vi.fn(), canGoBack: false, setLens: vi.fn(), selectTab: vi.fn(), openBoardId: null, selectedNode: selection.selectedNode, selectedTag: null, pageNode: note, pageTag: null }}
      panes={{ inspectorOpen: true, focusMode: false, showInspector: vi.fn() }}
      noteActions={{ exportNote: async () => true, copyMarkdown: async () => true, exportBusy: false }}
      nodeVersions={[]}
      welcomeActions={{ refresh: async () => {}, createNote: async () => {}, openDailyNote: async () => {} }}
    />,
  );
}
const strip = (container: HTMLElement) => container.querySelector(".center-lens-bar") as HTMLElement;

describe("the title strip (wide screen)", () => {
  beforeEach(() => {
    clearPhoneLayout();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    resetAppState({ data: { ...noWorkspaceData, actor_role: "admin", actor_is_owner: true, nodes: [note] }, online: true });
    resetOwnerViews();
  });

  it.each([
    ["content", CONTENT],
    ["whiteboard", { notesView: "canvas", viewTab: null } as Tab],
    ["table", { notesView: "editor", viewTab: "v1" } as Tab],
  ])("the %s tab: the strip is the first thing in the centre pane, holding the tabs and ＋", async (_name, tab) => {
    const { container } = renderWide(tab);
    const wrap = container.querySelector(".notes-center-wrap") as HTMLElement;
    expect(wrap.firstElementChild).toBe(strip(container));
    expect(within(strip(container)).getByRole("tab", { name: "Content" })).toBeInTheDocument();
    expect(await within(strip(container)).findByRole("button", { name: "Add a view" })).toBeInTheDocument();
  });

  it("a board with nothing selected (a click on empty space) keeps the note's tabs and ＋ next to its own buttons", async () => {
    const { container } = renderWide({ notesView: "canvas", viewTab: null },
      <BoardViewMenu display={display} onDisplay={vi.fn()} minimap={false} onMinimap={vi.fn()} fullscreen={false} onFullscreen={vi.fn()} />,
      { selectedNode: null });
    const bar = within(strip(container));
    expect(bar.getByRole("tab", { name: "Content" })).toBeInTheDocument();
    expect(await bar.findByRole("button", { name: "Add a view" })).toBeInTheDocument();
    expect(await bar.findByRole("button", { name: "Display" })).toBeInTheDocument();
  });

  it("a note with only 內容 still has the strip, with ＋", async () => {
    const { container } = renderWide(CONTENT);
    expect(within(strip(container)).getAllByRole("tab")).toHaveLength(1);
    expect(await within(strip(container)).findByRole("button", { name: "Add a view" })).toBeInTheDocument();
  });

  it("the whiteboard's 「Display」 and full screen are in the strip, before the note's ⋯", async () => {
    const { container } = renderWide({ notesView: "canvas", viewTab: null },
      <BoardViewMenu display={display} onDisplay={vi.fn()} minimap={false} onMinimap={vi.fn()} fullscreen={false} onFullscreen={vi.fn()} />);
    const bar = within(strip(container));
    const labels = (await bar.findAllByRole("button")).map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim() ?? b.getAttribute("title"));
    expect(labels.indexOf("Display")).toBeGreaterThan(-1);
    expect(labels.indexOf("Full screen")).toBeGreaterThan(labels.indexOf("Display"));
    expect(labels.indexOf("More actions")).toBeGreaterThan(labels.indexOf("Full screen"));
    expect(container.querySelector(".notes-center-wrap > .board-view-controls")).toBeNull();
  });

  it("whatever a tab puts into the 「more」 slot lands at the strip's right end", async () => {
    const { container } = renderWide(CONTENT, <ViewStripEnd slot="more"><button>Probe</button></ViewStripEnd>);
    expect(await within(strip(container)).findByRole("button", { name: "Probe" })).toBeInTheDocument();
  });

  it("no ⋯ twice: over the content tab the editor owns it, over the other tabs NoteTabActions does", async () => {
    const content = renderWide(CONTENT);
    expect(within(strip(content.container)).queryByTitle("More actions")).toBeNull();
    content.unmount();
    const board = renderWide({ notesView: "canvas", viewTab: null });
    expect(await within(strip(board.container)).findAllByTitle("More actions")).toHaveLength(1);
  });
});
