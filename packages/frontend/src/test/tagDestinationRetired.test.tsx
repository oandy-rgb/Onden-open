// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { useUiMode } from "../hooks/useUiMode";
import { arrangeNavigation, getMoreNavigationGroups } from "../hooks/shellNavigation";
import RemovedModuleTags from "../components/RemovedModuleTags";
import TagTidy from "../components/TagTidy";
import ModuleSettingsPage from "../settings/ModuleSettingsPage";
import ModulesSetting from "../settings/ModulesSetting";
import { noWorkspaceData, type Tag } from "../lib/api";
import { getAppState, resetAppState, setAppState } from "../lib/appStore";
import { nodeActions } from "../lib/data";
import { setLocalePref } from "../lib/i18n";

vi.mock("../components/ModuleLibrary", () => ({ default: () => <p>library</p> }));

function viewport(phone: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: phone && query.includes("max-width: 900px"), media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}
const originalMatchMedia = window.matchMedia;
beforeEach(() => { act(() => setLocalePref("en")); resetAppState(); });
afterEach(() => { window.matchMedia = originalMatchMedia; act(() => setLocalePref("system")); resetAppState(); });

describe("標籤 is no navigation destination", () => {
  const actions = { setMode: vi.fn(), onOpenModule: vi.fn(), onOpenFeature: vi.fn() };

  it("「前往標籤」 opens the notes home with the sidebar's tag list open and focused, on the phone and the desktop", () => {
    for (const phone of [true, false]) {
      viewport(phone);
      setAppState({ overviewPane: "nodes", sidebarTagsFocusPending: false });
      const { result, unmount } = renderHook(() => useUiMode("tasks"));
      act(() => result.current.showTags());
      expect(result.current.mode).toBe("notes");
      expect(result.current.overviewMobileTab).toBe("list");
      expect(getAppState()).toMatchObject({ overviewPane: "tags", sidebarTagsFocusPending: true });
      unmount();
    }
  });

  it("is in no bar or 更多, and an old stored pin drops out of the layout", () => {
    const nav = arrangeNavigation({ mode: "notes" }, actions, [], { order: ["tasks", "tags", "graph"], phone: 3 });
    expect(nav.phoneBar.map((d) => d.id)).toEqual(["tasks", "graph"]);
    expect(nav.layout).toEqual({ order: ["tasks", "graph"], phone: 2 });
    expect([...nav.pinned, ...nav.unpinned].map((d) => d.id)).not.toContain("tags");
    const more = getMoreNavigationGroups({}, nav.phoneMore);
    expect(more.flatMap((g) => g.items.map((i) => i.id))).not.toContain("tags");
  });

  it("the desktop top bar has no 標籤 button", () => {
    const nav = arrangeNavigation({ mode: "notes" }, actions, [], null);
    expect(nav.pinned.map((d) => d.label)).not.toContain("Tags");
  });
});

describe("整理: the unused tags and similar names close the tag list, not Settings › 模組", () => {
  const plain = (id: string, name: string): Tag => ({ id, name, color: "", schema_id: null });
  const seed = (tags: Tag[], owner = true) => setAppState({
    data: { ...noWorkspaceData, actor_is_owner: owner, workspace: { ...noWorkspaceData.workspace, modules: [] }, nodes: [], tags },
  });

  it("counts unused tags and similar names, and each opens its tag", () => {
    seed([plain("a", "idea"), plain("b", "ideas"), plain("c", "other")]);
    const open = vi.fn();
    render(<TagTidy openTag={open} />);
    const region = screen.getByRole("region", { name: "Tidy up" });
    expect(region).toHaveTextContent("3 unused tags");
    expect(region).toHaveTextContent("1 pair of similar names");
    fireEvent.click(screen.getByRole("button", { name: "Show the list" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Unused tags" })).getByRole("button", { name: "#other" }));
    expect(open).toHaveBeenCalledWith("c");
  });

  it("is the owner's, absent when there is nothing to tidy, and no longer on Settings › 模組", async () => {
    seed([plain("a", "idea")], false);
    const hidden = render(<TagTidy />);
    expect(hidden.container).toBeEmptyDOMElement();
    hidden.unmount();
    seed([]);
    const none = render(<TagTidy />);
    expect(none.container).toBeEmptyDOMElement();
    none.unmount();
    seed([plain("a", "idea")]);
    render(<ModulesSetting ctx={{ online: true, onClose: vi.fn(), onImportDone: vi.fn(), onConnect: vi.fn() }} />);
    await screen.findByText("library");
    expect(screen.queryByText(/unused tag/)).toBeNull();
    expect(screen.queryByRole("region", { name: "Tidy up" })).toBeNull();
    expect(screen.queryByText("Modules nothing uses")).toBeNull();
  });

  it("is collapsed at the foot of the owner's tag list and absent for others", async () => {
    const { default: SidebarTagTree } = await import("../components/SidebarTagTree");
    const nav = { openTag: vi.fn() };
    const rename = { nodeId: null, draft: "", setNodeId: vi.fn(), setDraft: vi.fn() } as never;
    seed([plain("a", "idea"), plain("c", "other")]);
    const owner = render(<SidebarTagTree nav={nav} rename={rename} />);
    const region = await screen.findByRole("region", { name: "Tidy up" }); // the tidy line loads on use
    expect(region).toHaveTextContent("2 unused tags");
    expect(screen.queryByRole("group", { name: "Unused tags" })).toBeNull();
    fireEvent.click(within(region).getByRole("button", { name: "Show the list" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Unused tags" })).getByRole("button", { name: "#other" }));
    expect(nav.openTag).toHaveBeenCalledWith("c");
    owner.unmount();
    seed([plain("a", "idea")], false);
    render(<SidebarTagTree nav={nav} rename={rename} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); // let the lazy tidy line settle
    expect(screen.queryByRole("region", { name: "Tidy up" })).toBeNull();
  });
});

describe("整理: tags a turned-off feature left show on that feature's own page", () => {
  const leftover = (id: string, name: string, schema_module: string): Tag => ({ id, name, color: "", schema_id: null, schema_module });
  const seed = (tags: Tag[], owner = true) => setAppState({
    data: { ...noWorkspaceData, actor_is_owner: owner, workspace: { ...noWorkspaceData.workspace, modules: ["rss"] }, nodes: [], tags },
  });

  it("shows the count and, on 檢視, only that feature's tags — and is absent when there are none", () => {
    seed([leftover("a", "複習", "review"), leftover("b", "網站", "website"), leftover("c", "卡片", "review")]);
    const open = vi.fn();
    const { unmount } = render(<RemovedModuleTags moduleId="review" openTag={open} />);
    expect(screen.getByRole("region", { name: "From modules that are off" })).toHaveTextContent("2 tags from modules that are off");
    fireEvent.click(screen.getByRole("button", { name: "Show the list" }));
    expect(screen.queryByRole("button", { name: "Open #網站" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open #複習" }));
    expect(open).toHaveBeenCalledWith("a");
    unmount();

    seed([{ id: "p", name: "plain", color: "", schema_id: null }]);
    const none = render(<RemovedModuleTags moduleId="review" openTag={open} />);
    expect(none.container).toBeEmptyDOMElement();
  });

  it("a tag no note uses can be deleted from the list; one in use cannot", () => {
    const remove = vi.spyOn(nodeActions, "delete").mockResolvedValue(true);
    setAppState({
      data: { ...noWorkspaceData, actor_is_owner: true, workspace: { ...noWorkspaceData.workspace, modules: ["rss"] },
        nodes: [{ id: "n", title: "note", markdown: "", source_type: "manual", node_type: "content", slug: "n", class_tag_ids: ["b"] }],
        tags: [leftover("a", "網站", "website"), leftover("b", "複習", "review")] },
    });
    render(<RemovedModuleTags moduleId="website" />);
    fireEvent.click(screen.getByRole("button", { name: "Show the list" }));
    expect(screen.queryByRole("button", { name: "Delete #複習" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete #網站" }));
    expect(remove).toHaveBeenCalledWith("a", "網站");
    remove.mockRestore();
  });

  it("is the owner's, shows on the page of the feature that is off, and is gone from the feature list", async () => {
    seed([leftover("a", "複習", "review")], false);
    const hidden = render(<RemovedModuleTags moduleId="review" />);
    expect(hidden.container).toBeEmptyDOMElement();
    hidden.unmount();
    seed([leftover("a", "複習", "review")]);
    const ctx = { online: true, onClose: vi.fn(), onImportDone: vi.fn(), onConnect: vi.fn() };
    const list = render(<ModulesSetting ctx={ctx} />);
    expect(await screen.findByText("library")).toBeInTheDocument();
    expect(screen.queryByText(/from a module that is off/)).toBeNull();
    list.unmount();
    // Its own page (複習 is off in this workspace), and no other feature's page.
    const page = render(<ModuleSettingsPage id="review" ctx={ctx} />);
    expect(screen.getByText(/1 tag from a module that is off/)).toBeInTheDocument();
    page.unmount();
    render(<ModuleSettingsPage id="website" ctx={ctx} />);
    expect(screen.queryByText(/from a module that is off/)).toBeNull();
  });

  it("tags of a feature this version no longer has are not lost: the feature list ends with them", () => {
    seed([leftover("g", "舊功能", "gone_module"), leftover("a", "複習", "review")]);
    const open = vi.fn();
    render(<RemovedModuleTags moduleId={null} openTag={open} />);
    expect(screen.getByRole("region", { name: "From modules that are off" })).toHaveTextContent("1 tag from a module that is off");
    fireEvent.click(screen.getByRole("button", { name: "Show the list" }));
    expect(screen.queryByText(/gone_module/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open #舊功能" }));
    expect(open).toHaveBeenCalledWith("g");
  });
});
