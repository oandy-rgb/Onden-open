import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import OverviewSidebar from "../components/OverviewSidebar";
import { noWorkspaceData, type ContentNode, type Tag } from "../lib/api";
import { consumeSidebarTagsFocus, focusSidebarTags, getAppState, resetAppState } from "../lib/appStore";
import { bindAccountStorage } from "../lib/accountStorage";
import { sidebarTagsStore } from "../lib/sidebarTagsStore";
import { noteWriter, nodeActions } from "../lib/data";
import { PREFS, setPref } from "../lib/prefs";
import { sidebarGroups } from "./fixtures/sidebarGroups";

// The desktop sidebar: the notes tree on top and the collapsible 標籤 section
// under it — the same tree component as the phone's tab (SidebarTagTree).
// The account's pins and hidden tags go to the server as one small preference
// (a fake server below); nothing here needs a network.

vi.mock("../lib/localDb", () => ({ searchNodes: vi.fn(async () => []) }));
let serverPrefs: Record<string, unknown> = {};
vi.mock("../lib/data/onlineWrite", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/data/onlineWrite")>(),
  sendWrite: vi.fn(async (_method: string, path: string, body: { value: unknown }) => { serverPrefs[path.split("/").pop()!] = body.value; return { value: body.value }; }),
}));
vi.mock("../lib/data/reads", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/data/reads")>();
  return { ...real, reads: { ...real.reads, people: { ...real.reads.people, myPref: vi.fn(async (key: string) => ({ value: serverPrefs[key] ?? null })) } } };
});

const note = (id: string, title: string, over: Partial<ContentNode> = {}): ContentNode => ({
  id, title, slug: id, markdown: "", node_type: "content", source_type: "manual", ...over,
});
const tag = (id: string, name: string, over: Partial<Tag> = {}): Tag => ({ id, name, color: "", schema_id: null, ...over });

const PROJ = tag("t-proj", "proj");
const DRAFT = tag("t-draft", "draft", { parent_id: "t-proj" });
const SOLO = tag("t-solo", "solo");
const BIG = tag("t-big", "big", { color: "#b77973" });
const nodes = [
  note("n1", "Roadmap", { label_tag_ids: ["t-proj"] }),
  note("n2", "Sketch", { label_tag_ids: ["t-draft"] }),
  note("n3", "Another sketch", { label_tag_ids: ["t-draft"] }),
  note("n4", "Plain"),
];

function seed(owner = true, tags = [PROJ, DRAFT, SOLO, BIG]) {
  resetAppState({ data: { ...noWorkspaceData, actor_is_owner: owner, nodes, tags }, online: true });
}
function viewport(phone: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: phone && query.includes("max-width: 900px"), media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}
const originalMatchMedia = window.matchMedia;
beforeEach(() => {
  localStorage.clear(); serverPrefs = {};
  bindAccountStorage("unit-test-account", "");
  viewport(false); seed();
  // jsdom has no layout: the sidebar scrolls the open row into view.
  Element.prototype.scrollIntoView = vi.fn();
  // The account's pins and hidden tags outlive a test: start each with none.
  sidebarTagsStore.save(null);
});
afterEach(() => { window.matchMedia = originalMatchMedia; vi.restoreAllMocks(); resetAppState(); localStorage.clear(); });

const section = () => document.querySelector<HTMLElement>(".sb-tagtree--section")!;
const names = () => [...section().querySelectorAll(".sb-tagtree-list > li .sb-tagtree-label")].map((el) => el.textContent);
const rightClick = (name: string) => {
  const row = within(section()).getByRole("button", { name });
  fireEvent.pointerDown(row, { button: 2 });
  fireEvent.contextMenu(row);
};
const menuItems = () => screen.getAllByRole("menuitem").map((el) => el.textContent);

describe("desktop layout", () => {
  it("is the notes tree with the 標籤 section under it: no tag tab, no chip row", () => {
    const { container } = render(<OverviewSidebar {...sidebarGroups()} />);
    expect([...container.querySelectorAll(".sidebar-tab")].map((el) => el.textContent?.trim())).toEqual(["Notes", "Inbox"]);
    expect(container.querySelector(".sidebar-tag-panel, .sidebar-tag-chip")).toBeNull();
    const list = container.querySelector(".obsidian-page-list")!;
    expect(list.textContent).toContain("Roadmap");
    expect(list.textContent).not.toContain("proj");
    // The section comes after the notes list.
    expect(list.compareDocumentPosition(section()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(section()).getByRole("button", { name: "Tags" })).toHaveAttribute("aria-expanded", "true");
    expect(names()).toEqual(["proj", "big", "solo"]);
  });

  it("is the tree the phone's 標籤 tab shows: same rows, same menu", () => {
    const wide = render(<OverviewSidebar {...sidebarGroups()} />);
    // (Only the computer lets a mouse drag a tag.)
    const rows = (root: ParentNode) => [...root.querySelectorAll(".sb-tagtree-item")].map((el) => el.outerHTML.replace(" draggable=\"true\"", ""));
    const desktopRows = rows(section());
    wide.unmount();
    viewport(true);
    resetAppState({ data: { ...noWorkspaceData, actor_is_owner: true, nodes, tags: [PROJ, DRAFT, SOLO, BIG] }, online: true, overviewPane: "tags" });
    const narrow = render(<OverviewSidebar {...sidebarGroups()} />);
    const phoneRows = rows(narrow.container);
    expect(phoneRows).toEqual(desktopRows);
    expect(narrow.container.querySelector(".sb-tagtree--section")).toBeNull();
  });
});

describe("the unused-tags line", () => {
  it("sits below the scrolling tag list, so opening its list never moves the used tags out of the scroll box", () => {
    render(<OverviewSidebar {...sidebarGroups()} />);
    const scroller = section().querySelector(".sb-tagtree-scroll")!;
    // The used tags are in the scroll box; the line and its list are outside it.
    expect(scroller.querySelector(".sb-tagtree-list")).not.toBeNull();
    const line = section().querySelector(".tag-tidy")!;
    expect(scroller.contains(line)).toBe(false);
    fireEvent.click(within(line as HTMLElement).getByRole("button", { name: "Show the list" }));
    expect(scroller.contains(section().querySelector(".tag-tidy-body"))).toBe(false);
    expect(names()).toEqual(["proj", "big", "solo"]);
  });
});

describe("the section header", () => {
  it("folds the list, and open or closed is remembered on this device", () => {
    const first = render(<OverviewSidebar {...sidebarGroups()} />);
    fireEvent.click(within(section()).getByRole("button", { name: "Tags" }));
    expect(within(section()).getByRole("button", { name: "Tags" })).toHaveAttribute("aria-expanded", "false");
    expect(names()).toEqual([]);
    first.unmount();
    render(<OverviewSidebar {...sidebarGroups()} />);
    expect(within(section()).getByRole("button", { name: "Tags" })).toHaveAttribute("aria-expanded", "false");
    expect(names()).toEqual([]);
    fireEvent.click(within(section()).getByRole("button", { name: "Tags" }));
    expect(names()).toEqual(["proj", "big", "solo"]);
  });

  it("「前往標籤」 opens a folded section and focuses it once", () => {
    localStorage.setItem("onden.sidebar.tagsOpen", "0");
    render(<OverviewSidebar {...sidebarGroups()} />);
    expect(names()).toEqual([]);
    act(() => focusSidebarTags());
    expect(names()).toEqual(["proj", "big", "solo"]);
    expect(document.activeElement).toBe(within(section()).getByRole("button", { name: "Open #proj" }));
    expect(consumeSidebarTagsFocus()).toBe(false);
  });

  it("+ names a new tag and hands it to the shell's creator", async () => {
    const create = vi.fn(async () => {});
    render(<OverviewSidebar {...sidebarGroups()} onCreateTag={create} />);
    fireEvent.click(within(section()).getByRole("button", { name: "New tag" }));
    const field = screen.getByRole("textbox", { name: "New tag name…" });
    fireEvent.change(field, { target: { value: "ideas" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(create).toHaveBeenCalledWith("ideas"));
  });
});

describe("rows and clicks", () => {
  it("clicking a name opens the tag's page and highlights its row; ▸ only opens sub-tags; the notes tree is not filtered", () => {
    const props = sidebarGroups();
    const { rerender } = render(<OverviewSidebar {...props} />);
    fireEvent.click(within(section()).getByRole("button", { name: "Open #proj" }));
    expect(props.nav.openTag).toHaveBeenCalledWith("t-proj");
    fireEvent.click(within(section()).getByRole("button", { name: "Show sub-tags of #proj" }));
    expect(props.nav.openTag).toHaveBeenCalledTimes(1);
    expect(names()).toEqual(["proj", "draft", "big", "solo"]);
    act(() => resetAppState({ data: getAppState().data, online: true, selectedId: "t-proj" }));
    rerender(<OverviewSidebar {...props} />);
    expect(within(section()).getByRole("button", { name: "Open #proj" })).toHaveAttribute("aria-current", "page");
    expect(document.querySelector(".obsidian-page-list")!.textContent).toMatch(/Roadmap[\s\S]*Plain/);
  });

  it("orders pinned first, then by note count (children the same), ties by name", async () => {
    render(<OverviewSidebar {...sidebarGroups()} />);
    expect(names()).toEqual(["proj", "big", "solo"]);
    rightClick("Open #solo");
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin to top" }));
    expect(names()).toEqual(["solo", "proj", "big"]);
    expect(section().querySelector("[data-pinned]")?.textContent).toContain("solo");
  });
});

describe("the row menu", () => {
  it("offers pin, hide, rename and delete to the owner, and only pin and hide to anyone else", () => {
    render(<OverviewSidebar {...sidebarGroups()} />);
    rightClick("Open #solo");
    expect(menuItems()).toEqual(["New inside ▸", "Pin to top", "Hide from sidebar", "Rename", "Delete tag"]);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    document.body.click();
    seed(false);
    cleanupMenus();
    rightClick("Open #solo");
    expect(menuItems()).toEqual(["Pin to top", "Hide from sidebar"]);
  });

  it("a long press opens the same menu", () => {
    vi.useFakeTimers();
    try {
      render(<OverviewSidebar {...sidebarGroups()} />);
      fireEvent.pointerDown(within(section()).getByRole("button", { name: "Open #solo" }), { button: 0 });
      act(() => { vi.advanceTimersByTime(700); });
      expect(menuItems()).toContain("Pin to top");
    } finally { vi.useRealTimers(); }
  });

  it("hiding leaves a tag out of the list only; the quiet last line brings hidden ones back and 在側欄顯示 restores", () => {
    const props = sidebarGroups();
    render(<OverviewSidebar {...props} />);
    expect(screen.queryByRole("button", { name: /hidden tag/ })).toBeNull();
    rightClick("Open #solo");
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide from sidebar" }));
    expect(names()).toEqual(["proj", "big"]);
    // Still a tag everywhere else: it is in the catalog and its page opens.
    expect(getAppState().data.tags?.some((row) => row.id === "t-solo" && !row.hidden)).toBe(true);
    const line = within(section()).getByRole("button", { name: "1 more hidden tag" });
    // The collapsed 整理 line closes the section, below the scrolling list that ends with the hidden-tags line.
    const tidy = within(section()).getByRole("region", { name: "Tidy up" });
    expect(line.parentElement!.nextElementSibling).toBe(tidy);
    expect(section().lastElementChild).toBe(tidy);
    fireEvent.click(line);
    expect(names()).toEqual(["proj", "big", "solo"]);
    expect(section().querySelector('[data-sidebar-hidden="true"]')?.textContent).toContain("solo");
    fireEvent.click(within(section()).getByRole("button", { name: "Open #solo" }));
    expect(props.nav.openTag).toHaveBeenCalledWith("t-solo");
    rightClick("Open #solo");
    fireEvent.click(screen.getByRole("menuitem", { name: "Show in sidebar" }));
    expect(within(section()).queryByRole("button", { name: /hidden tag/ })).toBeNull();
    expect(names()).toEqual(["proj", "big", "solo"]);
    expect(section().querySelector("[data-sidebar-hidden]")).toBeNull();
  });

  it("hiding a tag takes its sub-tags with it", () => {
    render(<OverviewSidebar {...sidebarGroups()} />);
    rightClick("Open #proj");
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide from sidebar" }));
    expect(names()).toEqual(["big", "solo"]);
    expect(within(section()).getByRole("button", { name: "2 more hidden tags" })).toBeInTheDocument();
  });

  it("rename starts the sidebar's rename; delete asks first", async () => {
    const props = sidebarGroups();
    const { reads } = await import("../lib/data");
    vi.spyOn(reads.tags, "deletePreview").mockResolvedValue({ members: 0, sample_titles: [], fields: [], views: 0, has_behaviour: false, reversible: true } as never);
    const del = vi.spyOn(nodeActions, "delete").mockResolvedValue(true);
    render(<OverviewSidebar {...props} />);
    rightClick("Open #solo");
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(props.rename.setNodeId).toHaveBeenCalledWith("t-solo");
    rightClick("Open #solo");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete tag" }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete #solo" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("t-solo", "solo"));
  });

  it("a tag the owner hid for everyone shows only in the hidden line, where the owner can unhide it", async () => {
    const { tagWriter } = await import("../lib/data");
    const setHidden = vi.spyOn(tagWriter, "setHidden").mockResolvedValue({ queued: false });
    seed(true, [PROJ, tag("t-secret", "secret", { hidden: true })]);
    render(<OverviewSidebar {...sidebarGroups()} />);
    expect(names()).toEqual(["proj"]);
    fireEvent.click(within(section()).getByRole("button", { name: "1 more hidden tag" }));
    expect(names()).toEqual(["proj", "secret"]);
    rightClick("Open #secret");
    fireEvent.click(screen.getByRole("menuitem", { name: "Unhide tag" }));
    expect(setHidden).toHaveBeenCalledWith("t-secret", false);
  });
});

describe("pins and hidden tags follow the account", () => {
  it("are sent to the server as one preference", async () => {
    render(<OverviewSidebar {...sidebarGroups()} />);
    rightClick("Open #solo");
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin to top" }));
    rightClick("Open #big");
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide from sidebar" }));
    await waitFor(() => expect(serverPrefs.sidebarTags).toEqual({ pinned: ["t-solo"], hidden: ["t-big"] }));
  });

  it("are read back from the server on another device: phone and desktop show the same list", async () => {
    await act(async () => { await sidebarTagsStore.sync(); });
    serverPrefs.sidebarTags = { pinned: ["t-big"], hidden: ["t-solo"] };
    await act(async () => { await sidebarTagsStore.sync(); });
    const wide = render(<OverviewSidebar {...sidebarGroups()} />);
    expect(names()).toEqual(["big", "proj"]);
    expect(within(section()).getByRole("button", { name: "1 more hidden tag" })).toBeInTheDocument();
    wide.unmount();
    viewport(true);
    resetAppState({ data: { ...noWorkspaceData, actor_is_owner: true, nodes, tags: [PROJ, DRAFT, SOLO, BIG] }, online: true, overviewPane: "tags" });
    render(<OverviewSidebar {...sidebarGroups()} />);
    expect([...document.querySelectorAll(".sb-tagtree-list > li .sb-tagtree-label")].map((el) => el.textContent)).toEqual(["big", "proj"]);
  });

  it("an old device-local pin list is moved into the account once, when the account has none", async () => {
    setPref(PREFS.pinnedTagViews, "t-big,t-solo");
    render(<OverviewSidebar {...sidebarGroups()} />);
    await waitFor(() => expect(serverPrefs.sidebarTags).toEqual({ pinned: ["t-big", "t-solo"], hidden: [] }));
    expect(names()).toEqual(["big", "solo", "proj"]);
  });

  it("rejects anything that is not a list of ids", async () => {
    const { parseSidebarTags } = await import("../lib/sidebarTagsStore");
    expect(parseSidebarTags({ pinned: ["a", "a"], hidden: [] })).toEqual({ pinned: ["a"], hidden: [] });
    for (const bad of [null, "x", { pinned: "a", hidden: [] }, { pinned: [1], hidden: [] }, { pinned: [] }]) expect(parseSidebarTags(bad)).toBeNull();
  });
});

describe("keyboard", () => {
  it("arrows walk the rows across the notes tree and the tag section", () => {
    render(<OverviewSidebar {...sidebarGroups()} />);
    const plain = screen.getByRole("button", { name: "Plain" });
    plain.focus();
    fireEvent.keyDown(plain, { key: "ArrowDown" });
    expect(document.activeElement).toBe(within(section()).getByRole("button", { name: "Tags" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(within(section()).getByRole("button", { name: "Open #proj" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(within(section()).getByRole("button", { name: "Open #big" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(plain);
  });

  it("Right opens and Left closes a tag's sub-tags; on the header they open and close the section", () => {
    render(<OverviewSidebar {...sidebarGroups()} />);
    const proj = within(section()).getByRole("button", { name: "Open #proj" });
    fireEvent.keyDown(proj, { key: "ArrowRight" });
    expect(names()).toEqual(["proj", "draft", "big", "solo"]);
    fireEvent.keyDown(proj, { key: "ArrowLeft" });
    expect(names()).toEqual(["proj", "big", "solo"]);
    const header = within(section()).getByRole("button", { name: "Tags" });
    fireEvent.keyDown(header, { key: "ArrowLeft" });
    expect(names()).toEqual([]);
    fireEvent.keyDown(header, { key: "ArrowRight" });
    expect(names()).toEqual(["proj", "big", "solo"]);
  });

  it("Enter on a row opens it (a native button press)", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const props = sidebarGroups();
    render(<OverviewSidebar {...props} />);
    within(section()).getByRole("button", { name: "Open #solo" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(props.nav.openTag).toHaveBeenCalledWith("t-solo");
  });
});

describe("dragging a tag onto another tag", () => {
  const dt = () => ({ setData: vi.fn(), effectAllowed: "", dropEffect: "" });
  const drag = (from: string, to: string) => {
    const source = within(section()).getByRole("button", { name: `Open #${from}` }).closest("li")!;
    const target = within(section()).getByRole("button", { name: `Open #${to}` }).closest("li")!;
    const dataTransfer = dt();
    fireEvent.dragStart(source, { dataTransfer });
    const over = fireEvent.dragOver(target, { dataTransfer });
    return { source, target, dataTransfer, accepted: !over };
  };

  it("asks first, then MOVES the tag under the other (one parent), and keeps it if cancelled", async () => {
    const patch = vi.spyOn(noteWriter, "patch").mockResolvedValue(undefined as never);
    render(<OverviewSidebar {...sidebarGroups()} />);
    const { target } = drag("solo", "big");
    expect(target).toHaveAttribute("data-tag-drop");
    fireEvent.drop(target, { dataTransfer: dt() });
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Move #solo under #big?");
    expect(patch).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(patch).not.toHaveBeenCalled();
    drag("solo", "big");
    fireEvent.drop(within(section()).getByRole("button", { name: "Open #big" }).closest("li")!, { dataTransfer: dt() });
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("t-solo", { parent_id: "t-big" }));
  });

  it("refuses a cycle, itself and the parent it already has: no highlight, no dialog", () => {
    render(<OverviewSidebar {...sidebarGroups()} />);
    fireEvent.click(within(section()).getByRole("button", { name: "Show sub-tags of #proj" }));
    for (const [from, to] of [["proj", "draft"], ["proj", "proj"], ["draft", "proj"]] as const) {
      const { target, accepted } = drag(from, to);
      expect(accepted).toBe(false);
      expect(target).not.toHaveAttribute("data-tag-drop");
      fireEvent.drop(target, { dataTransfer: dt() });
      expect(screen.queryByRole("alertdialog")).toBeNull();
    }
  });

  it("only the owner can drag a tag; the phone has no tag dragging", () => {
    seed(false);
    const { unmount } = render(<OverviewSidebar {...sidebarGroups()} />);
    expect(within(section()).getByRole("button", { name: "Open #solo" }).closest("li")).not.toHaveAttribute("draggable");
    unmount();
    seed(true);
    render(<OverviewSidebar {...sidebarGroups()} />);
    expect(within(section()).getByRole("button", { name: "Open #solo" }).closest("li")).toHaveAttribute("draggable", "true");
  });
});

describe("a note held over a row", () => {
  it("highlights the row the drag names (tree.tagDropId)", () => {
    render(<OverviewSidebar {...sidebarGroups({ tree: { tagDropId: "t-solo" } })} />);
    expect(within(section()).getByRole("button", { name: "Open #solo" }).closest("li")).toHaveAttribute("data-note-drop");
    expect(within(section()).getByRole("button", { name: "Open #big" }).closest("li")).not.toHaveAttribute("data-note-drop");
  });
});

// Close any open row menu between two renders of one test.
function cleanupMenus() {
  for (const menu of screen.queryAllByRole("menu")) menu.remove();
}
