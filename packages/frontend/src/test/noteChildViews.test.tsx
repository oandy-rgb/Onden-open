// A note's sub-notes and their views (docs/architecture/views-as-modules.md
// 「檢視的來源」): under the note's text they are a plain list (SubNotesList)
// whose heading folds, with no view menu of its own; the table, calendar,
// board and cards are tabs above the note (components/viewTabs), and a saved
// view runs over the children through the view modules' layouts (CollectionView).
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import SubNotesList from "../components/SubNotesList";
import NoteRelations from "../components/NoteRelations";
import CollectionView from "../components/collections/CollectionView";
import { resetOwnerViews } from "../lib/ownerViews";
import { sharedChildFields } from "../lib/childFields";
import type { ContentNode, Tag } from "../lib/api";
import { resetAppState, setAppState } from "../lib/appStore";
import { PREFS, getPref, setPref } from "../lib/prefs";

vi.mock("../lib/localDb", async (original) => ({ ...await original<typeof import("../lib/localDb")>(), getPendingWrites: vi.fn(async () => []) }));

const created = vi.hoisted(() => [] as unknown[][]);
vi.mock("../lib/data/domainWriters", async (load) => {
  const actual = await load<typeof import("../lib/data/domainWriters")>();
  return { ...actual, viewWriter: { ...actual.viewWriter, create: vi.fn(async (...args: unknown[]) => { created.push(args); return null; }) } };
});

const PARENT = "00000000-0000-4000-8000-00000000a001";
const reply = vi.hoisted(() => ({ views: [] as unknown[], exec: {} as Record<string, unknown> }));
const requested = vi.hoisted(() => [] as string[]);
vi.mock("../lib/api", async (original) => {
  const actual = await original<typeof import("../lib/api")>();
  return {
    ...actual,
    api: vi.fn(async (path: string) => {
      requested.push(path);
      if (path === `/api/nodes/${PARENT}/views`) return { views: reply.views };
      const exec = /\/views\/([^/]+)\/exec/.exec(path);
      if (exec && reply.exec[exec[1]!]) return reply.exec[exec[1]!];
      throw new Error(`unexpected ${path}`);
    }),
  };
});

const book: Tag = { id: "tag-book", name: "book", slug: "book", node_type: "class_tag", schema_fields: [{ name: "author", type: "text" }, { name: "pages", type: "number" }] } as unknown as Tag;
const child = (id: string, title: string, extra: Partial<ContentNode> = {}): ContentNode =>
  ({ id, title, parent_id: PARENT, node_type: "content", hidden: false, markdown: "", updated_at: "2026-10-01T00:00:00Z", attrs: {}, ...extra }) as ContentNode;
const parent = { id: PARENT, title: "Reading list", node_type: "content", parent_id: null } as unknown as ContentNode;

describe("sharedChildFields", () => {
  it("keeps the fields at least two sub-notes have: their tags' fields first, then properties", () => {
    const kids = [
      child("a", "Dune", { class_tag_ids: ["tag-book"], attrs: { author: "Herbert", mood: "grand", _x: "1", ink_data: "{}" } }),
      child("b", "Emma", { class_tag_ids: ["tag-book"], attrs: { mood: "light" } }),
      child("c", "Notes", { attrs: { once: "only here" } }),
    ];
    expect(sharedChildFields(kids, [book]).map((f) => [f.name, f.type])).toEqual([["author", "text"], ["pages", "number"], ["mood", "text"]]);
  });

  it("a single sub-note's own fields count; none at all gives no fields", () => {
    expect(sharedChildFields([child("a", "Dune", { attrs: { mood: "grand" } })], []).map((f) => f.name)).toEqual(["mood"]);
    expect(sharedChildFields([child("a", "A"), child("b", "B")], [book])).toEqual([]);
  });
});


function setModules(modules: string[] | null) {
  setAppState((s) => ({ data: { ...s.data, tags: [book], workspace: { ...s.data.workspace, modules } } }));
}

describe("sub-notes list", () => {
  beforeEach(() => { resetAppState(); setModules(null); });

  it("lists the sub-notes with the fields they share, and a row opens the note", () => {
    const onOpenNote = vi.fn();
    const kids = [child("a", "Dune", { class_tag_ids: ["tag-book"], attrs: { author: "Herbert" } }), child("b", "Emma", { class_tag_ids: ["tag-book"] })];
    setAppState((s) => ({ data: { ...s.data, tags: [book] } }));
    render(<SubNotesList subNotes={kids} onOpenNote={onOpenNote} />);
    const table = screen.getByRole("table");
    // "pages" has no value on any sub-note: its column is left out.
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Title", "author"]);
    fireEvent.click(within(table).getByRole("button", { name: "Emma" }));
    expect(onOpenNote).toHaveBeenCalledWith("b");
  });

  it("without shared fields it is a flat list of titles: no inset class of the tag page, no dividers", () => {
    const { container } = render(<SubNotesList subNotes={[child("a", "Dune"), child("b", "Emma")]} onOpenNote={() => {}} />);
    expect(screen.queryByRole("table")).toBeNull();
    expect(container.querySelector("ul.tag-member-list")).toHaveClass("tag-member-list--flat");
  });
});

describe("the sub-notes section of a note's page", () => {
  beforeEach(() => {
    resetAppState();
    localStorage.clear();
    const kids = [child("a", "Dune"), child("b", "Emma")];
    setAppState((s) => ({ data: { ...s.data, nodes: [parent, ...kids] } }));
  });

  it("is only the list: no view menu, no 「新增檢視」, no 「全部 ▾」", async () => {
    const { container } = render(<NoteRelations node={parent} onOpenNote={() => {}} />);
    expect(await screen.findByRole("button", { name: "Dune" })).toBeInTheDocument();
    expect(container.querySelector(".cv-bar, .cv-bar-view, .cv-view-chip")).toBeNull();
    expect(screen.queryByText(/New view|Add a view/)).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("the heading folds the list, and the choice is one setting for every note", async () => {
    const { unmount } = render(<NoteRelations node={parent} onOpenNote={() => {}} />);
    const toggle = screen.getByRole("button", { name: /Sub-notes/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await screen.findByRole("button", { name: "Dune" });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Dune" })).toBeNull();
    expect(getPref(PREFS.noteSubNotesFolded)).toBe("1");
    unmount();
    // Another note, or a later visit: still folded.
    render(<NoteRelations node={parent} onOpenNote={() => {}} />);
    expect(screen.getByRole("button", { name: /Sub-notes/ })).toHaveAttribute("aria-expanded", "false");
    setPref(PREFS.noteSubNotesFolded, "0");
  });
});

const savedTable = (extra: Record<string, unknown> = {}) => ({ id: "shelf", node_id: PARENT, name: "Shelf", layout: "table", filters: [], sorts: [], group_by: null,
  visible_fields: ["title", "mood", "updated_at"], layout_config: {}, pin_order: 0, ...extra });
const execOf = (layout = "table", rows: Array<{ id: string; title: string; slug: string; updated_at: string; attributes: Record<string, string> }> = [{ id: "a", title: "Dune", slug: "a", updated_at: "2026-10-01T00:00:00Z", attributes: { mood: "grand" } }]) =>
  ({ rows, total: rows.length, next: null, view: { layout, group_by: null, visible_fields: ["title", "mood", "updated_at"], layout_config: {}, field_meta: {} } });
const pane = (canManage = true, onSelectNode = vi.fn()) =>
  render(<CollectionView source={{ kind: "node", id: PARENT, name: "Reading list" }} viewId="shelf" canManage={canManage} onSelectNode={onSelectNode} />);

describe("a saved view of a note's sub-notes", () => {
  beforeEach(() => {
    resetAppState();
    resetOwnerViews();
    localStorage.clear();
    setModules(null);
    reply.views = [];
    reply.exec = {};
    requested.length = 0;
  });

  it("renders through the table module's layout from the note's own endpoint, its title cell opening the note", async () => {
    reply.views = [savedTable()];
    reply.exec.shelf = execOf();
    const onSelectNode = vi.fn();
    pane(true, onSelectNode);
    const table = (await screen.findByText("grand")).closest("table")!;
    expect(table).toHaveClass("cv-table");
    expect(requested).toContain(`/api/nodes/${PARENT}/views/shelf/exec`);
    fireEvent.click(within(table).getByRole("button", { name: "Dune" }));
    expect(onSelectNode).toHaveBeenCalledWith("a");
  });

  it("a saved calendar shows although no view module is imported", async () => {
    setModules([]);
    reply.views = [savedTable({ name: "Month", layout: "calendar" })];
    reply.exec.shelf = execOf("calendar");
    pane();
    await waitFor(() => expect(document.querySelector(".cv-cal")).not.toBeNull(), { timeout: 4000 });
    expect(screen.queryByText(/is off/)).toBeNull();
  });

  it("the quick-add row is there only for whoever may edit the note", async () => {
    reply.views = [savedTable()];
    reply.exec.shelf = execOf();
    const reader = pane(false);
    await screen.findByText("Dune", { selector: ".cv-table-title" });
    expect(screen.queryByRole("button", { name: "New sub-note" })).toBeNull();
    reader.unmount();
    resetOwnerViews();
    pane(true);
    fireEvent.click(await screen.findByRole("button", { name: "New sub-note" }));
    expect(await screen.findByLabelText("Add a new sub-note to Reading list")).toBeInTheDocument();
  });

  it("the options hold layout and filter for an editor; a reader gets no options", async () => {
    reply.views = [savedTable()];
    reply.exec.shelf = execOf();
    const editor = pane(true);
    await screen.findByText("Dune", { selector: ".cv-table-title" });
    fireEvent.click(await screen.findByRole("button", { name: "View options" }));
    const menu = await screen.findByRole("menu", { name: "View options" });
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(
      expect.arrayContaining(["Filter, sort and group this view"]));
    expect(within(menu).queryByRole("menuitem", { name: "Reload query results" })).toBeNull();
    expect(within(menu).getByRole("menuitemradio", { name: "Table" })).toBeChecked();
    // Renaming and deleting are the tab's menu now, not this one.
    expect(within(menu).queryByRole("menuitem", { name: "Rename" })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "Delete view" })).toBeNull();
    editor.unmount();
    resetOwnerViews();

    pane(false);
    await screen.findByText("Dune", { selector: ".cv-table-title" });
    expect(screen.queryByRole("button", { name: "View options" })).toBeNull();
  });

  it("a table's Updated at is short (clock today, M/D this year, Y/M/D before) with the exact time in a tooltip, and it has no totals row", async () => {
    // A fixed clock: on the real one, a run in the first minute after midnight put "a minute ago" on
    // yesterday. 12:30 UTC is at least half an hour from midnight in every time zone.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-06-15T12:30:00Z") });
    onTestFinished(() => { vi.useRealTimers(); });
    const now = new Date();
    const today = new Date(now.getTime() - 60_000).toISOString();
    const lastYear = new Date(Date.UTC(now.getUTCFullYear() - 1, 5, 15, 12)).toISOString();
    reply.views = [savedTable({ visible_fields: ["title", "updated_at"] })];
    reply.exec.shelf = execOf("table", [
      { id: "a", title: "Dune", slug: "a", updated_at: today, attributes: {} },
      { id: "b", title: "Emma", slug: "b", updated_at: lastYear, attributes: {} },
    ]);
    (reply.exec.shelf as { view: { visible_fields: string[] } }).view.visible_fields = ["title", "updated_at"];
    const { container } = pane();
    await screen.findByText("Dune", { selector: ".cv-table-title" });
    const cells = [...container.querySelectorAll<HTMLElement>("tbody td:nth-child(2) span")];
    expect(cells).toHaveLength(2);
    expect(cells[0]!.textContent).toMatch(/^\d{2}:\d{2}$/);
    // Another year: the full date (the test locale writes it M/D/Y).
    expect(cells[1]!.textContent).toContain(String(now.getUTCFullYear() - 1));
    expect(cells[0]!.title).not.toBe("");
    expect(cells[0]!.title).not.toBe(cells[0]!.textContent);
    expect(container.querySelector("tfoot")).toBeNull();
  });

  it("offline the list under the text still shows the sub-notes from the local store", () => {
    render(<SubNotesList subNotes={[child("a", "Dune"), child("b", "Emma")]} onOpenNote={() => {}} />);
    expect(screen.getByRole("button", { name: "Dune" })).toBeInTheDocument();
    expect(screen.queryByText(/Failed/)).toBeNull();
  });
});
