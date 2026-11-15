import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import MobileNav from "../components/MobileNav";
import { resetAppState } from "../lib/appStore";
import { noWorkspaceData, type Tag } from "../lib/api";
import { onSettingsRequest } from "../lib/settingsRequest";
import { usedFixture } from "./helpers/moduleUse";

function renderNav(overrides: Partial<Parameters<typeof MobileNav>[0]> = {}) {
  const props = {
    mode: "notes" as const,
    setMode: vi.fn(),
    onCapture: vi.fn(),
    onOpenFeature: vi.fn(),
   
    ...overrides,
  };
  render(<MobileNav {...props} />);
  return props;
}

describe("MobileNav (wave-2 mobile shell)", () => {
  // Every function with a page is in use: 更多 lists a function only once it is
  // used (or pinned).
  beforeEach(() => resetAppState({ data: { ...noWorkspaceData, ...usedFixture(["review", "rss", "website", "canvas", "daily"]), actor_is_owner: false } }));

  it("the default bar is core-only: Notes, Capture, Tasks, More (Tags is not pinned)", () => {
    renderNav();
    const nav = screen.getByRole("navigation");
    // Four labelled tabs + one central capture button = 5 buttons in the bar.
    const buttons = within(nav).getAllByRole("button");
    expect(buttons.map((button) => button.textContent || button.getAttribute("aria-label")))
      .toEqual(["Notes", "Capture", "Tasks", "More"]);
    // Imported modules never take a bar slot (they are in More › 功能).
    for (const name of ["Reading", "Review", "Website", "Canvas"]) expect(within(nav).queryByText(name)).toBeNull();
    // No Today slot: daily notes are a module (日記), listed in More › 功能.
    for (const name of ["Today's note", "Today", "Daily notes"]) expect(within(nav).queryByText(name)).toBeNull();
  });

  it("the bar stays core-only whatever is imported", () => {
    // Tasks is on in each (its page is the bar's default slot); the others vary.
    for (const modules of [["tasks"], ["tasks", "rss"], ["tasks", "rss", "review", "website", "canvas"]]) {
      resetAppState({ data: { ...noWorkspaceData, ...usedFixture(modules), workspace: { ...noWorkspaceData.workspace, modules }, actor_is_owner: false } });
      const { unmount } = render(<MobileNav mode="notes" setMode={vi.fn()} onCapture={vi.fn()}
        onOpenFeature={vi.fn()} />);
      expect(within(screen.getByRole("navigation")).getAllByRole("button").map((b) => b.textContent || b.getAttribute("aria-label")))
        .toEqual(["Notes", "Capture", "Tasks", "More"]);
      unmount();
    }
  });

  it("a page reached from More (History, a module's page) lights More", () => {
    renderNav({ mode: "timeline" });
    expect(screen.getByRole("button", { name: "More" })).toHaveClass("active");
    expect(screen.getByRole("button", { name: "Notes" })).not.toHaveAttribute("aria-current");
  });

  it("central Capture fires onCapture (not a mode switch)", () => {
    const props = renderNav();
    fireEvent.click(screen.getByLabelText("Capture"));
    expect(props.onCapture).toHaveBeenCalledTimes(1);
    expect(props.setMode).not.toHaveBeenCalled();
  });

  it("Notes/Tasks switch mode; History is opened from More until pinned", () => {
    const props = renderNav();
    fireEvent.click(screen.getByText("Tasks"));
    expect(props.setMode).toHaveBeenCalledWith("tasks");
    fireEvent.click(screen.getByText("More"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Workspace changes" }));
    expect(props.setMode).toHaveBeenCalledWith("timeline");
  });

  it("More lists every function that is on, used or not, under the nav editor's names", () => {
    resetAppState({ data: { ...noWorkspaceData, ...usedFixture(["rss"]), actor_is_owner: false } });
    renderNav();
    fireEvent.click(screen.getByText("More"));
    const features = within(screen.getByRole("dialog")).getByRole("group", { name: "Features" });
    const names = within(features).getAllByRole("button").map((b) => b.textContent);
    // 複習 is on but unused; the reading hub is one row, 閱讀.
    expect(names).toContain("Review");
    expect(names.filter((name) => name === "Reading")).toHaveLength(1);
  });

  it("More is navigation only: core destinations, then the imported features", () => {
    renderNav();
    // Sheet closed initially.
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByText("More"));
    const menu = screen.getByRole("dialog");
    const groups = within(menu).getAllByRole("group");
    expect(groups.map(group => group.getAttribute("aria-label"))).toEqual(["Time", "Organize", "Features"]);
    expect(groups.map(group => within(group).getAllByRole("button").map(button => button.textContent)))
      .toEqual([["Today", "Daily notes", "Workspace changes"], ["Graph"], ["Review", "Reading", "Website"]]);
    // Tasks is in the bar, not repeated here; Tags is Notes home's 標籤 tab on the phone.
    expect(within(menu).queryByRole("button", { name: "Tasks" })).toBeNull();
  });

  it("More has no account block, connection row, Settings or Refresh (they are behind the avatar)", () => {
    renderNav();
    fireEvent.click(screen.getByText("More"));
    const menu = screen.getByRole("dialog");
    for (const name of ["Settings", "Refresh", "Sign out", "Spaces and members"]) {
      expect(within(menu).queryByRole("button", { name })).toBeNull();
    }
    expect(within(menu).queryByText("Connected")).toBeNull();
  });

  it("the workspace timeline is listed as History, not as a Timeline entry", () => {
    renderNav();
    expect(within(screen.getByRole("navigation")).queryByText("Workspace changes")).toBeNull();
    fireEvent.click(screen.getByText("More"));
    const menu = screen.getByRole("dialog");
    expect(within(menu).queryByText("Timeline")).toBeNull();
    expect(within(menu).getByRole("button", { name: "Workspace changes" })).toBeTruthy();
  });

  it("feature rows open the feature (review, website)", () => {
    const props = renderNav();
    for (const [label, id] of [["Review", "review"], ["Website", "website"]]) {
      fireEvent.click(screen.getByText("More"));
      fireEvent.click(within(screen.getByRole("dialog")).getByText(label!));
      expect(props.onOpenFeature).toHaveBeenLastCalledWith(id);
    }
  });

  it("More sheet Graph/History switch mode (History is the workspace timeline)", () => {
    const props = renderNav();
    fireEvent.click(screen.getByText("More"));
    fireEvent.click(within(screen.getByRole("dialog")).getByText("Graph"));
    expect(props.setMode).toHaveBeenCalledWith("graph");

    fireEvent.click(screen.getByText("More"));
    fireEvent.click(within(screen.getByRole("dialog")).getByText("Workspace changes"));
    expect(props.setMode).toHaveBeenCalledWith("timeline");
  });

  it("More has no Search: on a phone it is the top bar's button, right of the avatar", () => {
    renderNav();
    fireEvent.click(screen.getByText("More"));
    expect(within(screen.getByRole("dialog")).queryByText("Search")).toBeNull();
  });

  it("features follow the workspace's imports; a feature with only a tag is not listed (Settings › 功能 › it opens it)", () => {
    const skill = { id: "t-skill", name: "技能", schema_module: "skills" } as unknown as Tag;
    resetAppState({ data: { ...noWorkspaceData, workspace: { ...noWorkspaceData.workspace, modules: ["review", "skills"] }, ...usedFixture(["review", "skills"], { tags: [skill] }), actor_is_owner: false } });
    renderNav();
    fireEvent.click(screen.getByText("More"));
    const features = within(screen.getByRole("dialog")).getByRole("group", { name: "Features" });
    expect(within(features).getAllByRole("button").map(button => button.textContent)).toEqual(["Review"]);
  });

  it("the inbox is not in More (it is Notes home's third tab); with nothing else on and not the owner, no Features group", () => {
    resetAppState({ data: { ...noWorkspaceData, workspace: { ...noWorkspaceData.workspace, modules: [] }, actor_is_owner: false } });
    renderNav();
    fireEvent.click(screen.getByText("More"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "Inbox" })).toBeNull();
    expect(within(dialog).queryByRole("group", { name: "Features" })).toBeNull();
  });

  it("「編輯」 closes the sheet and opens Settings › 導覽列: there is no second editor in the sheet", () => {
    const opened = vi.fn();
    const off = onSettingsRequest(opened);
    renderNav();
    fireEvent.click(screen.getByText("More"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Edit" }));
    expect(opened).toHaveBeenCalledWith("navigation");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("nav-settings")).toBeNull();
    off();
  });

  it("「管理模組」 is the owner's and opens Settings › Modules", () => {
    resetAppState({ data: { ...noWorkspaceData, actor_role: "admin", actor_is_owner: true } });
    const opened = vi.fn();
    const off = onSettingsRequest(opened);
    renderNav();
    fireEvent.click(screen.getByText("More"));
    const features = within(screen.getByRole("dialog")).getByRole("group", { name: "Features" });
    const rows = within(features).getAllByRole("button");
    expect(rows[rows.length - 1]).toHaveTextContent("Manage modules");
    fireEvent.click(rows[rows.length - 1]!);
    expect(opened).toHaveBeenCalledWith("modules");
    expect(screen.queryByRole("dialog")).toBeNull();
    off();
  });
});

describe("MobileNav and the 日記 module", () => {
  const withModules = (modules: string[]) =>
    resetAppState({ data: { ...noWorkspaceData, ...usedFixture(modules), workspace: { ...noWorkspaceData.workspace, modules }, actor_is_owner: false } });
  const sheetRows = () => within(screen.getByRole("dialog")).getAllByRole("button").map((b) => b.textContent);

  it("imported: 日記 is a feature row in More (never a bar slot) and opens the Journal page", () => {
    withModules(["rss", "daily"]);
    const props = renderNav();
    expect(within(screen.getByRole("navigation")).queryByText("Daily notes")).toBeNull();
    fireEvent.click(screen.getByText("More"));
    const dialog = within(screen.getByRole("dialog"));
    expect(within(dialog.getByRole("group", { name: "Features" })).getAllByRole("button").map((b) => b.textContent)).toEqual(["Reading"]);
    // 日記 is under 時間, ahead of 歷史.
    const time = dialog.getByRole("group", { name: "Time" });
    expect(within(time).getAllByRole("button").map((b) => b.textContent)).toEqual(["Today", "Daily notes", "Workspace changes"]);
    // One entry: no core Today's note row beside it.
    expect(sheetRows()).not.toContain("Today's note");
    fireEvent.click(within(time).getByText("Daily notes"));
    expect(props.onOpenFeature).toHaveBeenCalledWith("daily");
  });

  it("not imported: no 日記 row and no Today's note row", () => {
    withModules(["rss"]);
    renderNav();
    fireEvent.click(screen.getByText("More"));
    expect(sheetRows()).not.toContain("Daily notes");
    expect(sheetRows()).not.toContain("Today's note");
  });
});

vi.mock("../lib/auth-client", () => ({ authClient: { useSession: () => ({ data: null }) } }));
beforeEach(() => {
  resetAppState({ data: { ...noWorkspaceData, actor_is_owner: false } });
  vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (this: HTMLDialogElement) { this.open = true; });
  vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (this: HTMLDialogElement) { this.open = false; });
});
afterEach(() => vi.restoreAllMocks());
