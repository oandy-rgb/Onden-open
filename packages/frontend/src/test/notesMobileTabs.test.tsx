// The phone's note screen: one top bar on every tab. It only leads out (‹ Back)
// and, at its right end, holds the note's ⊟ (Info) and ⋯ — the editor's header
// on the content tab (OverviewEditorHost), NoteTabActions over the others. The
// page's own tabs (内容, 白板, table…, ＋) are a row inside the page above its title (a wide screen has the
// title strip instead, see viewStrip.test).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import NotesWorkspace from "../components/workspace/NotesWorkspace";
import { noWorkspaceData, type ContentNode, type Tag } from "../lib/api";
import { useBoardPhoneNav } from "../components/BoardPhoneNav";
import { resetAppState } from "../lib/appStore";
import { resetOwnerViews } from "../lib/ownerViews";
import { clearPhoneLayout, setPhoneLayout } from "./phoneMedia";

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

type Lens = "editor" | "canvas";
/** What a board would read: the title its sheet opens from, when it has one. */
function BoardTitleProbe() {
  const nav = useBoardPhoneNav();
  return nav ? <div data-testid="board-title">{nav.title}{nav.sheet(() => {})}</div> : null;
}

function renderWorkspace({ mobileTab = "edit", notesView = "editor", viewTab = null, selectedTag = null, probe = false, cleared = false }: { cleared?: boolean; mobileTab?: "edit" | "list" | "info"; notesView?: Lens; viewTab?: string | null; selectedTag?: Tag | null; probe?: boolean } = {}) {
  const onToggle = vi.fn();
  const onCloseInfo = vi.fn();
  const selectTab = vi.fn();
  const ui = { mode: "notes", setMode: vi.fn(), notesView, setNotesView: vi.fn(), viewTab, setOverviewMobileTab: vi.fn() };
  const view = render(
    <NotesWorkspace
      sidebar={null} center={probe ? <BoardTitleProbe /> : <div />} inspector={null} mobileTab={mobileTab} onCloseInfo={onCloseInfo}
      ui={ui as never}
      nav={{ goBack: vi.fn(), canGoBack: false, setLens: vi.fn(), selectTab, openBoardId: null, selectedNode: selectedTag || cleared ? null : note, selectedTag, pageNode: selectedTag ? null : note, pageTag: selectedTag }}
      panes={{ inspectorOpen: true, focusMode: false, showInspector: vi.fn() }}
      noteActions={{ exportNote: async () => true, copyMarkdown: async () => true, exportBusy: false, inspectorToggle: { pressed: false, onToggle } }}
      nodeVersions={[]}
      welcomeActions={{ refresh: async () => {}, createNote: async () => {}, openDailyNote: async () => {} }}
    />,
  );
  return { ...view, ui, onToggle, selectTab, onCloseInfo };
}

const bar = (container: HTMLElement) => within(container.querySelector(".overview-mobile-tabs") as HTMLElement);

describe("notes mobile tabs", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    resetAppState({ data: { ...noWorkspaceData, actor_role: "admin", actor_is_owner: true, nodes: [note] }, online: true });
    resetOwnerViews();
    setPhoneLayout(true);
  });
  afterEach(() => clearPhoneLayout());

  it("on the content tab the top bar is only Back; the editor's header owns ⊟ ⋯, so none is added here", () => {
    const { container } = renderWorkspace();
    expect(bar(container).getByRole("button", { name: "Back to notes list" })).toBeInTheDocument();
    expect(container.querySelector(".note-tab-actions")).toBeNull();
    // A phone has no title strip; its tabs are a row in the page, not a button in this bar.
    expect(container.querySelector(".center-lens-bar")).toBeNull();
    expect(bar(container).queryByRole("button", { name: "Content" })).toBeNull();
    expect(container.querySelector(".overview-mobile-tabs .board-note-title")).toBeNull();
  });

  it.each([
    ["whiteboard", { notesView: "canvas" as Lens, viewTab: null }],
    ["table", { notesView: "editor" as Lens, viewTab: "v1" }],
  ])("on the %s tab the bar is Back + ⊟ + ⋯, with no Note | Info switch", (_name, tab) => {
    const { container, onToggle } = renderWorkspace(tab);
    expect(bar(container).getByRole("button", { name: "Back to notes list" })).toBeInTheDocument();
    // The old 「筆記｜資訊」 switch is gone.
    expect(container.querySelector(".omt-lens")).toBeNull();
    expect(bar(container).queryByRole("button", { name: "Note" })).toBeNull();
    const actions = within(container.querySelector(".note-tab-actions") as HTMLElement);
    expect(actions.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.getAttribute("title"))).toEqual(["Ask AI about this note", "Info", "More actions"]);
    fireEvent.click(actions.getByRole("button", { name: "Info" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("the tabs are a row in the page, before the page's own content, with ＋ even when 「Content」 is the only tab", async () => {
    const { container } = renderWorkspace();
    const row = container.querySelector(".phone-view-tabs") as HTMLElement;
    expect(container.querySelector(".notes-center-wrap")?.firstElementChild).toBe(row);
    expect(within(row).getAllByRole("tab").map((t) => t.textContent?.trim())).toEqual(["Content"]);
    expect(await within(row).findByRole("button", { name: "Add a view" })).toBeInTheDocument();
    expect(row.closest(".overview-mobile-tabs")).toBeNull();
  });

  it("one tap on a tab opens it; the row is on the table tab too", async () => {
    const { container, selectTab } = renderWorkspace({ notesView: "editor", viewTab: "v1" });
    const row = within(container.querySelector(".phone-view-tabs") as HTMLElement);
    fireEvent.click(row.getByRole("tab", { name: "Content" }));
    expect(selectTab).toHaveBeenCalledWith("content");
  });

  it("a full-screen board has no row: its title sheet keeps the tabs and ⊟ ⋯", async () => {
    const { container } = renderWorkspace({ notesView: "canvas" });
    expect(container.querySelector(".phone-view-tabs")).toBeNull();
  });

  it("a click on empty board space clears the selection, not the page: the title sheet keeps the note's tabs", async () => {
    const { container, selectTab } = renderWorkspace({ notesView: "canvas", cleared: true, probe: true });
    expect(container.querySelector(".phone-view-tabs")).toBeNull();
    const title = screen.getByTestId("board-title");
    expect(title.textContent).toContain("Reading list");
    fireEvent.click((await within(title).findAllByRole("tab"))[0]!);
    expect(selectTab).toHaveBeenCalledWith("content");
  });

  it("a tag's full-screen board has the title sheet too, with the tag's tabs and no note buttons", async () => {
    const books = { id: "00000000-0000-4000-8000-00000000b001", name: "書籍" } as unknown as Tag;
    const { container, selectTab } = renderWorkspace({ notesView: "canvas", selectedTag: books, probe: true });
    expect(container.querySelector(".phone-view-tabs")).toBeNull();
    const title = screen.getByTestId("board-title");
    expect(title.textContent).toContain("#書籍");
    const tabs = await within(title).findAllByRole("tab");
    fireEvent.click(tabs[0]!); // the tag's first tab (its list)
    expect(selectTab).toHaveBeenCalledWith("content");
    expect(title.querySelector(".board-note-sheet__actions")).toBeNull();
  });

  it("the Info screen has no row", () => {
    const { container } = renderWorkspace({ mobileTab: "info" });
    expect(container.querySelector(".phone-view-tabs")).toBeNull();
  });

  it("the Info screen's bar is only ‹ Content: no switch and no ⊟ ⋯, and ‹ returns to the tab it came from", () => {
    const { container, ui, onCloseInfo } = renderWorkspace({ mobileTab: "info", notesView: "canvas" });
    expect(container.querySelectorAll(".overview-mobile-tabs button")).toHaveLength(1);
    expect(container.querySelector(".note-tab-actions")).toBeNull();
    fireEvent.click(bar(container).getByRole("button", { name: "Back to note" }));
    expect(onCloseInfo).toHaveBeenCalledTimes(1);
    expect(ui.setNotesView).not.toHaveBeenCalled();
  });

  it("a wide screen draws no phone actions: ⋯ is in the title strip", () => {
    setPhoneLayout(false);
    const { container } = renderWorkspace({ notesView: "canvas" });
    expect(container.querySelector(".note-tab-actions")).toBeNull();
    expect(within(container.querySelector(".center-lens-bar") as HTMLElement).getByTitle("More actions")).toBeInTheDocument();
  });

  it("the list level has no strip of its own: its tabs already say Notes", () => {
    const { container } = renderWorkspace({ mobileTab: "list" });
    expect(container.querySelector(".overview-mobile-tabs")).toBeNull();
    expect(container.querySelector(".note-tab-actions")).toBeNull();
    expect(screen.queryByRole("button", { name: "Table" })).toBeNull();
  });
});
