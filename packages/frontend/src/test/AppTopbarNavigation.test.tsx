// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { clearPhoneLayout, setPhoneLayout } from "./phoneMedia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { AppNavigation } from "../components/AppTopbar";
import { fittingModuleCount } from "../hooks/shellNavigation";
import { resetAppState } from "../lib/appStore";
import { noWorkspaceData, type Tag } from "../lib/api";
import { usedFixture } from "./helpers/moduleUse";
import { onSplitDrop, splitDrag } from "../lib/splitViewStore";

vi.mock("../lib/auth-client", () => ({ authClient: { useSession: () => ({ data: null }) } }));
afterEach(() => vi.restoreAllMocks());
// Every module with a page is in use unless a test says otherwise: the nav lists
// a function only once it is used or pinned.
const IN_USE = ["review", "rss", "website", "canvas", "daily"];
beforeEach(() => resetAppState({ data: { ...noWorkspaceData, ...usedFixture(IN_USE), actor_is_owner: false } }));

// Workspace changes is not in the default bar: it opens from 更多 ▾.
const CORE = ["Notes", "Tasks", "Graph"];

// Tasks is on in each case: its page is a core page of the bar.
function withModules(imported: string[] | null, tags: Tag[] = []) {
  const modules = imported && ["tasks", ...imported];
  resetAppState({ data: { ...noWorkspaceData, workspace: { ...noWorkspaceData.workspace, modules }, ...usedFixture(IN_USE, { tags }), actor_is_owner: false } });
}

function renderNavigation(overrides: Partial<Parameters<typeof AppNavigation>[0]> = {}) {
  const props = { mode: "notes" as const, setMode: vi.fn(), onOpenModule: vi.fn(), onOpenFeature: vi.fn(), ...overrides };
  const view = render(<AppNavigation {...props} />);
  return { props, view };
}

const labels = () => within(screen.getByRole("navigation", { name: "Primary" })).getAllByRole("button").map((b) => b.textContent).filter((label) => label !== "More");

describe("desktop primary navigation", () => {
  it("shows the core pages in order, then the imported modules' pages", () => {
    renderNavigation();
    // The whiteboard is in use too, and still has no entry: boards are notes.
    expect(labels()).toEqual([...CORE, "Review", "Reading", "Website", "Daily notes", "Today"]);
    // Everything pinned fits (no layout in jsdom): 更多 ▾ holds only what is not pinned.
    expect(labels()).not.toContain("Workspace changes");
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(within(screen.getByRole("menu", { name: "More" })).getAllByRole("menuitem").map((b) => b.textContent))
      .toEqual(["Workspace changes", "Customize navigation bar…"]);
  });

  it("core pages are there with no module imported", () => {
    withModules([]);
    renderNavigation();
    expect(labels()).toEqual([...CORE, "Today"]);
  });

  it("a module's entry appears when it is imported and goes when it is removed", () => {
    withModules(["review"]);
    const { props, view } = renderNavigation();
    expect(labels()).toEqual([...CORE, "Review", "Today"]);
    act(() => withModules([]));
    view.rerender(<AppNavigation {...props} />);
    expect(labels()).toEqual([...CORE, "Today"]);
    act(() => withModules(["rss", "canvas"]));
    view.rerender(<AppNavigation {...props} />);
    expect(labels()).toEqual([...CORE, "Reading", "Today"]);
  });

  it("features with only a tag (Skills) have no entry", () => {
    const tags = [
      { id: "t-skill", name: "技能", schema_module: "skills" },
    ] as unknown as Tag[];
    withModules(["skills"], tags);
    renderNavigation();
    expect(labels()).toEqual([...CORE, "Today"]);
  });

  it("日記 (daily notes) is a module entry: listed only while imported, opens the Journal page, lit there", () => {
    withModules(["daily"]);
    const { props, view } = renderNavigation();
    expect(labels()).toEqual([...CORE, "Daily notes", "Today"]);
    // No Today button beside it: the journal page is the one entry.
    expect(screen.queryByRole("button", { name: /Today's note/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Daily notes" }));
    expect(props.onOpenFeature).toHaveBeenLastCalledWith("daily");
    view.rerender(<AppNavigation {...props} mode="daily" />);
    expect(screen.getByRole("button", { name: "Daily notes" })).toHaveAttribute("aria-current", "page");
    act(() => withModules([]));
    view.rerender(<AppNavigation {...props} />);
    expect(labels()).toEqual([...CORE, "Today"]);
  });

  it("opens each destination through the shell's callbacks", () => {
    const { props } = renderNavigation();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    for (const [label, mode] of [["Tasks", "tasks"], ["Graph", "graph"]] as const) {
      fireEvent.click(within(nav).getByRole("button", { name: label }));
      expect(props.setMode).toHaveBeenLastCalledWith(mode);
    }
    // The reading hub opens on a section; a screen through openFeature.
    fireEvent.click(within(nav).getByRole("button", { name: "Reading" }));
    expect(props.onOpenModule).toHaveBeenLastCalledWith("rss");
    for (const [label, id] of [["Review", "review"], ["Website", "website"]] as const) {
      fireEvent.click(within(nav).getByRole("button", { name: label }));
      expect(props.onOpenFeature).toHaveBeenLastCalledWith(id);
    }
  });

  it("marks the current destination", () => {
    const current = () => screen.getAllByRole("button").filter((b) => b.getAttribute("aria-current") === "page").map((b) => b.textContent);
    const { props, view } = renderNavigation();
    expect(current()).toEqual(["Notes"]);
    for (const [mode, label] of [["graph", "Graph"], ["rss", "Reading"], ["review", "Review"], ["website", "Website"]] as const) {
      view.rerender(<AppNavigation {...props} mode={mode} />);
      expect(current()).toEqual([label]);
    }
    // A panel over a core page clears it; a module screen stays lit.
    view.rerender(<AppNavigation {...props} mode="tasks" activePanel="actors" />);
    expect(current()).toEqual([]);
    view.rerender(<AppNavigation {...props} mode="review" activePanel="actors" />);
    expect(current()).toEqual(["Review"]);
  });
});

describe("desktop overflow", () => {
  it("fits as many trailing module entries as the width allows, saving room for 更多", () => {
    const core = [60, 60, 60, 60, 60];
    const row = { gap: 6, core, modules: [70, 70, 70, 70], more: 60 };
    const coreRow = 5 * 60 + 4 * 6;
    expect(fittingModuleCount({ ...row, budget: 10_000 })).toBe(4);
    // Exactly everything, no 更多 needed.
    expect(fittingModuleCount({ ...row, budget: coreRow + 4 * (70 + 6) })).toBe(4);
    // One pixel short: the last one folds into 更多 (narrower than it).
    expect(fittingModuleCount({ ...row, budget: coreRow + 4 * (70 + 6) - 1 })).toBe(3);
    // 更多 has to fit beside the ones kept.
    expect(fittingModuleCount({ ...row, budget: coreRow + 3 * (70 + 6) + 6 + 60 - 1 })).toBe(2);
    expect(fittingModuleCount({ ...row, budget: coreRow + 6 + 60 })).toBe(0);
    // Core pages never fold.
    expect(fittingModuleCount({ ...row, budget: 10 })).toBe(0);
  });

  it("does not count the group's own padding as room (the centre group has 12px + 16px)", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("app-topbar-left") ? 700 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("app-logo")) return 100;
      return this.dataset.measure ? 100 : 0;
    });
    const props = { mode: "website" as const, setMode: vi.fn(), onOpenModule: vi.fn(), onOpenFeature: vi.fn() };
    render(<div className="app-topbar-left" style={{ paddingLeft: "12px", paddingRight: "16px" }}><span className="app-logo">Onden</span><AppNavigation {...props} /></div>);
    // 700 − 28 padding − 100 sibling = 572: three core + one entry + 更多 (500); a second entry needs 600
    // (counting the padding as room, 600, would keep it and crowd the search).
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual([...CORE, "Review", "More"]);
  });

  it("moves the trailing entries into 更多 ▾ when the bar runs out of width", () => {
    // A 700px left group with a 100px sibling; every button 100px, no gaps.
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("app-topbar-left") ? 700 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("app-logo")) return 100;
      return this.dataset.measure ? 100 : 0;
    });
    const props = { mode: "website" as const, setMode: vi.fn(), onOpenModule: vi.fn(), onOpenFeature: vi.fn() };
    render(<div className="app-topbar-left"><span className="app-logo">Onden</span><AppNavigation {...props} /></div>);
    // Budget 600: all nine need 900; four core (400) + one module + 更多 = 600.
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const shown = within(nav).getAllByRole("button").map((b) => b.textContent);
    expect(shown).toEqual([...CORE, "Review", "Reading", "More"]);
    const more = within(nav).getByRole("button", { name: "More" });
    // The current page (Website) is folded: 更多 lights up.
    expect(more).toHaveAttribute("aria-current", "page");
    fireEvent.click(more);
    const menu = screen.getByRole("menu", { name: "More" });
    const folded = within(menu).getAllByRole("menuitem").map((item) => item.textContent);
    // The folded entries in order, then the way to change what is pinned.
    expect([...shown.filter((label) => label !== "More"), ...folded]).toEqual([...CORE, "Review", "Reading", "Website", "Daily notes", "Today", "Workspace changes", "Customize navigation bar…"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Daily notes" }));
    expect(props.onOpenFeature).toHaveBeenCalledWith("daily");
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("side by side: a function dragged from the bar", () => {
  const drops: Array<[unknown, string, string]> = [];
  let stop = () => {};
  beforeEach(() => { drops.length = 0; stop = onSplitDrop((target, side, from) => { drops.push([target, side, from]); }); vi.stubGlobal("innerWidth", 1280); });
  afterEach(() => { stop(); splitDrag.cancel(); vi.unstubAllGlobals(); });
  const button = (name: string) => within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name });

  it("dropped on the right half it opens there; a click still loads the left", () => {
    const { props } = renderNavigation();
    fireEvent.dragStart(button("Tasks"), { dataTransfer: { setData: vi.fn(), effectAllowed: "" } });
    expect(splitDrag.active()).toBe(true);
    act(() => { window.dispatchEvent(new MouseEvent("dragover", { clientX: 1000 })); });
    act(() => { splitDrag.drop(1000); });
    expect(drops).toEqual([[{ kind: "page", mode: "tasks" }, "right", "function"]]);
    fireEvent.click(button("Tasks"));
    expect(props.setMode).toHaveBeenCalledWith("tasks");
  });

  it("a module's page is dragged as its view (the reading hub as its section)", () => {
    renderNavigation();
    fireEvent.dragStart(button("Reading"), { dataTransfer: { setData: vi.fn(), effectAllowed: "" } });
    act(() => { splitDrag.drop(1000); });
    expect(drops).toHaveLength(1);
    expect(drops[0]![0]).toMatchObject({ kind: "page" });
  });

  it("the Notes button is not draggable (it is the left side itself)", () => {
    renderNavigation();
    expect(button("Notes")).not.toHaveAttribute("draggable");
    fireEvent.dragStart(button("Notes"), { dataTransfer: { setData: vi.fn(), effectAllowed: "" } });
    expect(splitDrag.active()).toBe(false);
  });

  it("the right-click menu offers 「開在右邊」", () => {
    renderNavigation();
    fireEvent.contextMenu(button("Tasks"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open on the right" }));
    expect(drops).toEqual([[{ kind: "page", mode: "tasks" }, "right", "menu"]]);
  });

  it("a phone's right-click menu has no 「開在右邊」 (no side by side there)", () => {
    setPhoneLayout(true);
    try {
      renderNavigation();
      fireEvent.contextMenu(button("Tasks"));
      expect(screen.queryByRole("menuitem", { name: "Open on the right" })).toBeNull();
      expect(screen.getByRole("menuitem", { name: "Remove from navigation bar" })).toBeTruthy();
    } finally { clearPhoneLayout(); }
  });
});
