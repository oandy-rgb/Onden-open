// @vitest-environment jsdom
// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { evenOrderKey } from "@onden/markdown/contract";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import OverviewSidebar from "../components/OverviewSidebar";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { resetAppState, openOverviewSearch, getAppState, setData, type AppState } from "../lib/appStore";
import { applySyncDelta } from "../lib/data/storeOps";
import { sortChildren } from "../lib/childOrder";
import { sidebarGroups } from "./fixtures/sidebarGroups";
import { reads } from "../lib/data";
import { resetSpacesForTest } from "../lib/spaces";

// The sidebar pulls notes/inbox/tag state from the app store (H4); only the
// localDb-backed search needs mocking (sql.js never loads in jsdom).
vi.mock("../lib/localDb", () => ({
  searchNodes: vi.fn(async () => []),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const makeNode = (overrides: Partial<ContentNode> = {}): ContentNode => ({
  id: Math.random().toString(36).slice(2),
  title: "Test Note",
  slug: "test-note",
  markdown: "",
  node_type: "content",
  source_type: "manual",
  ...overrides,
});

/** Seed the store with `nodes` (a hidden row — a hidden tag, or a note hidden
 *  before only tags could be, D104 — is in neither the list nor the inbox). */
function seed(nodes: ContentNode[] = [], state: Partial<AppState> = {}) {
  resetAppState({
    data: { ...noWorkspaceData, nodes },
    online: true,
    ...state,
  });
}

const defaultProps = () => sidebarGroups();

beforeEach(() => seed());
afterEach(() => resetAppState());

// ── Tab navigation ────────────────────────────────────────────────────────────

describe("OverviewSidebar tabs", () => {
  it("renders the Notes tab and no review tab: decisions live in the note and the inbox page", () => {
    render(<OverviewSidebar {...defaultProps()} />);
    expect(screen.getByText("Notes")).toBeInTheDocument();
    expect(screen.queryByText(/Review queue/)).toBeNull();
    expect(screen.queryByText("待審")).toBeNull();
  });

  it("marks the active tab with active class", () => {
    render(<OverviewSidebar {...defaultProps()} />);
    expect(screen.getByRole("button", { name: "Notes" })).toHaveClass("active");
  });
});

// ── Notes list ────────────────────────────────────────────────────────────────

describe("OverviewSidebar expandable search", () => {
  it("starts collapsed and opens a focused search from its named button", () => {
    render(<OverviewSidebar {...defaultProps()} />);
    const toggle = screen.getByRole("button", { name: "Search notes" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("searchbox", { name: "Search notes…" })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("searchbox", { name: "Search notes…" })).toHaveFocus();
  });

  it("Escape clears the search and returns focus without changing the selected note", () => {
    seed([makeNode({ id: "selected", title: "Alpha" })], { selectedId: "selected" });
    render(<OverviewSidebar {...defaultProps()} />);
    const toggle = screen.getByRole("button", { name: "Search notes" });
    fireEvent.click(toggle);
    const input = screen.getByRole("searchbox", { name: "Search notes…" });
    fireEvent.change(input, { target: { value: "Alpha" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("searchbox", { name: "Search notes…" })).toBeNull();
    expect(toggle).toHaveFocus();
    expect(getAppState().overviewSearch).toBe("");
    expect(getAppState().selectedId).toBe("selected");
  });

  it("arrows, Enter and Escape mid-IME-composition belong to the candidate list, not the results", async () => {
    seed([makeNode({ id: "a", title: "Alpha" }), makeNode({ id: "b", title: "Alpha two" })]);
    render(<OverviewSidebar {...defaultProps()} />);
    fireEvent.click(screen.getByRole("button", { name: "Search notes" }));
    const input = screen.getByRole("searchbox", { name: "Search notes…" });
    fireEvent.change(input, { target: { value: "Alpha" } });
    await screen.findAllByText(/Alpha/);
    for (const key of ["ArrowDown", "ArrowUp", "Enter", "Escape"]) {
      // fireEvent returns false when the handler called preventDefault
      expect(fireEvent.keyDown(input, { key, isComposing: true })).toBe(true);
      expect(fireEvent.keyDown(input, { key, keyCode: 229 })).toBe(true);
    }
    expect(screen.getByRole("searchbox", { name: "Search notes…" })).toBeInTheDocument();
    expect(fireEvent.keyDown(input, { key: "ArrowDown" })).toBe(false);
  });

  it("the shortcut action reveals search from the tags tab and reselects an existing query", () => {
    seed([], { overviewPane: "tags" });
    render(<OverviewSidebar {...defaultProps()} />);
    act(() => openOverviewSearch());
    const input = screen.getByRole("searchbox", { name: "Search notes…" }) as HTMLInputElement;
    expect(input).toHaveFocus();
    expect(getAppState().overviewPane).toBe("nodes");
    fireEvent.change(input, { target: { value: "existing query" } });
    screen.getByRole("button", { name: "Notes" }).focus();
    act(() => openOverviewSearch());
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it("shows an existing query and lets the toggle explicitly close it", () => {
    seed([], { overviewSearch: "existing query" });
    render(<OverviewSidebar {...defaultProps()} />);
    expect(screen.getByRole("searchbox", { name: "Search notes…" })).toHaveValue("existing query");
    fireEvent.click(screen.getByRole("button", { name: "Search notes" }));
    expect(screen.queryByRole("searchbox", { name: "Search notes…" })).toBeNull();
    expect(getAppState().overviewSearch).toBe("");
  });

  it("keeps an expanded search from stealing focus when the sidebar remounts", () => {
    const content = <><button>Other destination</button><OverviewSidebar {...defaultProps()} /></>;
    const view = render(content);
    act(() => openOverviewSearch());
    expect(screen.getByRole("searchbox", { name: "Search notes…" })).toHaveFocus();
    view.rerender(<button>Other destination</button>);
    screen.getByRole("button", { name: "Other destination" }).focus();
    view.rerender(content);
    expect(screen.getByRole("searchbox", { name: "Search notes…" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Other destination" })).toHaveFocus();
  });
});

describe("OverviewSidebar notes list", () => {
  it("highlights no row and scrolls nowhere when no note is open", async () => {
    vi.useFakeTimers();
    const proto = HTMLElement.prototype as { scrollIntoView?: () => void };
    const hadScroll = "scrollIntoView" in proto;
    const scroll = vi.fn();
    proto.scrollIntoView = scroll;
    try {
      seed([makeNode({ id: "a", title: "Alpha" }), makeNode({ id: "b", title: "Beta" })], { selectedId: null });
      const { container } = render(<OverviewSidebar {...defaultProps()} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      expect(container.querySelector(".obsidian-page-button.active")).toBeNull();
      expect(scroll).not.toHaveBeenCalled();
    } finally {
      if (!hadScroll) delete proto.scrollIntoView;
      vi.useRealTimers();
    }
  });

  it("renders node titles", () => {
    seed([makeNode({ title: "Alpha" }), makeNode({ title: "Beta" })]);
    render(<OverviewSidebar {...defaultProps()} />);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("offers no trash button on a reserved tag's row (T1)", async () => {
    resetAppState({
      data: { ...noWorkspaceData,
        nodes: [makeNode({ id: "task-tag", title: "Tasks", node_type: "class_tag" }), makeNode({ id: "n1", title: "Tasks note" })],
        tags: [{ id: "task-tag", name: "Tasks", reserved_key: "task", color: "", schema_id: null }] },
      online: true,
      overviewSearch: "Tasks",
    });
    render(<OverviewSidebar {...defaultProps()} />);
    expect(await screen.findByText(/2 results/)).toBeInTheDocument();
    const rows = Array.from(document.querySelectorAll(".obsidian-search-row"));
    const tagRow = rows.find((r) => r.querySelector(".sb-tag-node"))!;
    const noteRow = rows.find((r) => !r.querySelector(".sb-tag-node"))!;
    expect(noteRow.querySelector(".obsidian-delete-btn")).not.toBeNull();
    expect(tagRow.querySelector(".obsidian-delete-btn")).toBeNull();
  });

  it("offers no trash button to a viewer: the server would refuse the delete (D112)", async () => {
    resetSpacesForTest();
    // The selected row scrolls into view after the wait below; jsdom has no scrolling.
    const proto = HTMLElement.prototype as { scrollIntoView?: () => void };
    const hadScroll = "scrollIntoView" in proto;
    if (!hadScroll) proto.scrollIntoView = () => {};
    vi.spyOn(reads.people, "spaces").mockResolvedValue({ spaces: [
      { id: "team", kind: "shared", permission: "view", can_manage: false, name: "Team", is_default: false, capabilities: {} },
      { id: "mine", kind: "personal", permission: "edit", can_manage: true, name: "Mine", is_default: false, capabilities: {} },
    ] } as never);
    seed([makeNode({ id: "ro", title: "Read only", space_id: "team" }), makeNode({ id: "own", title: "My note", space_id: "mine" })]);
    render(<OverviewSidebar {...defaultProps()} />);
    const row = (title: string) => screen.getByText(title).closest("[data-sb-id]")!;
    await vi.waitFor(() => expect(row("Read only").querySelector(".obsidian-delete-btn")).toBeNull());
    expect(row("My note").querySelector(".obsidian-delete-btn")).not.toBeNull();
    // Let the deferred scroll run, then put jsdom back.
    await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
    if (!hadScroll) delete proto.scrollIntoView;
    vi.restoreAllMocks();
    resetSpacesForTest();
  });

  it("calls onSelectNode when a note is clicked", () => {
    const props = defaultProps();
    seed([makeNode({ id: "abc", title: "Click Me" })]);
    render(<OverviewSidebar {...props} />);
    fireEvent.click(screen.getByText("Click Me"));
    expect(props.nav.openNote).toHaveBeenCalledWith("abc");
  });

  it("shows empty state when no search results", async () => {
    seed([], { overviewSearch: "nothing" });
    render(<OverviewSidebar {...defaultProps()} />);
    // Said once the search has answered, not while it is still on its way.
    expect(await screen.findByText(/no results/i)).toBeInTheDocument();
  });

  it("shows a nested result's ancestor path", async () => {
    seed([
      makeNode({ id: "root", title: "Courses" }),
      makeNode({ id: "mid", title: "Algorithms", parent_id: "root" }),
      makeNode({ id: "leaf", title: "Heap sort notes", parent_id: "mid" }),
    ], { overviewSearch: "Heap sort" });
    render(<OverviewSidebar {...defaultProps()} />);
    expect(await screen.findByText("Courses › Algorithms")).toBeInTheDocument();
  });

  it("shows search result count", async () => {
    seed([makeNode({ title: "Found" })], { overviewSearch: "Found" });
    render(<OverviewSidebar {...defaultProps()} />);
    // Results arrive through the 120ms-debounced search effect.
    expect(await screen.findByText(/1 result/)).toBeInTheDocument();
  });
});

// ── Tag section (under the notes tree on a wide screen) ──────────────────────

describe("OverviewSidebar tag section", () => {
  const rowNames = () => [...document.querySelectorAll(".sb-tagtree-list > li .sb-tagtree-label")].map((el) => el.textContent);

  it("lists a row per tag; a row opens the tag's page", () => {
    const react = { id: "tag-react", name: "react", color: "", schema_id: null };
    resetAppState({
      data: { ...noWorkspaceData, nodes: [makeNode({ title: "Hello", label_tag_ids: [react.id] })], tags: [react] },
      online: true,
    });
    const props = defaultProps();
    render(<OverviewSidebar {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Open #react" }));
    expect(props.nav.openTag).toHaveBeenCalledWith("tag-react");
  });

  it("a #word in a note's body or title is not a tag and gets no row (T10)", () => {
    const foo = { id: "tag-foo", name: "foo", color: "", schema_id: null };
    resetAppState({
      data: { ...noWorkspaceData, tags: [foo], nodes: [
        makeNode({ title: "讀書 #foo", markdown: "Hello #foo and #bar\n#基本原理-微小的改變\n#1" }),
      ] },
      online: true,
    });
    render(<OverviewSidebar {...defaultProps()} />);
    expect(rowNames()).toEqual(["foo"]);
  });

  it("a tag titled subscription is an ordinary tag: RSS hides no tag any more", () => {
    const tag = (id: string, name: string, parent_id: string | null) => ({ id, name, parent_id, color: "", schema_id: null });
    resetAppState({
      data: { ...noWorkspaceData,
        nodes: [makeNode({ id: "mine", label_tag_ids: ["mine"] })],
        tags: [tag("reading", "reading", null), tag("mine", "subscription", "reading")] },
      online: true,
    });
    render(<OverviewSidebar {...defaultProps()} />);
    fireEvent.click(screen.getByRole("button", { name: "Show sub-tags of #reading" }));
    expect(rowNames()).toEqual(["reading", "subscription"]);
  });

  it("same-named tags are two rows in their own places, each opening its own tag", () => {
    // Root #draft and #proj/draft used to collapse into one "draft" entry
    // that opened whichever came first (T4).
    const tag = (id: string, name: string, parent_id: string | null = null) =>
      ({ id, name, parent_id, color: "", schema_id: null });
    resetAppState({
      data: { ...noWorkspaceData,
        nodes: [
          makeNode({ id: "a", label_tag_ids: ["draft"] }),
          makeNode({ id: "b", label_tag_ids: ["proj-draft"] }),
          makeNode({ id: "c", label_tag_ids: ["proj-draft"] }),
        ],
        tags: [tag("draft", "draft"), tag("proj", "proj"), tag("proj-draft", "draft", "proj")] },
      online: true,
    });
    const props = defaultProps();
    render(<OverviewSidebar {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Show sub-tags of #proj" }));
    const drafts = screen.getAllByRole("button", { name: "Open #draft" });
    expect(drafts).toHaveLength(2);
    // The counts are direct: #proj itself has no note.
    expect(screen.getByRole("button", { name: "Open #proj" }).textContent).toBe("#proj0");
    fireEvent.click(drafts[0]);
    expect(props.nav.openTag).toHaveBeenCalledWith("draft");
    fireEvent.click(drafts[1]);
    expect(props.nav.openTag).toHaveBeenLastCalledWith("proj-draft");
  });
});

describe("no 「已隱藏」 group (D104: only tags can be hidden)", () => {
  it("lists no hidden group, even for a note hidden before the change", () => {
    seed([makeNode({ id: "plain", title: "Plain note" }), makeNode({ id: "h1", title: "Tucked away", hidden: true })]);
    const { container } = render(<OverviewSidebar {...defaultProps()} />);
    expect(screen.queryByRole("button", { name: /Hidden/ })).toBeNull();
    expect(container.querySelector(".sb-hidden-group")).toBeNull();
    expect(screen.getByText("Plain note")).toBeInTheDocument();
  });

  it("a hidden note's children stay in the list (D104)", () => {
    seed([makeNode({ id: "h1", title: "Tucked away", hidden: true }), makeNode({ id: "kid", title: "Child of a hidden note", parent_id: "h1" })]);
    render(<OverviewSidebar {...defaultProps()} />);
    expect(screen.getByText("Child of a hidden note")).toBeInTheDocument();
    expect(screen.queryByText("Tucked away")).toBeNull();
  });
});

describe("tags in the note list", () => {
  it("lists a tag once, under TAGS, not again among the notes; a note filed under it stays visible", () => {
    const tag = makeNode({ id: "tag-ideas", title: "ideas", node_type: "class_tag" });
    const filed = makeNode({ id: "filed", title: "Filed under a tag", parent_id: "tag-ideas" });
    const plain = makeNode({ id: "plain", title: "Plain note" });
    seed([tag, filed, plain]);
    const { container } = render(<OverviewSidebar {...defaultProps()} />);
    const list = container.querySelector(".obsidian-page-list")!;
    expect(list.querySelector(".sb-tag-node")).toBeNull();
    expect(list.textContent).toContain("Plain note");
    expect(list.textContent).toContain("Filed under a tag");
  });

  it("a hidden tag has no row in the tag section; its notes stay in the list (D104)", () => {
    const shown = makeNode({ id: "tag-shown", title: "ideas", node_type: "class_tag" });
    const secret = makeNode({ id: "tag-secret", title: "secret", node_type: "class_tag", hidden: true });
    const filed = makeNode({ id: "filed", title: "Filed under the secret tag", parent_id: "tag-secret", label_tag_ids: ["tag-secret", "tag-shown"] });
    resetAppState({
      data: { ...noWorkspaceData, nodes: [shown, secret, filed],
        tags: [{ id: "tag-shown", name: "ideas", color: "", schema_id: null }, { id: "tag-secret", name: "secret", color: "", schema_id: null, hidden: true }] },
      online: true,
    });
    const { container } = render(<OverviewSidebar {...defaultProps()} />);
    const rows = [...container.querySelectorAll(".sb-tagtree-label")].map((el) => el.textContent ?? "");
    expect(rows).toContain("ideas");
    expect(rows).not.toContain("secret");
    expect(container.querySelector(".obsidian-page-list")!.textContent).toContain("Filed under the secret tag");
  });
});

describe("generated items in the note list", () => {
  it("leaves RSS sources out and keeps a board among the notes with its mark and its cards; there is no switch to show them", () => {
    const board = makeNode({ id: "board", title: "Research map", node_type: "canvas" });
    resetAppState({
      data: {
        ...noWorkspaceData,
        nodes: [makeNode({ id: "mine", title: "My note" }), makeNode({ id: "feed", title: "Some feed", source_type: "rss" }), board, makeNode({ id: "card", title: "Board card" })],
        canvas_memberships: [{ canvas_id: "board", canvas_title: "Research map", node_id: "card" }],
      },
      online: true,
    });
    render(<OverviewSidebar {...sidebarGroups({ tree: { expandedGroups: new Set(["board"]) } })} />);
    expect(screen.getByText("My note")).toBeInTheDocument();
    expect(screen.queryByText("Some feed")).not.toBeInTheDocument();
    // One space: no group headings, and no "Canvas" group.
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    const boardRow = screen.getByText("Research map").closest("[data-sb-id]")!;
    // A canvas-type note and a note on a canvas look like any other note.
    expect(boardRow.querySelector("[aria-label]:not(.obsidian-delete-btn)")).toBeNull();
    expect(boardRow.textContent).not.toContain("📐");
    expect(screen.getByText("Board card").closest("[data-sb-id]")!.textContent).not.toContain("📐");
    expect(screen.getByText("Board card")).toBeInTheDocument();

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByText(/generated items/i)).not.toBeInTheDocument();
  });
});

// D64: the sidebar's natural order is the one sibling rule (lib/childOrder),
// not the store's array order.
describe("OverviewSidebar sibling order", () => {
  const at = (i: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString();
  const family = () => [
    makeNode({ id: "p", title: "P", order_key: "a0", created_at: at(0) }),
    ...["a", "b", "c"].map((id, i) => makeNode({ id, title: id.toUpperCase(), parent_id: "p", order_key: evenOrderKey(i), created_at: at(1 + i) })),
  ];
  const childRows = (container: HTMLElement) =>
    [...container.querySelectorAll("[data-sb-id]")].map((el) => el.getAttribute("data-sb-id")).filter((id) => id !== "p");
  const expanded = () => sidebarGroups({ tree: { expandedGroups: new Set(["p"]) } });

  it("lists a new child where the canvas and a reload put it", () => {
    const nodes = [...family(), makeNode({ id: "d", title: "D", parent_id: "p", order_key: "a0", created_at: at(9) })];
    seed(nodes);
    const { container } = render(<OverviewSidebar {...expanded()} />);
    const canvas = sortChildren(nodes.filter((n) => n.parent_id === "p")).map((n) => n.id);
    expect(canvas).toEqual(["a", "d", "b", "c"]);
    expect(childRows(container)).toEqual(canvas);
  });

  it("an edited note keeps its place after the sync moves its row", () => {
    seed(family());
    const { container } = render(<OverviewSidebar {...expanded()} />);
    expect(childRows(container)).toEqual(["a", "b", "c"]);
    const edited = { ...getAppState().data.nodes.find((n) => n.id === "a")!, title: "A renamed" };
    act(() => setData((data) => applySyncDelta(data, {
      last_event_id: 2, nodes: { upsert: [edited], delete: [] }, edges: { upsert: [], delete: [] },
      tasks: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null,
    })));
    expect(getAppState().data.nodes.at(-1)!.id).toBe("a");
    expect(childRows(container)).toEqual(["a", "b", "c"]);
  });
});

// Phones scroll the PAGE, not the list (mobileListScroll.spec), so the long
// list is windowed against where it sits in the browser viewport.
describe("OverviewSidebar phone list windowing", () => {
  const originalMatchMedia = window.matchMedia;
  const originalRaf = window.requestAnimationFrame;
  beforeEach(() => {
    window.matchMedia = vi.fn((query: string) => ({
      matches: query.includes("max-width: 900px"), media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    // Runs the frame at once; returning 0 leaves no frame "pending" afterwards.
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 0; }) as typeof window.requestAnimationFrame;
  });
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    window.requestAnimationFrame = originalRaf;
  });
  const many = (count: number) => Array.from({ length: count }, (_, i) =>
    makeNode({ id: `n${i}`, title: `Note ${i}`, order_key: evenOrderKey(i), created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }));
  const rowIds = (container: HTMLElement) => [...container.querySelectorAll(".obsidian-page-list [data-sb-id]")].map((el) => el.getAttribute("data-sb-id"));

  it("draws a window of a long list, not every row, and keeps the list a non-scroller", () => {
    seed(many(2000));
    const { container } = render(<OverviewSidebar {...defaultProps()} />);
    const ids = rowIds(container);
    expect(ids.length).toBeGreaterThan(10);
    expect(ids.length).toBeLessThan(120);
    const spacers = container.querySelectorAll(".sb-virt-spacer");
    expect(spacers).toHaveLength(2);
    // The rows not drawn still take their height, so the page scrolls as far.
    expect((spacers[1] as HTMLElement).style.getPropertyValue("--sb-spacer-h")).not.toBe("0px");
    // No inline scroll handler/overflow: the page keeps scrolling under a finger.
    expect((container.querySelector(".obsidian-page-list") as HTMLElement).style.overflowY).toBe("");
  });

  it("follows the page scroll to the rows in view", () => {
    seed(many(2000));
    const { container } = render(<OverviewSidebar {...defaultProps()} />);
    const list = container.querySelector(".obsidian-page-list") as HTMLElement;
    const order = rowIds(container);
    const first = order[0];
    // The list's top edge is now 20,000 px above the viewport.
    const rect = { top: -20_000, bottom: 0, left: 0, right: 390, width: 390, height: 0, x: 0, y: -20_000, toJSON: () => ({}) };
    list.getBoundingClientRect = () => rect;
    // jsdom lays nothing out; a shown list has a box.
    list.getClientRects = () => [rect] as unknown as DOMRectList;
    act(() => { window.dispatchEvent(new Event("scroll")); });
    const ids = rowIds(container);
    expect(ids).not.toContain(first);
    expect(ids.length).toBeLessThan(120);
    // The default 35 px pitch: 20,000 px ≈ row 571, minus the overscan.
    const top = (container.querySelector(".sb-virt-spacer") as HTMLElement).style.getPropertyValue("--sb-spacer-h");
    expect(parseFloat(top)).toBeGreaterThan(15_000);
  });

  it("ignores page scrolling while the list is hidden behind an open note", () => {
    seed(many(2000));
    const { container } = render(<OverviewSidebar {...defaultProps()} />);
    const list = container.querySelector(".obsidian-page-list") as HTMLElement;
    const before = rowIds(container);
    let measured = 0;
    list.getBoundingClientRect = () => { measured++; return { top: -20_000, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }; };
    act(() => { window.dispatchEvent(new Event("scroll")); });
    expect(measured).toBe(0);
    expect(rowIds(container)).toEqual(before);
  });

  it("re-reads the window when the list is shown again without a scroll event", () => {
    const observers: Array<() => void> = [];
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(cb: () => void) { observers.push(cb); }
      observe() {} unobserve() {} disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      seed(many(2000));
      const { container } = render(<OverviewSidebar {...defaultProps()} />);
      const list = container.querySelector(".obsidian-page-list") as HTMLElement;
      const at = (top: number) => {
        const rect = { top, bottom: 0, left: 0, right: 390, width: 390, height: 0, x: 0, y: top, toJSON: () => ({}) };
        list.getBoundingClientRect = () => rect;
        list.getClientRects = () => [rect] as unknown as DOMRectList;
      };
      // Scrolled deep, then a note opened and closed: the page is back at the top.
      at(-20_000);
      act(() => { window.dispatchEvent(new Event("scroll")); });
      expect(rowIds(container)).not.toContain("n0");
      at(300);
      act(() => { observers.forEach((cb) => cb()); });
      expect(rowIds(container)).toContain("n0");
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  it("small lists still render every row (nested groups keep their guides)", () => {
    seed(many(40));
    const { container } = render(<OverviewSidebar {...defaultProps()} />);
    expect(rowIds(container)).toHaveLength(40);
    expect(container.querySelector(".sb-virt-spacer")).toBeNull();
  });
});

// Paper cuts from a 390px phone: four header layers before the first note.
// The phone list has ONE header row (tabs left, named icon tools right); the
// desktop rail keeps its second row of text buttons.
describe("OverviewSidebar header rows", () => {
  const originalMatchMedia = window.matchMedia;
  const phone = (on: boolean) => {
    window.matchMedia = vi.fn((query: string) => ({
      matches: on && query.includes("max-width: 900px"), media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
  };
  afterEach(() => { window.matchMedia = originalMatchMedia; });

  it("on a phone the tabs and the tools share one row, every tool named", () => {
    phone(true);
    const { container } = render(<OverviewSidebar {...defaultProps()} />);
    const header = container.querySelector(".obsidian-sidebar-header") as HTMLElement;
    expect(container.querySelector(".sidebar-sort-bar")).toBeNull();
    expect(header.querySelector(".sidebar-tabs")).not.toBeNull();
    const names = [...header.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim());
    // The tools are exactly 🔍 ＋ ⋯; the order and expand tools are in ⋯.
    expect(names.slice(names.indexOf("Notes") + 1)).toEqual(["Inbox", "Search notes", "Create", "More"]);
    // No bare text buttons for the tools: icons with accessible names.
    for (const label of ["Search notes", "Create", "More"]) {
      expect(within(header).getByRole("button", { name: label }).textContent?.trim()).toBe("");
    }
  });

  it("the expand tool names what it will do", () => {
    phone(true);
    seed([makeNode({ id: "p", title: "Parent" }), makeNode({ id: "c", title: "Child", parent_id: "p" })]);
    render(<OverviewSidebar {...defaultProps()} />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitem", { name: "Expand all" })).toBeInTheDocument();
  });

  it("on desktop the tools stay on their own row with text labels", () => {
    phone(false);
    const { container } = render(<OverviewSidebar {...defaultProps()} />);
    const bar = container.querySelector(".sidebar-sort-bar") as HTMLElement;
    expect(bar).not.toBeNull();
    expect(container.querySelector(".obsidian-sidebar-header .sidebar-sort-dropdown")).toBeNull();
    expect(within(bar).getByRole("button", { name: "Sort" })).toHaveTextContent("Sort");
    expect(within(bar).getByRole("button", { name: "Open" })).toHaveAttribute("title", "Expand all");
  });

  it("keeps the tag section under the tree on desktop (no chip panel); the phone has the 標籤 tab instead", () => {
    seed([makeNode({ id: "x", title: "X" })]);
    phone(false);
    const wide = render(<OverviewSidebar {...defaultProps()} onCreateTag={vi.fn()} />);
    expect(wide.container.querySelector(".sb-tagtree--section")).not.toBeNull();
    expect(wide.container.querySelector(".sidebar-tag-panel")).toBeNull();
    wide.unmount();
    phone(true);
    const narrow = render(<OverviewSidebar {...defaultProps()} onCreateTag={vi.fn()} />);
    expect(narrow.container.querySelector(".sb-tagtree--section")).toBeNull();
  });
});
