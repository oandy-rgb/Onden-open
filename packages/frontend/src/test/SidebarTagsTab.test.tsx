import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import OverviewSidebar from "../components/OverviewSidebar";
import { type ContentNode, type Tag } from "../lib/api";
import { resetAppState, getAppState } from "../lib/appStore";
import { bindAccountStorage } from "../lib/accountStorage";
import { sidebarTagsStore } from "../lib/sidebarTagsStore";
import { sidebarGroups } from "./fixtures/sidebarGroups";
import { ownerData } from "./ownerData";

vi.mock("../lib/localDb", () => ({ searchNodes: vi.fn(async () => []) }));

const note = (id: string, title: string, over: Partial<ContentNode> = {}): ContentNode => ({
  id, title, slug: id, markdown: "", node_type: "content", source_type: "manual", ...over,
});
const tag = (id: string, name: string, over: Partial<Tag> = {}): Tag => ({ id, name, color: "", schema_id: null, ...over });

const PROJ = tag("t-proj", "proj");
const DRAFT = tag("t-draft", "draft", { parent_id: "t-proj" });
const SOLO = tag("t-solo", "solo");
const nodes = [
  note("n1", "Roadmap", { label_tag_ids: ["t-proj"] }),
  note("n2", "Sketch", { label_tag_ids: ["t-draft"] }),
  note("n3", "Another sketch", { label_tag_ids: ["t-draft"] }),
  note("n4", "Plain"),
  // A tag node in the notes data: it must not show as a row of the notes tree.
  note("t-solo", "solo", { node_type: "class_tag" }),
];

function seed() {
  resetAppState({ data: { ...ownerData, nodes, tags: [PROJ, DRAFT, SOLO] }, online: true });
}

function phone(matches: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: matches && query.includes("max-width: 900px"), media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

const originalMatchMedia = window.matchMedia;
// The pinned and hidden tags are the account's (lib/sidebarTagsStore) and outlive a test: start each with none.
beforeEach(() => { localStorage.clear(); bindAccountStorage("unit-test-account", ""); phone(true); seed(); sidebarTagsStore.save(null); });
afterEach(() => { window.matchMedia = originalMatchMedia; resetAppState(); localStorage.clear(); });

const tabs = () => [...document.querySelectorAll(".sidebar-tab")].map((el) => el.textContent?.trim());
const activeTab = () => document.querySelector(".sidebar-tab.active")?.textContent?.trim();

describe("phone Notes home: 標籤 | 筆記 | 收件匣", () => {
  it("shows the tabs in that order with 筆記 selected by default", () => {
    render(<OverviewSidebar {...sidebarGroups()} />);
    expect(tabs()).toEqual(["Tags", "Notes", "Inbox"]);
    expect(activeTab()).toBe("Notes");
  });

  it("has no 標籤 tab on a wide screen, where the 標籤 section stays under the notes", () => {
    phone(false);
    const { container } = render(<OverviewSidebar {...sidebarGroups()} />);
    expect(tabs()).toEqual(["Notes", "Inbox"]);
    expect(container.querySelector(".sb-tagtree--section")).not.toBeNull();
    expect(container.querySelector(".sidebar-tag-panel")).toBeNull();
  });

  it("the phone's notes tab carries no tag block, and tag nodes are not rows of the notes tree", () => {
    const { container } = render(<OverviewSidebar {...sidebarGroups()} />);
    expect(container.querySelector(".sidebar-tag-panel")).toBeNull();
    expect(container.querySelector(".sb-tagtree")).toBeNull();
    const list = container.querySelector(".obsidian-page-list")!;
    expect(list.querySelector(".sb-tag-node")).toBeNull();
    expect(list.textContent).toContain("Roadmap");
    expect(list.textContent).not.toContain("solo");
  });

  it("the 標籤 tab lists only tags; ▸ opens child tags only; each row has its count", () => {
    const { container } = render(<OverviewSidebar {...sidebarGroups()} />);
    fireEvent.click(screen.getByRole("button", { name: "Tags" }));
    const list = screen.getByRole("list", { name: "Your tags" });
    const row = (name: string) => within(list).getByRole("button", { name: `Open #${name}` });
    expect(row("proj").textContent).toBe("#proj1");
    expect(row("solo").textContent).toBe("#solo0");
    // The child tag is folded; member notes are never listed.
    expect(within(list).queryByRole("button", { name: "Open #draft" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show sub-tags of #proj" }));
    expect(row("draft").textContent).toBe("#draft2");
    expect(container.querySelector(".obsidian-page-list")!.textContent).not.toMatch(/Roadmap|Sketch|Plain/);
    fireEvent.click(screen.getByRole("button", { name: "Hide sub-tags of #proj" }));
    expect(within(list).queryByRole("button", { name: "Open #draft" })).toBeNull();
  });

  it("tapping a tag name opens that tag's page", () => {
    const props = sidebarGroups();
    render(<OverviewSidebar {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Tags" }));
    fireEvent.click(screen.getByRole("button", { name: "Open #proj" }));
    expect(props.nav.openTag).toHaveBeenCalledWith("t-proj");
  });

  it("remembers the last tab on this device", () => {
    const first = render(<OverviewSidebar {...sidebarGroups()} />);
    fireEvent.click(screen.getByRole("button", { name: "Tags" }));
    first.unmount();
    // A fresh page load: the store starts at its default again.
    resetAppState({ data: { ...ownerData, nodes, tags: [PROJ, DRAFT, SOLO] }, online: true });
    render(<OverviewSidebar {...sidebarGroups()} />);
    expect(activeTab()).toBe("Tags");
    expect(getAppState().overviewPane).toBe("tags");
  });

  it("an unreadable stored tab falls back to 筆記", () => {
    localStorage.setItem("onden.sidebar.pane", "bogus");
    render(<OverviewSidebar {...sidebarGroups()} />);
    expect(activeTab()).toBe("Notes");
  });
});

describe("phone 標籤 tab: rows, order, long-press menu, filter", () => {
  const owner = () => resetAppState({
    data: { ...ownerData, actor_is_owner: true, nodes, tags: [PROJ, DRAFT, SOLO, tag("t-big", "big", { color: "#b77973" })] }, online: true,
  });
  const names = () => [...document.querySelectorAll(".sb-tagtree-list > li .sb-tagtree-label")].map((el) => el.textContent);
  const openTab = () => fireEvent.click(screen.getByRole("button", { name: "Tags" }));
  // A mouse right click: the press, then the contextmenu (a long press ends in the same menu).
  const rightClick = (name: string) => {
    const row = screen.getByRole("button", { name });
    fireEvent.pointerDown(row, { button: 2 });
    fireEvent.contextMenu(row);
  };

  it("a leaf's colour dot sits in the disclosure column, where a parent's ▸ is", () => {
    resetAppState({ data: { ...ownerData, nodes, tags: [SOLO, tag("t-big", "big", { color: "#b77973" })] }, online: true });
    render(<OverviewSidebar {...sidebarGroups()} />);
    openTab();
    const list = screen.getByRole("list", { name: "Your tags" });
    expect(list.querySelectorAll(".sb-tagtree-item-leaf")).toHaveLength(2);
    const leaf = within(list).getByRole("button", { name: "Open #big" }).closest("li")!;
    const dot = leaf.querySelector<HTMLElement>(".sb-tagtree-toggle .sb-tagtree-dot")!;
    expect(dot.style.getPropertyValue("--tag-color")).toBe("#b77973");
    // Rows are note rows: the same classes as the 筆記 tab.
    expect(leaf).toHaveClass("obsidian-page-row");
  });

  it("with sub-tags the leaves keep the column so names line up", () => {
    render(<OverviewSidebar {...sidebarGroups()} />);
    openTab();
    const list = screen.getByRole("list", { name: "Your tags" });
    expect(list).not.toHaveClass("sb-tagtree-list-flat");
    expect(list.querySelector(".sb-tagtree-item-leaf .sb-tagtree-toggle")).not.toBeNull();
  });

  it("orders pinned tags first (in pin order), then by note count, ties by name; children the same", () => {
    owner();
    localStorage.clear();
    render(<OverviewSidebar {...sidebarGroups()} />);
    openTab();
    // proj 1 note, solo 0, big 0 → proj, then big before solo (name).
    expect(names()).toEqual(["proj", "big", "solo"]);
  });

  it("long press / right click: 釘選到最上面 moves the tag up and 取消釘選 puts it back", () => {
    owner();
    render(<OverviewSidebar {...sidebarGroups()} />);
    openTab();
    rightClick("Open #solo");
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin to top" }));
    expect(names()).toEqual(["solo", "proj", "big"]);
    rightClick("Open #big");
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin to top" }));
    expect(names()).toEqual(["solo", "big", "proj"]);
    rightClick("Open #solo");
    fireEvent.click(screen.getByRole("menuitem", { name: "Unpin from top" }));
    expect(names()).toEqual(["big", "proj", "solo"]);
  });

  it("the menu's 重新命名 starts the sidebar's rename; 刪除 asks first and deletes only on confirm", async () => {
    owner();
    const props = sidebarGroups();
    const { reads, nodeActions } = await import("../lib/data");
    vi.spyOn(reads.tags, "deletePreview").mockResolvedValue({ members: 2, sample_titles: [], fields: [], views: 0, has_behaviour: false, reversible: true } as never);
    const del = vi.spyOn(nodeActions, "delete").mockResolvedValue(true);
    render(<OverviewSidebar {...props} />);
    openTab();
    rightClick("Open #solo");
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(props.rename.setNodeId).toHaveBeenCalledWith("t-solo");
    expect(props.rename.setDraft).toHaveBeenCalledWith("solo");

    rightClick("Open #solo");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete tag" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("Deleting #solo affects:");
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete #solo" }));
    await vi.waitFor(() => expect(del).toHaveBeenCalledWith("t-solo", "solo"));
  });

  it("a non-owner's menu pins and hides for themselves only; opening is still a plain tap", () => {
    resetAppState({ data: { ...ownerData, actor_is_owner: false, nodes, tags: [SOLO] }, online: true });
    render(<OverviewSidebar {...sidebarGroups()} />);
    openTab();
    rightClick("Open #solo");
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual(["Pin to top", "Hide from sidebar"]);
  });

  it("the ＋ and the filter sit in the tabs' row; the filter opens on demand and clears when closed", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => tag(`t${i}`, `tag${String(i).padStart(2, "0")}`));
    resetAppState({ data: { ...ownerData, nodes: [], tags: many(3) }, online: true, overviewPane: "tags" });
    const props = sidebarGroups();
    render(<OverviewSidebar {...props} onCreateTag={vi.fn()} />);
    const header = document.querySelector(".obsidian-sidebar-header")!;
    // No 「你的標籤」 heading above the list: the tools are in the header row.
    expect(document.querySelector(".sb-tagtree-heading")).toBeNull();
    // ＋ opens the create sheet; the tag-only ＋ of the old header is gone.
    expect(within(header as HTMLElement).getByRole("button", { name: "Create" })).toBeInTheDocument();
    expect(within(header as HTMLElement).queryByRole("button", { name: "New tag" })).toBeNull();
    expect(screen.queryByRole("searchbox", { name: "Search tags…" })).toBeNull();
    const toggle = within(header as HTMLElement).getByRole("button", { name: "Search tags…" });
    fireEvent.click(toggle);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tags…" }), { target: { value: "tag01" } });
    expect(names()).toEqual(["tag01"]);
    fireEvent.click(toggle);
    expect(screen.queryByRole("searchbox", { name: "Search tags…" })).toBeNull();
    expect(names()).toHaveLength(3);
  });

  it("has no 全部標籤 / 整理 notice in the list", () => {
    owner();
    render(<OverviewSidebar {...sidebarGroups()} />);
    openTab();
    expect(document.body.textContent).not.toMatch(/removed module|Tidy up/);
  });
});

describe("phone 標籤 tab: only your own tags", () => {
  const REVIEW = tag("m-review", "複習", { schema_module: "review", color: "#3a7" });
  const SKILLS = tag("m-skills", "技能", { schema_module: "skills" });
  const ENGLISH = tag("t-en", "英文", { schema_extends: ["m-review"] });
  const labels = (list: HTMLElement) => [...list.querySelectorAll(".sb-tagtree-label")].map((el) => el.textContent);
  const openTab = () => fireEvent.click(screen.getByRole("button", { name: "Tags" }));

  it("has no 功能 block, divider or #function row, even when a function is in use", () => {
    // 複習 is added by #英文 and carried by a note; 技能 is carried by a note: both in use.
    resetAppState({
      data: { ...ownerData, nodes: [...nodes, note("n9", "Later", { label_tag_ids: ["m-skills"] })], tags: [REVIEW, SKILLS, ENGLISH, PROJ, DRAFT] },
      online: true,
    });
    const { container } = render(<OverviewSidebar {...sidebarGroups()} />);
    openTab();
    expect(screen.queryByRole("list", { name: "Functions" })).toBeNull();
    expect(container.querySelector(".sb-tagtree-divider, .sb-tagtree-functions")).toBeNull();
    expect(labels(screen.getByRole("list", { name: "Your tags" }))).toEqual(["proj", "英文"]);
    expect(document.body.textContent).not.toMatch(/複習|技能/);
  });
});
