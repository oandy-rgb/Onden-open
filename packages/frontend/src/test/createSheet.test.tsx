import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import OverviewSidebar from "../components/OverviewSidebar";
import { noWorkspaceData, type ContentNode, type Tag } from "../lib/api";
import { resetAppState, getAppState } from "../lib/appStore";
import { bindAccountStorage } from "../lib/accountStorage";
import { sidebarTagsStore } from "../lib/sidebarTagsStore";
import { PREFS, getPref, setPref } from "../lib/prefs";
import { useNodeCreation } from "../hooks/useNodeCreation";
import { reads } from "../lib/data";
import { refreshSpaces, resetSpacesForTest, type Space } from "../lib/spaces";
import { sidebarGroups } from "./fixtures/sidebarGroups";

const { openQuickAddTask } = vi.hoisted(() => ({ openQuickAddTask: vi.fn() }));
vi.mock("../modules/tasks/openQuickAddTask", () => ({ openQuickAddTask }));

vi.mock("../lib/localDb", () => ({
  searchNodes: vi.fn(async () => []),
  upsertNode: vi.fn(async () => {}), removeNode: vi.fn(async () => {}), upsertAttribute: vi.fn(async () => {}),
  getPendingWrites: vi.fn(async () => []), addPendingWrite: vi.fn(async () => {}),
  storeRejectedWrite: vi.fn(async (request: object, rejection: string) => ({ ...request, id: 1, attempts: 0, rejection })),
}));

const note = (id: string, title: string, over: Partial<ContentNode> = {}): ContentNode => ({
  id, title, slug: id, markdown: "", node_type: "content", source_type: "manual", ...over,
});
const tag = (id: string, name: string, over: Partial<Tag> = {}): Tag => ({ id, name, color: "", schema_id: null, ...over });

const PROJ = tag("t-proj", "proj");
const DRAFT = tag("t-draft", "draft", { parent_id: "t-proj" });
const FUNCTION_TAG = tag("m-review", "複習", { schema_module: "review" });
const NOTES = [note("n1", "Roadmap"), note("n2", "Sketch"), note("n3", "Alpha child", { parent_id: "n1" })];

function seed({ owner = true, pane }: { owner?: boolean; pane?: "tags" | "nodes" } = {}) {
  // The phone remembers its last tab (a device pref) and restores it on mount.
  if (pane) setPref(PREFS.sidebarPane, pane);
  resetAppState({
    data: { ...noWorkspaceData, nodes: NOTES, tags: [PROJ, DRAFT, FUNCTION_TAG], actor_is_owner: owner },
    online: true, ...(pane ? { overviewPane: pane } : {}),
  });
}

function phone(matches: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: matches && query.includes("max-width: 900px"), media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

const originalMatchMedia = window.matchMedia;
beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); localStorage.clear(); bindAccountStorage("unit-test-account", ""); phone(true); sidebarTagsStore.save(null); seed(); });
afterEach(() => { window.matchMedia = originalMatchMedia; resetAppState(); localStorage.clear(); });

// The sheet loads on first use (lazyWithReload), so it appears a moment after the click.
const findSheet = () => screen.findByRole("dialog", { name: "Create" });
const openSheet = async () => { fireEvent.click(screen.getByRole("button", { name: "Create" })); return findSheet(); };
const kindChecked = (sheet: HTMLElement) => within(sheet).getAllByRole("radio").filter((r) => r.getAttribute("aria-checked") === "true").map((r) => r.textContent?.trim());
// 放在 is one row; its picker (PlacePicker) takes the sheet's place while open.
const placeButton = (sheet: HTMLElement) => sheet.querySelector<HTMLButtonElement>(".create-sheet-place")!;
const optionLabels = (sheet: HTMLElement) => within(sheet).queryAllByRole("option").map((o) => o.querySelector(".place-picker-label")!.textContent);
const headings = (sheet: HTMLElement) => [...sheet.querySelectorAll(".place-picker-heading")].map((h) => h.textContent?.trim());
const pickOption = (sheet: HTMLElement, name: string | RegExp, index = 0) => fireEvent.click(within(sheet).getAllByRole("option", { name })[index]!);

describe("the ＋ create sheet", () => {
  it("opens on the tab's kind: 筆記 → note, 標籤 → tag", async () => {
    const first = render(<OverviewSidebar {...sidebarGroups()} />);
    expect(kindChecked(await openSheet())).toEqual(["Note"]);
    first.unmount();
    seed({ pane: "tags" });
    render(<OverviewSidebar {...sidebarGroups()} />);
    const sheet = await openSheet();
    expect(within(sheet).queryByRole("radio")).toBeNull();
    expect(within(sheet).getByRole("textbox", { name: "New tag name…" })).toBeInTheDocument();
  });

  it("lists the 白板 kind whatever the stored module list says", async () => {
    const withModules = (modules: string[]) => resetAppState({
      data: { ...noWorkspaceData, nodes: NOTES, tags: [PROJ], actor_is_owner: true, workspace: { ...noWorkspaceData.workspace, modules } }, online: true,
    });
    withModules(["canvas"]);
    const on = render(<OverviewSidebar {...sidebarGroups()} />);
    expect(within(await openSheet()).getByRole("radio", { name: "Canvas" })).toBeInTheDocument();
    on.unmount();
    withModules(["rss"]);
    render(<OverviewSidebar {...sidebarGroups()} />);
    expect(within(await openSheet()).getByRole("radio", { name: "Canvas" })).toBeInTheDocument();
  });

  it("lists 任務 right after 筆記 while the tasks module is on, and not when it is off", async () => {
    const withModules = (modules: string[]) => resetAppState({
      data: { ...noWorkspaceData, nodes: NOTES, tags: [PROJ], actor_is_owner: true, workspace: { ...noWorkspaceData.workspace, modules } }, online: true,
    });
    withModules(["tasks"]);
    const on = render(<OverviewSidebar {...sidebarGroups()} />);
    const kinds = within(await openSheet()).getAllByRole("radio").map((r) => r.textContent?.trim());
    expect(kinds.slice(0, 2)).toEqual(["Note", "Task"]);
    on.unmount();
    withModules(["rss"]);
    render(<OverviewSidebar {...sidebarGroups()} />);
    expect(within(await openSheet()).queryByRole("radio", { name: "Task" })).toBeNull();
  });

  it("choosing 任務 and Create closes the sheet and asks the one create entry for it, with no place row of its own", async () => {
    resetAppState({
      data: { ...noWorkspaceData, nodes: NOTES, tags: [PROJ], actor_is_owner: true, workspace: { ...noWorkspaceData.workspace, modules: ["tasks"] } }, online: true,
    });
    const props = sidebarGroups();
    render(<OverviewSidebar {...props} />);
    const sheet = await openSheet();
    fireEvent.click(within(sheet).getByRole("radio", { name: "Task" }));
    expect(sheet.querySelector(".create-sheet-place")).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Create" })).toBeNull());
    expect(props.create).toHaveBeenCalledWith("task", { parentId: null });
  });

  it("a note sheet never lists the tag kind, owner or not", async () => {
    for (const owner of [true, false]) {
      seed({ owner });
      const view = render(<OverviewSidebar {...sidebarGroups()} />);
      const sheet = await openSheet();
      expect(within(sheet).getByRole("radio", { name: "Note" })).toBeInTheDocument();
      expect(within(sheet).queryByRole("radio", { name: "Tag" })).toBeNull();
      view.unmount();
    }
  });

  it("a tag sheet shows only the tag kind and no 類型 row", async () => {
    seed({ pane: "tags" });
    render(<OverviewSidebar {...sidebarGroups()} />);
    const sheet = await openSheet();
    expect(within(sheet).queryByRole("radiogroup")).toBeNull();
    expect(within(sheet).queryByRole("radio")).toBeNull();
    expect(within(sheet).queryByText("What to create")).toBeNull();
    expect(within(sheet).getByRole("textbox", { name: "New tag name…" })).toBeInTheDocument();
    expect(placeButton(sheet)).toBeInTheDocument();
  });

  it("gives a non-owner no ＋ on the 標籤 tab", async () => {
    seed({ pane: "tags", owner: false });
    render(<OverviewSidebar {...sidebarGroups()} />);
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
  });

  it("starts a note's place from the one the ＋ remembered and writes a change back to it", async () => {
    setPref(PREFS.quickCaptureTarget, "n2");
    render(<OverviewSidebar {...sidebarGroups()} />);
    const sheet = await openSheet();
    expect(placeButton(sheet)).toHaveTextContent("Sketch");
    fireEvent.click(placeButton(sheet));
    pickOption(sheet, "Roadmap");
    expect(getPref(PREFS.quickCaptureTarget)).toBe("n1");
    expect(placeButton(sheet)).toHaveTextContent("Roadmap");
    fireEvent.click(placeButton(sheet));
    pickOption(sheet, "Top level");
    expect(getPref(PREFS.quickCaptureTarget)).toBeFalsy();
  });

  it("makes a note under the chosen note, or at the top level with none", async () => {
    setPref(PREFS.quickCaptureTarget, "n1");
    const props = sidebarGroups();
    render(<OverviewSidebar {...props} />);
    fireEvent.click(within(await openSheet()).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(props.create).toHaveBeenCalledWith("note", { parentId: "n1" }));
    expect(screen.queryByRole("dialog", { name: "Create" })).toBeNull();
  });

  it("a tag needs a name before 建立 is enabled, then lands under the chosen tag", async () => {
    seed({ pane: "tags" });
    const props = sidebarGroups();
    props.create.mockResolvedValue("new-tag");
    render(<OverviewSidebar {...props} />);
    const sheet = await openSheet();
    const submit = within(sheet).getByRole("button", { name: "Create" });
    expect(submit).toBeDisabled();
    fireEvent.change(within(sheet).getByRole("textbox", { name: "New tag name…" }), { target: { value: "  ideas " } });
    expect(submit).toBeEnabled();
    fireEvent.click(placeButton(sheet));
    pickOption(sheet, "proj");
    fireEvent.click(within(sheet).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(props.create).toHaveBeenCalledWith("tag", { parentId: "t-proj", name: "ideas" }));
  });

  it("keeps the sheet and the typed name when the tag was refused", async () => {
    seed({ pane: "tags" });
    const props = sidebarGroups();
    props.create.mockResolvedValue(null);
    render(<OverviewSidebar {...props} />);
    const sheet = await openSheet();
    fireEvent.change(within(sheet).getByRole("textbox", { name: "New tag name…" }), { target: { value: "taken" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(props.create).toHaveBeenCalled());
    expect(await findSheet()).toBeInTheDocument();
    expect(within(sheet).getByRole("textbox", { name: "New tag name…" })).toHaveValue("taken");
  });

  it("never offers a function, or a note, as a tag's place", async () => {
    seed({ pane: "tags" });
    render(<OverviewSidebar {...sidebarGroups()} />);
    const sheet = await openSheet();
    fireEvent.click(placeButton(sheet));
    const options = optionLabels(sheet);
    // One group with no space name, the tag tree as a tree: draft is under proj.
    expect(options).toEqual(["Top level", "proj", "draft"]);
    expect(headings(sheet)).toEqual([]);
    expect(within(sheet).queryByText("Quick capture files new notes here too.")).toBeNull();
  });

  it("offers notes, not tags, as a note's place", async () => {
    render(<OverviewSidebar {...sidebarGroups()} />);
    const sheet = await openSheet();
    fireEvent.click(placeButton(sheet));
    const options = optionLabels(sheet);
    expect(options).toEqual(expect.arrayContaining(["Roadmap", "Sketch", "Alpha child"]));
    expect(options).not.toContain("proj");
  });

  it("a tag row's 在裡面新增 opens the sheet on 標籤 under that tag", async () => {
    seed({ pane: "tags" });
    render(<OverviewSidebar {...sidebarGroups()} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Open #proj" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New inside ▸" }));
    const sheet = await findSheet();
    expect(within(sheet).queryByRole("radio")).toBeNull();
    expect(within(sheet).getByRole("textbox", { name: "New tag name…" })).toBeInTheDocument();
    expect(placeButton(sheet)).toHaveTextContent("proj");
  });

  it("has no 在裡面新增 on a function row or for a non-owner", async () => {
    seed({ pane: "tags", owner: false });
    render(<OverviewSidebar {...sidebarGroups()} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Open #proj" }));
    expect(screen.queryByRole("menuitem", { name: "New inside ▸" })).toBeNull();
  });

  it("the ⋯ menu's 新筆記放在… opens the picker at once", async () => {
    render(<OverviewSidebar {...sidebarGroups()} />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Where new notes go…" }));
    const sheet = await findSheet();
    expect(within(sheet).getByRole("combobox", { name: "Search places…" })).toBeInTheDocument();
    expect(within(sheet).getByText("Put it in…")).toBeInTheDocument();
    // The same picker both ways out: the row is back after a pick.
    pickOption(sheet, "Sketch");
    expect(placeButton(sheet)).toHaveTextContent("Sketch");
  });
});

describe("the desktop ＋", () => {
  it("opens the same sheet as a popover and keeps the text buttons", async () => {
    phone(false);
    render(<OverviewSidebar {...sidebarGroups()} />);
    expect(screen.getByRole("button", { name: "Sort" })).toHaveTextContent("Sort");
    expect(screen.getByRole("button", { name: "Open" })).toHaveAttribute("title", "Expand all");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const sheet = await findSheet();
    expect(sheet.classList.contains("create-sheet-popover")).toBe(true);
    expect(kindChecked(sheet)).toEqual(["Note"]);
  });

  it("offers 「只想記一句？快速捕捉」: closes the popover and opens quick capture", async () => {
    phone(false);
    const opened = vi.fn(); window.addEventListener("onden-open-quick-capture", opened);
    try {
      render(<OverviewSidebar {...sidebarGroups()} />);
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
      const link = within(await findSheet()).getByRole("button", { name: /^Just one line\? Quick capture / });
      fireEvent.click(link);
      expect(opened).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("dialog", { name: "Create" })).toBeNull();
    } finally { window.removeEventListener("onden-open-quick-capture", opened); }
  });

  it("a tag popover (New inside a tag) has no quick-capture link", async () => {
    phone(false);
    render(<OverviewSidebar {...sidebarGroups()} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Open #proj" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /New inside/ }));
    const sheet = await findSheet();
    expect(within(sheet).getByRole("textbox", { name: "New tag name…" })).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: /Quick capture/ })).toBeNull();
  });
});

describe("the phone sheet", () => {
  it("stays open while you tap inside it: a tap on a kind picks that kind", async () => {
    render(<OverviewSidebar {...sidebarGroups()} />);
    const sheet = await openSheet();
    expect(sheet.classList.contains("create-sheet-popover")).toBe(false);
    expect(within(sheet).queryByRole("button", { name: /Quick capture/ })).toBeNull();
    const other = within(sheet).getAllByRole("radio").find((r) => r.getAttribute("aria-checked") !== "true")!;
    // A real tap: pointerdown first (where an outside-tap handler would close it), then the click.
    fireEvent.pointerDown(other);
    fireEvent.click(other);
    expect(await findSheet()).toBeInTheDocument();
    expect(other.getAttribute("aria-checked")).toBe("true");
    fireEvent.pointerDown(sheet);
    expect(await findSheet()).toBeInTheDocument();
  });
});

describe("the phone toolbar", () => {
  const headerNames = () => [...document.querySelector(".obsidian-sidebar-header")!.querySelectorAll("button:not(.sidebar-tab)")]
    .map((b) => b.getAttribute("aria-label"));

  it("is exactly 🔍 ＋ ⋯ on the 筆記 tab and on the 標籤 tab", async () => {
    const view = render(<OverviewSidebar {...sidebarGroups()} />);
    expect(headerNames()).toEqual(["Search notes", "Create", "More"]);
    view.unmount();
    seed({ pane: "tags" });
    render(<OverviewSidebar {...sidebarGroups()} />);
    expect(headerNames()).toEqual(["Search tags…", "Create", "More"]);
  });

  it("⋯ on 筆記 sorts (remembered) and expands or collapses all", async () => {
    const props = sidebarGroups();
    render(<OverviewSidebar {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const menu = screen.getByRole("menu", { name: "More" });
    expect(within(menu).getAllByRole("menuitemradio").map((i) => i.textContent)).toEqual(["Order", "Modified", "Title", "Created date"]);
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Title" }));
    expect(getPref(PREFS.sidebarSort)).toBe("title");
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitemradio", { name: "Title" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("menuitem", { name: "Expand all" }));
    expect(props.tree.expandAll).toHaveBeenCalled();
  });

  it("⋯ on 標籤 sorts by note count or name (remembered) and expands or collapses the tag tree", async () => {
    setPref(PREFS.sidebarPane, "tags");
    resetAppState({
      data: { ...noWorkspaceData, nodes: [note("a", "a", { label_tag_ids: ["t-z"] })], tags: [tag("t-a", "apple"), tag("t-z", "zebra"), tag("t-k", "kid", { parent_id: "t-a" })], actor_is_owner: true },
      online: true, overviewPane: "tags",
    });
    render(<OverviewSidebar {...sidebarGroups()} />);
    const labels = () => [...document.querySelectorAll(".sb-tagtree-list .sb-tagtree-label")].map((el) => el.textContent);
    expect(labels()).toEqual(["zebra", "apple"]);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getAllByRole("menuitemradio").map((i) => i.textContent)).toEqual(["Note count", "Name"]);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Name" }));
    expect(getPref(PREFS.sidebarTagSort)).toBe("name");
    expect(labels()).toEqual(["apple", "zebra"]);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Expand all" }));
    expect(labels()).toEqual(["apple", "kid", "zebra"]);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Collapse all" }));
    expect(labels()).toEqual(["apple", "zebra"]);
    expect(screen.queryByRole("menuitem", { name: "Where new notes go…" })).toBeNull();
  });
});

describe("creating a task from the ＋ (the one create entry)", () => {
  const params = () => ({
    data: { nodes: [] } as never, createNodeRaw: vi.fn(async () => null), refresh: vi.fn(), draftTitle: "", setCreateOpen: vi.fn(),
    activeCanvas: null, addToActiveCanvas: vi.fn(), setSelectedId: vi.fn(), setMode: vi.fn(), openNote: vi.fn(), openNewTag: vi.fn(),
  });
  beforeEach(() => openQuickAddTask.mockReset());

  it("opens the quick-add with the open note as where it goes, and makes no note", async () => {
    resetAppState({ data: { ...noWorkspaceData, nodes: [note("n1", "Roadmap", { space_id: "sp1" })] }, online: true, selectedId: "n1" });
    const p = params();
    expect(await useNodeCreation(p).create("task")).toBeNull();
    expect(openQuickAddTask).toHaveBeenCalledWith({ id: "n1", title: "Roadmap", spaceId: "sp1" });
    expect(p.openNote).not.toHaveBeenCalled();
  });

  it("opens it plain when no note is open", async () => {
    resetAppState({ data: { ...noWorkspaceData, nodes: NOTES }, online: true });
    await useNodeCreation(params()).create("task");
    expect(openQuickAddTask).toHaveBeenCalledWith(undefined);
  });
});

describe("creating a tag under a tag (the one create entry)", () => {
  it("posts the tag with its parent and opens it", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
      requests.push({ url: String(url), body: typeof init.body === "string" ? JSON.parse(init.body) : {} });
      return new Response(JSON.stringify({}), { status: 201 });
    }));
    const params = {
      data: { nodes: [] } as never, createNodeRaw: vi.fn(async () => null), refresh: vi.fn(), draftTitle: "", setCreateOpen: vi.fn(),
      activeCanvas: null, addToActiveCanvas: vi.fn(), setSelectedId: vi.fn(), setMode: vi.fn(), openNote: vi.fn(), openNewTag: vi.fn(),
    };
    const id = await useNodeCreation(params).create("tag", { parentId: "t-proj", name: "ideas" });
    vi.unstubAllGlobals();
    expect(id).toBeTruthy();
    const post = requests.find((r) => r.url.endsWith("/api/tags"))!;
    expect(post.body).toMatchObject({ name: "ideas", parent_id: "t-proj" });
    expect(getAppState().data.tags?.find((t) => t.id === id)?.parent_id).toBe("t-proj");
    expect(params.openNewTag).toHaveBeenCalledWith(id);
  });

  it("makes nothing without a name", async () => {
    const params = {
      data: { nodes: [] } as never, createNodeRaw: vi.fn(async () => null), refresh: vi.fn(), draftTitle: "", setCreateOpen: vi.fn(),
      activeCanvas: null, addToActiveCanvas: vi.fn(), setSelectedId: vi.fn(), setMode: vi.fn(), openNote: vi.fn(), openNewTag: vi.fn(),
    };
    expect(await useNodeCreation(params).create("tag", { parentId: null })).toBeNull();
    expect(params.openNewTag).not.toHaveBeenCalled();
  });
});

const space = (id: string, name: string, over: Partial<Space> = {}): Space => ({
  id, name, kind: "shared", is_default: false, owner_actor_id: null, capabilities: {}, permission: "edit", can_manage: false, ...over,
});
const PERSONAL = space("sp-me", "me", { kind: "personal", can_manage: true });
const SHARED = space("sp-shared", "Shared", { is_default: true });
const WEB = space("sp-web", "Website");
const READ_ONLY = space("sp-read", "Read only", { permission: "view" });
const SYSTEM = space("sp-sys", "System", { kind: "system" });

async function loadSpaces(spaces: Space[]) {
  vi.spyOn(reads.people, "spaces").mockResolvedValue({ spaces } as never);
  await refreshSpaces();
}

const withNotes = () => resetAppState({
  data: { ...noWorkspaceData, nodes: [note("n1", "Roadmap", { space_id: "sp-shared" }), note("n2", "Sketch", { space_id: "sp-me" })], tags: [], actor_is_owner: true },
  online: true,
});

describe("放在: one row, one picker grouped by space", () => {
  beforeEach(() => { resetSpacesForTest(); });
  afterEach(() => { vi.restoreAllMocks(); resetSpacesForTest(); });

  it("is a single row with the space and place, no separate space button or hint", async () => {
    await loadSpaces([SHARED, READ_ONLY, SYSTEM, WEB, PERSONAL]);
    render(<OverviewSidebar {...sidebarGroups()} />);
    const sheet = await openSheet();
    expect(sheet.querySelectorAll(".create-sheet-place")).toHaveLength(1);
    expect(placeButton(sheet).textContent).toBe("Put it inOnly me › Top level");
    expect(within(sheet).queryByRole("button", { name: "Choose a space" })).toBeNull();
    expect(within(sheet).queryByText("Quick capture files new notes here too.")).toBeNull();
    expect(within(sheet).queryByRole("combobox")).toBeNull();
  });

  it("opens a picker with a group per writable space, personal first, each starting with 最上層", async () => {
    await loadSpaces([SHARED, READ_ONLY, SYSTEM, WEB, PERSONAL]);
    withNotes();
    render(<OverviewSidebar {...sidebarGroups()} />);
    const sheet = await openSheet();
    fireEvent.click(placeButton(sheet));
    expect(headings(sheet)).toEqual(["Only me", "Everyone", "Website"]);
    expect(optionLabels(sheet)).toEqual(["Top level", "Sketch", "Top level", "Roadmap", "Top level"]);
    // Create mode: no "now in" line; the current place is checked, not disabled.
    expect(sheet.querySelector(".place-picker-where")).toBeNull();
    const here = within(sheet).getAllByRole("option", { current: "location" });
    expect(here).toHaveLength(1);
    expect(here[0]).toHaveTextContent("Top level");
    expect(here[0]).not.toHaveAttribute("aria-disabled");
    expect(within(sheet).queryByText("Quick capture files new notes here too.")).toBeNull();
  });

  it("a note in another space picks that space too; the row shows both", async () => {
    await loadSpaces([PERSONAL, SHARED]);
    withNotes();
    setPref(PREFS.quickCaptureTarget, "n2");
    const props = sidebarGroups();
    render(<OverviewSidebar {...props} />);
    const sheet = await openSheet();
    expect(placeButton(sheet)).toHaveTextContent("Only me › Sketch");
    fireEvent.click(placeButton(sheet));
    pickOption(sheet, "Roadmap");
    // Picking closes the picker and is remembered for the next ＋.
    expect(within(sheet).queryByRole("combobox")).toBeNull();
    expect(getPref(PREFS.quickCaptureTarget)).toBe("n1");
    expect(placeButton(sheet)).toHaveTextContent("Everyone › Roadmap");
    fireEvent.click(within(sheet).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(props.create).toHaveBeenCalledWith("note", { parentId: "n1" }));
  });

  it("picking another space's 最上層 remembers the space and sends it", async () => {
    await loadSpaces([PERSONAL, SHARED, WEB]);
    const props = sidebarGroups();
    render(<OverviewSidebar {...props} />);
    const sheet = await openSheet();
    fireEvent.click(placeButton(sheet));
    pickOption(sheet, "Top level", 2);
    expect(getPref(PREFS.quickCaptureTarget)).toBe("space:sp-web");
    expect(placeButton(sheet)).toHaveTextContent("Website › Top level");
    fireEvent.click(within(sheet).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(props.create).toHaveBeenCalledWith("note", { parentId: null, spaceId: "sp-web" }));
  });

  it("picking the personal space's 最上層 clears the remembered choice", async () => {
    await loadSpaces([PERSONAL, SHARED]);
    setPref(PREFS.quickCaptureTarget, "space:sp-shared");
    render(<OverviewSidebar {...sidebarGroups()} />);
    const sheet = await openSheet();
    expect(placeButton(sheet)).toHaveTextContent("Everyone › Top level");
    fireEvent.click(placeButton(sheet));
    pickOption(sheet, "Top level", 0);
    expect(getPref(PREFS.quickCaptureTarget)).toBeFalsy();
    expect(placeButton(sheet)).toHaveTextContent("Only me › Top level");
  });

  it("a top-level note sends its space, the personal one too", async () => {
    await loadSpaces([PERSONAL, SHARED]);
    const props = sidebarGroups();
    render(<OverviewSidebar {...props} />);
    fireEvent.click(within(await openSheet()).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(props.create).toHaveBeenCalledWith("note", { parentId: null, spaceId: "sp-me" }));
  });

  it("a remembered space that is gone or no longer writable falls back to the personal space", async () => {
    setPref(PREFS.quickCaptureTarget, "space:sp-web");
    await loadSpaces([PERSONAL, SHARED, { ...WEB, permission: "view" }]);
    const props = sidebarGroups();
    render(<OverviewSidebar {...props} />);
    const sheet = await openSheet();
    expect(placeButton(sheet)).toHaveTextContent("Only me › Top level");
    fireEvent.click(within(sheet).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(props.create).toHaveBeenCalledWith("note", { parentId: null, spaceId: "sp-me" }));
  });

  it("names no space with one writable space or before the list loads, and lists every note in one group", async () => {
    await loadSpaces([PERSONAL, READ_ONLY, SYSTEM]);
    withNotes();
    const view = render(<OverviewSidebar {...sidebarGroups()} />);
    let sheet = await openSheet();
    expect(placeButton(sheet).textContent).toBe("Put it inTop level");
    fireEvent.click(placeButton(sheet));
    expect(headings(sheet)).toEqual([]);
    expect(optionLabels(sheet)).toEqual(["Top level", "Roadmap", "Sketch"]);
    view.unmount();
    resetSpacesForTest();
    render(<OverviewSidebar {...sidebarGroups()} />);
    sheet = await openSheet();
    expect(placeButton(sheet).textContent).toBe("Put it inTop level");
  });

  it("Esc and 返回 close the picker without closing the sheet", async () => {
    await loadSpaces([PERSONAL, SHARED]);
    render(<OverviewSidebar {...sidebarGroups()} />);
    const sheet = await openSheet();
    fireEvent.click(placeButton(sheet));
    fireEvent.keyDown(within(sheet).getByRole("combobox"), { key: "Escape" });
    expect(within(sheet).queryByRole("combobox")).toBeNull();
    expect(await findSheet()).toBeInTheDocument();
    fireEvent.click(placeButton(sheet));
    fireEvent.click(within(sheet).getByRole("button", { name: "Back" }));
    expect(within(sheet).queryByRole("combobox")).toBeNull();
  });

  it("the tag sheet uses the same picker with one group and no space", async () => {
    await loadSpaces([PERSONAL, SHARED]);
    seed({ pane: "tags" });
    render(<OverviewSidebar {...sidebarGroups()} />);
    const sheet = await openSheet();
    fireEvent.click(placeButton(sheet));
    expect(headings(sheet)).toEqual([]);
    expect(optionLabels(sheet)[0]).toBe("Top level");
    expect(within(sheet).getByRole("combobox", { name: "Search tags…" })).toBeInTheDocument();
  });
});
