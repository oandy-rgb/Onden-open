import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import MobileNav from "../components/MobileNav";
import { AppNavigation } from "../components/AppTopbar";
import NavigationSetting from "../settings/NavigationSetting";
import { resetAppState } from "../lib/appStore";
import { noWorkspaceData } from "../lib/api";
import { navLayoutStore } from "../lib/navLayoutStore";
import type { NavLayout } from "../lib/navLayout";
import { usedFixture } from "./helpers/moduleUse";

// 「釘到導覽列」 on the real surfaces: the phone's bar and 更多 sheet, the
// desktop top bar, Settings › 導覽列. The server is a fake that keeps what it
// is sent (vi.mock below); every test starts from the default layout.

let serverValue: unknown = null;
vi.mock("../lib/data/onlineWrite", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/data/onlineWrite")>(),
  sendWrite: vi.fn(async (_method: string, _path: string, body: { value: unknown }) => { serverValue = body.value; return { value: body.value }; }),
}));
vi.mock("../lib/data/reads", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/data/reads")>();
  return { ...real, reads: { ...real.reads, people: { ...real.reads.people, myPref: vi.fn(async () => ({ value: serverValue })) } } };
});
vi.mock("../lib/auth-client", () => ({ authClient: { useSession: () => ({ data: null }) } }));

function withModules(imported: string[]) {
  // Tasks is on in every case here: its page is the nav's first destination.
  const modules = ["tasks", ...imported];
  resetAppState({ data: { ...noWorkspaceData, ...usedFixture(modules), workspace: { ...noWorkspaceData.workspace, modules }, actor_is_owner: false } });
}
async function storeLayout(layout: NavLayout | null) {
  await act(async () => { navLayoutStore.save(layout); await navLayoutStore.sync(); });
}

/** The shell the app is in, as hooks/useIsMobile reads it (≤900px = phone). */
function setShell(shell: "phone" | "desktop") {
  window.matchMedia = vi.fn((query: string) => ({
    matches: shell === "phone" && query.includes("max-width: 900px"), media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}
const realMatchMedia = window.matchMedia;

beforeEach(async () => {
  setShell("phone");
  vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (this: HTMLDialogElement) { this.open = true; });
  vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (this: HTMLDialogElement) { this.open = false; });
  withModules(["rss", "website", "review"]);
  await storeLayout(null);
});
afterEach(() => { vi.restoreAllMocks(); window.matchMedia = realMatchMedia; });

function renderPhone() {
  const props = { mode: "notes" as const, setMode: vi.fn(), onCapture: vi.fn(), onOpenFeature: vi.fn(), onOpenModule: vi.fn() };
  render(<MobileNav {...props} />);
  return props;
}
const bar = () => within(screen.getByRole("navigation", { name: "Primary" })).getAllByRole("button")
  .map((b) => b.textContent || b.getAttribute("aria-label"));
const openMore = () => fireEvent.click(screen.getByRole("button", { name: "More" }));
const sheet = () => screen.getByRole("dialog", { name: "More" });

describe("pinning on the phone", () => {
  it("never edited, the bar is Notes · Capture · Tasks · More: Graph is not pinned but can be", () => {
    renderPhone();
    expect(bar()).toEqual(["Notes", "Capture", "Tasks", "More"]);
  });

  it("a long press on a 更多 row pins it; it leaves 更多 and takes a slot", async () => {
    const props = renderPhone();
    openMore();
    // Android's long press (and a right click) arrive as contextmenu.
    fireEvent.contextMenu(within(sheet()).getByRole("button", { name: "Reading" }));
    fireEvent.click(within(sheet()).getByRole("menuitem", { name: "Pin to navigation bar" }));
    expect(bar()).toEqual(["Notes", "Tasks", "Capture", "Reading", "More"]);
    expect(within(sheet()).queryByRole("button", { name: "Reading" })).toBeNull();
    // The slot opens the reading hub on its section.
    fireEvent.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: "Reading" }));
    expect(props.onOpenModule).toHaveBeenCalledWith("rss");
    await waitFor(() => expect(serverValue).toEqual({ order: ["tasks", "reading", "graph", "review", "website", "today"], phone: 2 }));
  });

  it("a held touch opens the same menu, and the click that ends it does not open the row", () => {
    vi.useFakeTimers();
    try {
      const props = renderPhone();
      openMore();
      const row = within(sheet()).getByRole("button", { name: "Graph" });
      fireEvent.pointerDown(row, { button: 0, clientX: 10, clientY: 10 });
      act(() => { vi.advanceTimersByTime(600); });
      fireEvent.pointerUp(row);
      fireEvent.click(row);
      expect(props.setMode).not.toHaveBeenCalled();
      expect(within(sheet()).getByRole("menuitem", { name: "Pin to navigation bar" })).toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });

  it("「編輯」 opens Settings › 導覽列, the one editor: ⊕ joins the bar, and a full bar takes the rest after the phone's limit", async () => {
    await storeLayout({ order: ["tasks", "timeline"], phone: 2 });
    renderPhone();
    render(<NavigationSetting />);
    fireEvent.click(screen.getByRole("button", { name: "Pin “Graph” to the navigation bar" }));
    expect(bar()).toEqual(["Notes", "Tasks", "Capture", "Workspace changes", "Graph", "More"]);
    // Full (3 of 3): ⊕ still works, but the phone keeps its three.
    fireEvent.click(screen.getByRole("button", { name: "Pin “Website” to the navigation bar" }));
    expect(bar()).toEqual(["Notes", "Tasks", "Capture", "Workspace changes", "Graph", "More"]);
    expect(within(rowOf("website")).getByText("Computer only")).toBeInTheDocument();
    expect(within(rowOf("graph")).queryByText("Computer only")).toBeNull();
  });

  it("arrows appear on the selected row only; ⊖ removes; a long press on a slot removes too", async () => {
    await storeLayout({ order: ["tasks", "timeline", "graph"], phone: 3 });
    renderPhone();
    render(<NavigationSetting />);
    expect(screen.queryByRole("button", { name: /^Move /})).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reorder “Graph”" }));
    expect(screen.getAllByRole("button", { name: /^Move “/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Move “Graph” up" }));
    expect(bar()).toEqual(["Notes", "Tasks", "Capture", "Graph", "Workspace changes", "More"]);
    fireEvent.click(screen.getByRole("button", { name: "Reorder “Tasks”" }));
    expect(screen.getByRole("button", { name: "Move “Tasks” up" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove “Tasks” from the navigation bar" }));
    expect(bar()).toEqual(["Notes", "Graph", "Capture", "Workspace changes", "More"]);
    fireEvent.contextMenu(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: "Workspace changes" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from navigation bar" }));
    expect(bar()).toEqual(["Notes", "Capture", "Graph", "More"]);
  });
});

const rowOf = (id: string) => document.querySelector<HTMLElement>(`.nav-reorder-list li[data-destination="${id}"]`)!;

describe("the desktop bar and a removed module", () => {
  const labels = () => within(screen.getByRole("navigation", { name: "Primary" })).getAllByRole("button").map((b) => b.textContent);
  const renderDesktop = () => {
    const props = { mode: "notes" as const, setMode: vi.fn(), onOpenModule: vi.fn(), onOpenFeature: vi.fn() };
    return { props, view: render(<AppNavigation {...props} />) };
  };

  it("shows the pinned list; the rest are in 「更多 ▾」", async () => {
    await storeLayout({ order: ["reading", "tasks"], phone: 1 });
    renderDesktop();
    expect(labels()).toEqual(["Notes", "Reading", "Tasks", "More"]);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(within(screen.getByRole("menu", { name: "More" })).getAllByRole("menuitem").map((i) => i.textContent))
      .toEqual(["Graph", "Workspace changes", "Review", "Website", "Today", "Customize navigation bar…"]);
  });

  it("a removed module leaves the bar without a gap, and importing it again does not restore the pin", async () => {
    await storeLayout({ order: ["tasks", "reading", "website"], phone: 2 });
    const { props, view } = renderDesktop();
    expect(labels()).toEqual(["Notes", "Tasks", "Reading", "Website", "More"]);
    act(() => withModules(["website", "review"]));
    view.rerender(<AppNavigation {...props} />);
    expect(labels()).toEqual(["Notes", "Tasks", "Website", "More"]);
    await waitFor(() => expect(serverValue).toEqual({ order: ["tasks", "website"], phone: 1 }));
    act(() => withModules(["rss", "website", "review"]));
    view.rerender(<AppNavigation {...props} />);
    expect(labels()).toEqual(["Notes", "Tasks", "Website", "More"]);
  });

  it("a right click offers 「從導覽列移除」", () => {
    renderDesktop();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Graph" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from navigation bar" }));
    expect(labels()).toEqual(["Notes", "Tasks", "Review", "Reading", "Website", "Today", "More"]);
  });
});

describe("Settings › 導覽列", () => {
  const rows = () => within(screen.getByRole("list", { name: "Navigation bar" })).getAllByRole("listitem")
    .map((li) => li.dataset.destination!);
  const marked = () => within(screen.getByRole("list", { name: "Navigation bar" })).getAllByText("Computer only")
    .map((n) => n.closest("li")!.dataset.destination);

  it("is the only editor: 「更多」 is a locked row, 「恢復預設」 is always there, the inbox is not a row", () => {
    render(<NavigationSetting />);
    expect(screen.getByTestId("nav-settings")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
    const more = rowOf("more");
    expect(more.className).toContain("nav-reorder-row--fixed");
    expect(within(more).queryByRole("button")).toBeNull();
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
    expect(document.querySelector('[data-destination="capture"]:not(.nav-bar-preview-slot)')).toBeNull();
  });

  describe("the preview is the phone's bar", () => {
    const previewIds = () => [...document.querySelectorAll<HTMLElement>(".nav-bar-preview > li:not(.is-beyond)")].map((li) => li.dataset.destination);
    const realIds = () => [...screen.getByRole("navigation", { name: "Primary" }).children].map((el) =>
      (el as HTMLElement).dataset.destination ?? (el.classList.contains("mobile-nav-capture") ? "capture" : "more"));

    for (const pins of [0, 1, 2, 3]) {
      it(`with ${pins} pinned the order is the same as MobileNav's, ＋ and 更多 included`, async () => {
        await storeLayout({ order: ["tasks", "graph", "review", "reading"].slice(0, pins), phone: pins });
        renderPhone();
        render(<NavigationSetting />);
        expect(previewIds()).toEqual(realIds());
        expect(previewIds()).toContain("capture");
        expect(previewIds().at(-1)).toBe("more");
        // ＋ and 更多 are not controls.
        expect(document.querySelector(".nav-bar-preview button")).toBeNull();
      });
    }

    it("entries past the phone's share are not drawn; the list puts 更多 in the same place and marks them", async () => {
      await storeLayout({ order: ["tasks", "graph"], phone: 1 });
      render(<NavigationSetting />);
      const all = [...document.querySelectorAll<HTMLElement>(".nav-bar-preview > li")];
      // Past the phone's share nothing is drawn after 更多 (it would run off the card): the list's 「電腦才顯示」 rows say it.
      expect(all.map((li) => li.dataset.destination)).toEqual(["notes", "capture", "tasks", "more"]);
      expect(rows()).toEqual(["notes", "tasks", "more", "graph"]);
    });

    it("with every row on the phone, 更多 is the list's last row", async () => {
      await storeLayout({ order: ["tasks", "graph"], phone: 2 });
      render(<NavigationSetting />);
      expect(rows()).toEqual(["notes", "tasks", "graph", "more"]);
    });
  });

  it("marks rows past the phone's limit, reorders by keyboard and arrows, moves with ⊖ / ⊕, and resets", async () => {
    // The locked 更多 row follows the phone's share; the reorder checks look at the entries alone.
    const entries = () => rows().filter((id) => id !== "more");
    render(<NavigationSetting />);
    expect(rows()).toEqual(["notes", "tasks", "more", "graph", "review", "reading", "website", "today"]);
    expect(marked()).toEqual(["graph", "review", "reading", "website", "today"]);
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
    // An arrow key on a handle moves it; Graph, first after the cut, crosses it into the phone's bar.
    fireEvent.keyDown(screen.getByRole("button", { name: "Reorder “Graph”" }), { key: "ArrowUp" });
    expect(marked()).toEqual(["review", "reading", "website", "today"]);
    fireEvent.keyDown(screen.getByRole("button", { name: "Reorder “Tasks”" }), { key: "ArrowDown" });
    expect(entries().slice(0, 4)).toEqual(["notes", "graph", "tasks", "review"]);
    // Tapping a handle shows the buttons for that row alone.
    expect(screen.queryByRole("button", { name: /^Move /})).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reorder “Website”" }));
    fireEvent.click(screen.getByRole("button", { name: "Move “Website” up" }));
    expect(entries().slice(-3)).toEqual(["website", "reading", "today"]);
    // ⊖ takes an entry out to 「更多」, ⊕ puts it back (the phone's bar has room: it joins it).
    fireEvent.click(screen.getByRole("button", { name: "Remove “Review” from the navigation bar" }));
    expect(rows()).not.toContain("review");
    fireEvent.click(screen.getByRole("button", { name: "Pin “Review” to the navigation bar" }));
    expect(entries().indexOf("review")).toBe(3);
    expect(rows().indexOf("more")).toBe(4);
    expect(marked()).not.toContain("review");
    await waitFor(() => expect(serverValue).toEqual({ order: ["graph", "tasks", "review", "website", "reading", "today"], phone: 3 }));
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(rows()).toEqual(["notes", "tasks", "more", "graph", "review", "reading", "website", "today"]);
    await waitFor(() => expect(serverValue).toBeNull());
  });

  it("dragging across 更多 moves a row out of the phone's bar or into it: either side of 更多 is its own place", async () => {
    await storeLayout({ order: ["tasks", "graph", "review"], phone: 2 });
    render(<NavigationSetting />);
    expect(rows()).toEqual(["notes", "tasks", "graph", "more", "review"]);
    // Drag `id` by its handle onto the upper or lower half of the row of `over`.
    const dragOnto = (name: string, over: string, half: "upper" | "lower") => {
      const target = rowOf(over);
      vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ top: 100, height: 40 } as DOMRect);
      document.elementFromPoint = () => target;
      const handle = screen.getByRole("button", { name: `Reorder “${name}”` });
      fireEvent.pointerDown(handle, { pointerId: 1 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 10, clientY: half === "upper" ? 105 : 135 });
      fireEvent.pointerUp(handle, { pointerId: 1 });
    };
    try {
      // Below 更多: out of the phone's bar, first of the 「電腦才顯示」 rows.
      dragOnto("Graph", "more", "lower");
      expect(rows()).toEqual(["notes", "tasks", "more", "graph", "review"]);
      expect(marked()).toEqual(["graph", "review"]);
      // Above 更多: back at the end of the phone's bar.
      dragOnto("Graph", "more", "upper");
      expect(rows()).toEqual(["notes", "tasks", "graph", "more", "review"]);
      // The upper half of the first row after 更多 is the same place as below 更多.
      dragOnto("Graph", "review", "upper");
      expect(rows()).toEqual(["notes", "tasks", "more", "graph", "review"]);
      await waitFor(() => expect(serverValue).toEqual({ order: ["tasks", "graph", "review"], phone: 1 }));
    } finally {
      delete (document as { elementFromPoint?: unknown }).elementFromPoint;
    }
  });

  it("「在「更多」裡」 is grouped like the phone's 更多: 時間 first (日記, 任務, 歷史), then 整理, then 功能", () => {
    render(<NavigationSetting />);
    for (const name of ["Tasks", "Graph"]) fireEvent.click(screen.getByRole("button", { name: `Remove “${name}” from the navigation bar` }));
    const groups = screen.getAllByRole("heading", { level: 5 }).map((h) => h.textContent);
    expect(groups.slice(0, 2)).toEqual(["Time", "Organize"]);
    const time = screen.getByRole("list", { name: "Time" });
    expect(within(time).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Pin “Tasks” to the navigation bar", "Pin “Workspace changes” to the navigation bar",
    ]);
  });

  it("⊕ joins the phone's bar while it has room", () => {
    render(<NavigationSetting />);
    fireEvent.click(screen.getByRole("button", { name: "Remove “Graph” from the navigation bar" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin “Graph” to the navigation bar" }));
    expect(marked()).not.toContain("graph");
    expect(marked()[0]).toBe("review");
    expect(rows().indexOf("graph")).toBe(2);
    // 標籤 is no destination: the editor never lists it.
    expect(screen.queryByRole("button", { name: /“Tags”/ })).toBeNull();
  });
});

describe("Settings › 導覽列 follows the shell", () => {
  const phoneSlots = () => document.querySelectorAll(".nav-bar-preview");
  const desktopBar = () => document.querySelector<HTMLElement>(".nav-desktop-preview .app-primary-nav--preview");
  const barIds = () => [...desktopBar()!.querySelectorAll<HTMLElement>("[data-destination]")].map((el) => el.dataset.destination!);
  const listIds = () => [...document.querySelectorAll<HTMLElement>(".nav-reorder-list:first-of-type li[data-destination]")].map((li) => li.dataset.destination!);
  const marked = () => within(screen.getByRole("list", { name: "Navigation bar" })).queryAllByText("In More menu").map((n) => n.closest("li")!.dataset.destination!);

  /** jsdom has no layout: every button is 100px wide in a bar that is `width` wide. */
  function barWidth(width: number) {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width);
  }

  it("on the desktop shell the preview is the real top bar, and the phone's bar is not drawn", () => {
    setShell("desktop");
    render(<NavigationSetting />);
    expect(phoneSlots()).toHaveLength(0);
    expect(barIds().slice(0, 3)).toEqual(["notes", "tasks", "graph"]);
    expect(within(desktopBar()!).getByText("Notes")).toBeInTheDocument();
  });

  it("on the phone shell the preview is the bottom bar, and the top bar is not drawn", () => {
    render(<NavigationSetting />);
    expect(phoneSlots()).toHaveLength(1);
    expect(desktopBar()).toBeNull();
  });

  it("the phone preview holds only what the phone's bar holds, so nothing runs past its edge", async () => {
    await storeLayout({ order: ["tasks", "graph", "review", "reading", "website"], phone: 1 });
    render(<NavigationSetting />);
    expect([...document.querySelectorAll<HTMLElement>(".nav-bar-preview > li")].map((li) => li.dataset.destination))
      .toEqual(["notes", "capture", "tasks", "more"]);
  });

  it("clicking the desktop preview opens nothing and lights nothing", () => {
    setShell("desktop");
    const pushState = vi.spyOn(window.history, "pushState");
    render(<NavigationSetting />);
    for (const button of desktopBar()!.querySelectorAll("button")) fireEvent.click(button);
    fireEvent.contextMenu(desktopBar()!.querySelector('[data-destination="graph"]')!);
    expect(pushState).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(desktopBar()!.querySelector("[aria-current]")).toBeNull();
    expect(desktopBar()).toHaveAttribute("aria-hidden", "true");
    expect(desktopBar()).toHaveAttribute("inert");
  });

  it("the desktop list never says 「電腦才顯示」", async () => {
    setShell("desktop");
    await storeLayout({ order: ["tasks", "graph", "review", "reading", "website"], phone: 1 });
    render(<NavigationSetting />);
    expect(screen.queryByText("Computer only")).toBeNull();
  });

  it("entries folded into 「更多 ▾」 are marked, and the list agrees with the preview", async () => {
    setShell("desktop");
    barWidth(550);
    await storeLayout({ order: ["tasks", "graph", "review", "reading", "website"], phone: 1 });
    render(<NavigationSetting />);
    await waitFor(() => expect(marked()).toEqual(["reading", "website"]));
    // Preview: the entries it draws, then 更多 ▾ — the pinned ones missing from it are the marked rows.
    expect(barIds()).toEqual(["notes", "tasks", "graph", "review"]);
    expect(desktopBar()!.querySelector(".topbar-more-btn")).not.toBeNull();
    const inBar = new Set(barIds());
    const pinnedRows = listIds().filter((id) => id !== "notes" && id !== "more");
    expect(pinnedRows.filter((id) => !inBar.has(id))).toEqual(marked());
    // 更多 is the list's last row, where the bar has it.
    expect(listIds().at(-1)).toBe("more");
  });

  it("with room for everything and nothing left out, the bar has no 更多 and neither does the list", async () => {
    setShell("desktop");
    await storeLayout({ order: ["tasks", "today", "graph", "timeline", "review", "reading", "website"], phone: 1 });
    render(<NavigationSetting />);
    expect(desktopBar()!.querySelector(".topbar-more-btn")).toBeNull();
    expect(rowOf("more")).toBeNull();
    expect(marked()).toEqual([]);
  });

  it("the phone's ＋ is not a desktop row and the phone-only 更多 position is not used", async () => {
    setShell("desktop");
    render(<NavigationSetting />);
    expect(listIds()).not.toContain("capture");
    expect(listIds()[0]).toBe("notes");
  });
});
