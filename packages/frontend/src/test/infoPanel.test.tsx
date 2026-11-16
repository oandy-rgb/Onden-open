vi.mock("../lib/localDb", () => ({
  storeRejectedWrite: async (request: import("../lib/localDb").RejectedRequest, rejection: string) => ({ ...request, id: 901, attempts: 0, rejection }),
  getPendingWrites: vi.fn(async () => []), getNodeAttributeRecord: vi.fn(async () => null),
  upsertAttribute: vi.fn(async () => {}), removeAttribute: vi.fn(async () => {}),
}));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../modules/graph/AllCardsGraph", () => { throw new Error("the 「關係」 tab must not load the graph"); });
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import NodeInspector from "../components/NodeInspector";
import AppTopbar from "../components/AppTopbar";
import { noWorkspaceData, type ContentNode, type Tag } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { setLocalePref } from "../lib/i18n";
import { PREFS, getPref, setPref } from "../lib/prefs";
import { initialInfoTab, pickedInfoTab } from "../lib/infoPanel";
import type { NodeEdge } from "../lib/api";
import { activeHeadingIndex, extractHeadings } from "../lib/noteOutline";
import { useWorkspacePanes } from "../hooks/useWorkspacePanes";
import { loadNoteFunctionModules } from "./helpers/noteFunctionModules";
// The info panel asks for its modules' files with import() as it mounts; they are loaded first so that no test ends while one is still on its way.
await loadNoteFunctionModules();
// History rows read the session; the real store keeps a 1 s unmount timer that can outlive the test environment.
vi.mock("../lib/accountSession", () => ({ useAccountSession: () => null }));

// The notes page's right panel: tabs 「標籤」「段落」, one card per tag, old
// fields below, the headings list, and how the panel sits at each width.

const book: Tag = { id: "t-book", name: "書", color: "#a55", schema_id: "s-book",
  schema_fields: [{ name: "author", label: "Author", type: "text" }] };
const novel: Tag = { id: "t-novel", name: "小說", color: "#55a", schema_id: "s-novel", parent_id: "t-book",
  schema_fields: [{ name: "status", label: "Status", type: "text" }],
  effective_fields: [{ name: "status", label: "Status", type: "text" }, { name: "author", label: "Author", type: "text", inherited_from: "t-book" }] };
const review: Tag = { id: "t-review", name: "複習", color: "", schema_id: "s-review", schema_module: "review", effective_modules: ["review"] };
const meeting: Tag = { id: "t-meeting", name: "meeting", color: "#5a5", schema_id: "s-meeting", schema_fields: [] };

const mk = (id: string, extra: Partial<ContentNode> = {}): ContentNode => ({
  id, title: id, slug: id, markdown: "", node_type: "content", source_type: "manual", updated_at: "2026-10-01T00:00:00Z", ...extra,
});
const dune = mk("dune", { title: "Dune", class_tag_ids: ["t-novel", "t-review"], markdown: "# Dune\n## Part one\n### Arrakis\n" });

let attributes: Array<{ key: string; value: string }> = [];
function mockAttributes() {
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const own = url.includes("/attributes") && !url.includes("inherited") && !url.includes("rollup");
    const body = init?.method === "PATCH" || init?.method === "PUT" ? { ok: true }
      : own ? attributes.map((a) => ({ ...a, value_type: "text", is_inheritable: false, source: "explicit" })) : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

function seed(nodes: ContentNode[], tags: Tag[], owner = true) {
  resetAppState({ data: { ...noWorkspaceData, nodes, tags, actor_is_owner: owner }, online: true });
}
function width(px: number) {
  window.innerWidth = px;
  window.matchMedia = vi.fn((query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query), max = /max-width:\s*(\d+)px/.exec(query);
    const matches = (min ? px >= Number(min[1]) : true) && (max ? px <= Number(max[1]) : true);
    return { matches, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false };
  }) as unknown as typeof window.matchMedia;
}

beforeEach(() => { localStorage.clear(); attributes = []; mockAttributes(); act(() => setLocalePref("en")); });
afterEach(() => {
  vi.restoreAllMocks();
  resetAppState();
  act(() => setLocalePref("system"));
  delete (window as { matchMedia?: unknown }).matchMedia;
});

const panel = (node: ContentNode, props: Partial<React.ComponentProps<typeof NodeInspector>> = {}) =>
  render(<NodeInspector node={node} onSelectNode={props.onSelectNode ?? (() => {})} {...props} />);

describe("headings of the body", () => {
  it("lists h1–h3 in order with their line, skipping code fences and deeper levels", () => {
    const md = "# One\ntext\n```\n# not a heading\n```\n## Two **bold** [link](u) ##\n#### four\n### Three\n#nospace\n";
    expect(extractHeadings(md)).toEqual([
      { index: 0, level: 1, text: "One", line: 0 },
      { index: 1, level: 2, text: "Two bold link", line: 5 },
      { index: 2, level: 3, text: "Three", line: 7 },
    ]);
  });
  it("the active heading is the last one at or above the top of the page", () => {
    expect(activeHeadingIndex([-300, -20, 400], 0)).toBe(1);
    expect(activeHeadingIndex([200, 500], 0)).toBe(-1);
    expect(activeHeadingIndex([Infinity], 0)).toBe(-1);
  });
});

describe("which tab opens", () => {
  const none = { hasFunctions: false, hasTags: false, hasRelations: false };
  it("the person's own pick wins; else 功能 if it has anything; else tags, relations, and last the AI tab", () => {
    const all = { hasFunctions: true, hasTags: true, hasRelations: true };
    expect(initialInfoTab("relations", all)).toBe("relations");
    expect(initialInfoTab(null, all)).toBe("functions");
    expect(initialInfoTab(null, { ...all, hasFunctions: false })).toBe("tags");
    expect(initialInfoTab(null, { ...all, hasFunctions: false, hasTags: false })).toBe("relations");
    // Nothing else to show: the panel would be empty, so the AI tab opens (the person's own pick still wins).
    expect(initialInfoTab(null, none)).toBe("ai");
    expect(initialInfoTab("tags", none)).toBe("tags");
  });
  it("a saved 「段落」 (the retired tab) counts as never picked", () => {
    expect(pickedInfoTab("headings")).toBeNull();
    expect(pickedInfoTab("nonsense")).toBeNull();
    expect(pickedInfoTab("functions")).toBe("functions");
    seed([dune], [book, novel, review]);
    setPref(PREFS.infoPanelTab, "headings");
    panel(dune);
    expect(screen.getByRole("tab", { name: "Tags" })).toHaveAttribute("aria-selected", "true");
  });
  it("a note with tags and nothing under 功能 opens on 標籤; one with nothing opens on AI", () => {
    seed([dune], [book, novel, review]);
    const first = panel(dune);
    expect(screen.getByRole("tab", { name: "Tags" })).toHaveAttribute("aria-selected", "true");
    first.unmount();
    const plain = mk("plain", { markdown: "## Intro\n" });
    seed([plain], [book, novel, review]);
    panel(plain);
    expect(screen.getByRole("tab", { name: "AI" })).toHaveAttribute("aria-selected", "true");
    // The headings are the outline beside the text now, not a tab.
    expect(screen.queryByRole("tab", { name: "Paragraphs" })).toBeNull();
  });
  it("remembers a hand-picked tab on this device", () => {
    seed([dune], [book, novel, review]);
    const first = panel(dune);
    fireEvent.click(screen.getByRole("tab", { name: "Relations" }));
    expect(getPref(PREFS.infoPanelTab)).toBe("relations");
    first.unmount();
    panel(dune);
    expect(screen.getByRole("tab", { name: "Relations" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("the 功能 tab", () => {
  it("is the first tab and opens by default on an editable note (the tasks line is always offered); a hand-picked tab still wins", async () => {
    const plain = mk("plain", { markdown: "## Intro\n" });
    seed([plain], [book]);
    panel(plain, { onRunNoteCommand: () => {} });
    expect(screen.getAllByRole("tab")[0]).toHaveTextContent("Functions");
    expect(screen.getByRole("tab", { name: "Functions" })).toHaveAttribute("aria-selected", "true");
    // The modules' rows are loaded when the panel opens.
    expect(await screen.findByRole("button", { name: /Also usable here: .*Tasks/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Tags" }));
    expect(screen.getByRole("tab", { name: "Tags" })).toHaveAttribute("aria-selected", "true");
  });
  it("is not drawn for a note shown on a board's card (no text on screen)", () => {
    seed([dune], [book, novel, review]);
    panel(dune, { noHeadings: true, onRunNoteCommand: () => {} });
    expect(screen.queryByRole("button", { name: /Also usable here/ })).toBeNull();
  });
});

describe("tags tab", () => {
  it("one card per tag with its fields (inherited too); a module tag has no card; no free add row", async () => {
    attributes = [{ key: "status", value: "reading" }, { key: "author", value: "Herbert" }];
    seed([dune], [book, novel, review]);
    panel(dune);
    const card = await screen.findByRole("region", { name: "#小說" });
    await waitFor(() => expect(within(card).getByDisplayValue("reading")).toBeInTheDocument());
    expect(within(card).getByDisplayValue("Herbert")).toBeInTheDocument();
    expect(within(card).getByText("from #書")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "#複習" })).toBeNull();
    expect(screen.queryByPlaceholderText("name")).toBeNull();
    expect(screen.queryByTitle("Add field")).toBeNull();
    // The old "Properties" heading and the second "+ Tag" entry are gone.
    expect(screen.queryByRole("heading", { name: "Properties" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Tag" })).toBeNull();
  });
  it("an empty field invites with a grey hint: 加…⋯", async () => {
    act(() => setLocalePref("zh-TW"));
    seed([dune], [book, novel, review]);
    panel(dune);
    const card = await screen.findByRole("region", { name: "#小說" });
    await waitFor(() => expect(within(card).getAllByPlaceholderText(/^加/).length).toBeGreaterThan(0));
  });
  it("the owner gets 「編輯 #X 的欄位 →」; a non-owner does not", async () => {
    seed([dune], [book, novel, review], true);
    const onSelectNode = vi.fn();
    const first = panel(dune, { onSelectNode });
    fireEvent.click(await screen.findByRole("button", { name: "Edit the fields of #小說 →" }));
    expect(onSelectNode).toHaveBeenCalledWith("t-novel");
    first.unmount();
    seed([dune], [book, novel, review], false);
    panel(dune);
    await screen.findByRole("region", { name: "#小說" });
    expect(screen.queryByRole("button", { name: /Edit the fields of/ })).toBeNull();
  });
  it("shows the 3 most recently changed other notes with the tag, then 「看全部 N 篇」", async () => {
    const others = [1, 2, 3, 4].map((n) => mk(`n${n}`, { title: `Note ${n}`, class_tag_ids: ["t-novel"], updated_at: `2026-10-0${n}T00:00:00Z` }));
    seed([dune, ...others], [book, novel, review]);
    const onSelectNode = vi.fn();
    panel(dune, { onSelectNode });
    const card = await screen.findByRole("region", { name: "#小說" });
    const rows = within(card).getAllByRole("button", { name: /^Note \d/ });
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining("Note 4"), expect.stringContaining("Note 3"), expect.stringContaining("Note 2")]);
    expect(within(card).queryByText(/^Dune/)).toBeNull(); // not this note
    fireEvent.click(rows[0]);
    expect(onSelectNode).toHaveBeenCalledWith("n4");
    fireEvent.click(within(card).getByRole("button", { name: "See all 5 →" }));
    expect(onSelectNode).toHaveBeenLastCalledWith("t-novel");
  });
  it("a tag with only this note has no list of others", async () => {
    seed([dune], [book, novel, review]);
    panel(dune);
    const card = await screen.findByRole("region", { name: "#小說" });
    expect(within(card).queryByText("Notes with this tag")).toBeNull();
    expect(within(card).queryByRole("button", { name: /See all/ })).toBeNull();
  });
  it("shows the functions the tag brings, and nothing when it brings none", async () => {
    const reviewing: Tag = { ...novel, effective_modules: ["skills"], schema_behaviour: { modules: { skills: { enabled: true } } } };
    seed([dune], [book, reviewing, review]);
    panel(dune);
    const card = await screen.findByRole("region", { name: "#小說" });
    expect(card).toHaveTextContent("Skills");
    const plain = mk("plain2", { class_tag_ids: ["t-meeting"] });
    seed([plain], [meeting]);
    panel(plain);
    expect(within(await screen.findByRole("region", { name: "#meeting" })).queryByText("Skills")).toBeNull();
  });
  it("has no hint and no suggested tags on a note without tags", () => {
    const bare = mk("bare", { markdown: "# Title\n" });
    seed([bare], [book, novel]);
    panel(bare);
    expect(screen.getByRole("tab", { name: "AI" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Tags" }));
    expect(within(screen.getByRole("tabpanel")).queryAllByRole("region")).toHaveLength(0);
    expect(screen.getByRole("tabpanel")).not.toHaveTextContent(/suggest|add a tag/i);
  });
});

describe("old fields (no tag has a field for them)", () => {
  it("appear only when there are some, below the cards, value editable", async () => {
    attributes = [{ key: "isbn", value: "978" }];
    seed([dune], [book, novel, review]);
    panel(dune);
    const old = await screen.findByRole("region", { name: "Properties not in any tag" });
    fireEvent.click(within(old).getByText("978"));
    expect(within(old).getByDisplayValue("978")).toBeInTheDocument();
  });
  it("are absent when the note has none", async () => {
    seed([dune], [book, novel, review]);
    panel(dune);
    await screen.findByRole("region", { name: "#小說" });
    expect(screen.queryByRole("region", { name: "Properties not in any tag" })).toBeNull();
  });
  it("the owner can make one a field of the note's only tag — the value stays", async () => {
    attributes = [{ key: "isbn", value: "978" }];
    const solo = mk("solo", { class_tag_ids: ["t-novel"] });
    seed([solo], [book, novel]);
    const onTagsChanged = vi.fn();
    panel(solo, { onTagsChanged });
    fireEvent.click(await screen.findByRole("button", { name: "Make it a field of #小說" }));
    await waitFor(() => expect(onTagsChanged).toHaveBeenCalled());
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url, init]) => String(url).includes("/api/tags/t-novel/schema") && (init as RequestInit)?.method === "PATCH");
    const fields = (JSON.parse(String((call![1] as RequestInit).body)) as { fields: Array<{ name: string }> }).fields;
    expect(fields.map((f) => f.name)).toEqual(["status", "isbn"]);
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.some(([, init]) => (init as RequestInit)?.method === "DELETE")).toBe(false);
  });
  it("with several tags the owner picks which; a non-owner gets no button", async () => {
    attributes = [{ key: "isbn", value: "978" }];
    const two = mk("two", { class_tag_ids: ["t-novel", "t-meeting"] });
    seed([two], [book, novel, meeting]);
    const first = panel(two);
    fireEvent.click(await screen.findByRole("button", { name: "Make it a field of…" }));
    const group = screen.getByRole("group", { name: "Make it a field of…" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["#小說", "#meeting"]);
    first.unmount();
    seed([two], [book, novel, meeting], false);
    panel(two);
    await screen.findByRole("region", { name: "Properties not in any tag" });
    expect(screen.queryByRole("button", { name: /Make it a field/ })).toBeNull();
  });
});

describe("where the note's text is not on screen", () => {
  it("has no tab bar", () => {
    seed([dune], [book, novel, review]);
    panel(dune, { noHeadings: true });
    expect(screen.queryByRole("tablist")).toBeNull();
  });
  it("and the panel never carries the note's length (it is at the top of the note's ⋯ menu)", () => {
    const long = mk("long", { markdown: "one two three four five" });
    seed([long], []);
    panel(long);
    expect(screen.queryByText(/min read/)).toBeNull();
  });
});

describe("a note with nothing to show", () => {
  it("opens on the AI tab; the tab bar stays, and the quiet line is under a tab the person picked", async () => {
    const bare = mk("bare");
    seed([bare], []);
    panel(bare);
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(screen.getByRole("tab", { name: "AI" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("This note has no tags, features or connections yet.")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Tags" }));
    expect(screen.getByText("This note has no tags, features or connections yet.")).toBeInTheDocument();
    act(() => setLocalePref("zh-TW"));
    expect(screen.getByText("這篇還沒有標籤、相關功能或關聯。")).toBeInTheDocument();
  });
  it("but not when it has old fields to show", async () => {
    attributes = [{ key: "isbn", value: "978" }];
    const bare = mk("bare");
    seed([{ ...bare, attrs: { isbn: "978" } }], []);
    panel({ ...bare, attrs: { isbn: "978" } });
    expect(screen.queryByText("This note has no tags, features or connections yet.")).toBeNull();
    expect(await screen.findByRole("region", { name: "Properties not in any tag" })).toBeInTheDocument();
  });
});

const link = (id: string, source: string, target: string): NodeEdge =>
  ({ id, source_node_id: source, target_node_id: target, edge_type: "knowledge_link", status: "active", origin: "manual" });

describe("the 「關係」 tab", () => {
  const me = mk("me", { title: "Me" });
  const others = ["a", "b", "c", "d"].map((id) => mk(id, { title: id.toUpperCase() }));
  const seedRelations = (nodes: ContentNode[], edges: NodeEdge[]) =>
    resetAppState({ data: { ...noWorkspaceData, nodes, edges, tags: [] }, online: true });

  it("is the third tab (the AI tab follows 功能 and 標籤), and opens by itself on a note with only connections", () => {
    seedRelations([me, others[0]!], [link("1", "me", "a")]);
    panel(me);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Functions", "Tags", "Relations", "AI"]);
    expect(screen.getByRole("tab", { name: "Relations" })).toHaveAttribute("aria-selected", "true");
  });

  const sectionOf = (name: string) => within(screen.getByRole("region", { name }));
  const rowsOf = (name: string) => sectionOf(name).queryAllByRole("button").filter((b) => b.classList.contains("links-relation-row"));

  it("lists links in and out as rows that say which way they point, and a click opens the note", () => {
    seedRelations([me, others[0]!, others[1]!], [link("1", "me", "a"), link("2", "b", "me")]);
    const onSelectNode = vi.fn();
    panel(me, { onSelectNode });
    const rows = rowsOf("Links");
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("Links to"), expect.stringContaining("Linked from")]);
    expect(rows[0]!.textContent).toContain("A");
    fireEvent.click(rows[1]!);
    expect(onSelectNode).toHaveBeenCalledWith("b");
  });

  it("names a link's kind only when it is not a plain link", () => {
    seedRelations([me, others[0]!], [{ ...link("1", "me", "a"), edge_type: "supports" }]);
    panel(me);
    expect(rowsOf("Links")[0]!.textContent).toMatch(/Links to · \S+/);
    cleanup();
    seedRelations([me, others[0]!], [link("1", "me", "a")]);
    panel(me);
    expect(rowsOf("Links")[0]!.textContent).not.toContain("·");
  });

  it("shows the parent above, or 'Top level' when there is none", () => {
    const up = mk("up", { title: "Up" });
    seedRelations([{ ...me, parent_id: "up" }, up], []);
    const onSelectNode = vi.fn();
    const { unmount } = panel({ ...me, parent_id: "up" }, { onSelectNode });
    const rows = rowsOf("Parent");
    expect(rows.map((r) => r.textContent)).toEqual(["Up"]);
    fireEvent.click(rows[0]!);
    expect(onSelectNode).toHaveBeenCalledWith("up");
    unmount();
    seedRelations([me, others[0]!], [link("1", "me", "a")]);
    panel(me);
    expect(sectionOf("Parent").getByText("Top level")).toBeInTheDocument();
  });

  it("lists five sub-notes, then all of them behind 'Show all N' and back", () => {
    const kids = Array.from({ length: 7 }, (_, i) => mk(`k${i}`, { title: `Kid ${i}`, parent_id: "me" }));
    seedRelations([me, ...kids], []);
    const onSelectNode = vi.fn();
    panel(me, { onSelectNode });
    expect(rowsOf("Sub-notes 7")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Show all 7" }));
    expect(rowsOf("Sub-notes 7")).toHaveLength(7);
    fireEvent.click(rowsOf("Sub-notes 7")[6]!);
    expect(onSelectNode).toHaveBeenCalledWith("k6");
    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(rowsOf("Sub-notes 7")).toHaveLength(5);
  });

  it("folds the sub-notes from their heading, and the fold holds for the next note", () => {
    const kids = Array.from({ length: 3 }, (_, i) => mk(`k${i}`, { title: `Kid ${i}`, parent_id: "me" }));
    const other = mk("o", { title: "Other" });
    const otherKids = [mk("ok", { title: "Other kid", parent_id: "o" })];
    seedRelations([me, ...kids, other, ...otherKids], []);
    const { unmount } = panel(me);
    const fold = screen.getByRole("button", { name: "Sub-notes 3" });
    expect(fold).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(fold);
    expect(fold).toHaveAttribute("aria-expanded", "false");
    expect(rowsOf("Sub-notes 3")).toHaveLength(0);
    unmount();
    panel(other);
    expect(screen.getByRole("button", { name: "Sub-notes 1" })).toHaveAttribute("aria-expanded", "false");
    expect(rowsOf("Sub-notes 1")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Sub-notes 1" }));
    expect(rowsOf("Sub-notes 1").map((r) => r.textContent)).toEqual(["Other kid"]);
  });

  it("has no 'Show all' for five sub-notes or fewer", () => {
    const kids = Array.from({ length: 5 }, (_, i) => mk(`k${i}`, { parent_id: "me" }));
    seedRelations([me, ...kids], []);
    panel(me);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it("says in quiet words what a section lacks", () => {
    seedRelations([me, others[0]!], [link("1", "me", "a")]);
    panel(me);
    expect(screen.getByText("Top level")).toBeInTheDocument();
    expect(screen.getByText("No sub-notes")).toBeInTheDocument();
    cleanup();
    const kid = mk("kid", { parent_id: "me" });
    seedRelations([me, kid], []);
    panel(me);
    expect(screen.getByText("No links yet")).toBeInTheDocument();
  });

  it("never draws the graph, however many connections there are", () => {
    seedRelations([me, ...others], others.map((o, i) => link(`e${i}`, "me", o.id)));
    panel(me);
    expect(rowsOf("Links")).toHaveLength(4);
    expect(document.querySelector("canvas")).toBeNull();
  });

  it("opens the full relations for this note", () => {
    seedRelations([me, others[0]!], [link("1", "me", "a")]);
    const onOpenFullRelations = vi.fn();
    panel(me, { onOpenFullRelations });
    fireEvent.click(screen.getByRole("button", { name: "Full relations" }));
    expect(onOpenFullRelations).toHaveBeenCalledWith("me");
  });

  it("says so quietly when the note has no connections", () => {
    seedRelations([me], []);
    panel({ ...me, markdown: "# Heading\n" });
    fireEvent.click(screen.getByRole("tab", { name: "Relations" }));
    expect(screen.getByText("No connections yet.")).toBeInTheDocument();
  });

  it("is not a tab where the note's text is not on screen", () => {
    seedRelations([me, others[0]!], [link("1", "me", "a")]);
    panel(me, { noHeadings: true });
    expect(screen.queryByRole("tab", { name: "Relations" })).toBeNull();
  });
});

describe("the panel at each window width (notes page)", () => {
  // The Info button is the right end of the top bar (BuilderWorkspace passes it
  // on every page that is not full-width); the note header keeps one only on a
  // phone. Each column's switch is at its own side.
  const renderTopbar = (inspectorToggle?: { pressed: boolean; onToggle: () => void }, sidebarToggle?: { pressed: boolean; onToggle: () => void }) => render(
    <AppTopbar mode="notes" setMode={() => {}} activePanel={null} onOpenModule={() => {}} onOpenFeature={() => {}} onOpenPalette={() => {}}
      onOpenMembers={() => {}} onOpenSettings={() => {}} sidebarToggle={sidebarToggle} inspectorToggle={inspectorToggle} />);
  const panes = (px: number, stored?: { open?: string; collapsed?: string }) => {
    width(px);
    if (stored?.open) setPref(PREFS.inspectorOpen, stored.open);
    if (stored?.collapsed) setPref(PREFS.inspectorCollapsed, stored.collapsed);
    return renderHook(() => useWorkspacePanes("notes"));
  };
  it("≥1280px: open by default, and the top bar's Info button still closes and reopens it", () => {
    const { result } = panes(1280);
    expect(result.current.inspectorVisible).toBe(true);
    const view = renderTopbar({ pressed: result.current.inspectorVisible, onToggle: result.current.toggleInspector });
    fireEvent.click(screen.getByRole("button", { name: "Info" }));
    expect(result.current.inspectorVisible).toBe(false);
    view.unmount();
    renderTopbar({ pressed: result.current.inspectorVisible, onToggle: result.current.toggleInspector });
    expect(screen.getByRole("button", { name: "Info" })).toHaveAttribute("aria-pressed", "false");
  });
  it("≥1280px: a panel the person closed stays closed", () => {
    const { result } = panes(1500, { open: "0" });
    expect(result.current.inspectorOpen).toBe(false);
    expect(result.current.inspectorVisible).toBe(false);
  });
  it("1000–1279px: open by default, and the Info button closes and reopens it", () => {
    const { result } = panes(1100);
    expect(result.current.inspectorVisible).toBe(true);
    const view = renderTopbar({ pressed: result.current.inspectorVisible, onToggle: result.current.toggleInspector });
    const button = screen.getByRole("button", { name: "Info" });
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    expect(result.current.inspectorVisible).toBe(false);
    view.unmount();
    renderTopbar({ pressed: result.current.inspectorVisible, onToggle: result.current.toggleInspector });
    expect(screen.getByRole("button", { name: "Info" })).toHaveAttribute("aria-pressed", "false");
  });
  it("focus mode: the Info button leaves focus mode and opens the panel (sidebar returns too)", () => {
    const { result } = panes(1100);
    act(() => result.current.setFocusMode(true));
    expect(result.current.inspectorVisible).toBe(false);
    renderTopbar({ pressed: result.current.inspectorVisible, onToggle: result.current.toggleInspector });
    const button = screen.getByRole("button", { name: "Info" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(button);
    expect(result.current.focusMode).toBe(false);
    expect(result.current.inspectorVisible).toBe(true);
  });
  it("the two-cell switch sits at the right of the bar, before the Settings gear: the list's cell, then the Info cell; the note header has neither", () => {
    renderTopbar({ pressed: true, onToggle: () => {} }, { pressed: true, onToggle: () => {} });
    const bar = screen.getByRole("banner");
    const left = bar.querySelector(".app-topbar-left")!;
    const right = bar.querySelector(".app-topbar-right")!;
    const group = right.querySelector(".topbar-pane-switch")!;
    expect(group.nextElementSibling).toBe(screen.getByRole("button", { name: "Settings" }));
    expect(right.lastElementChild).toBe(group.nextElementSibling);
    expect([...group.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Notes list", "Info"]);
    expect(left.textContent).toBe("Onden");
    expect(bar.querySelector(".notes-focus-toggle")).toBeNull();
  });
  it("each cell shows its own column open (aria-pressed) and switches only that column", () => {
    const onSidebar = vi.fn(); const onInspector = vi.fn();
    renderTopbar({ pressed: false, onToggle: onInspector }, { pressed: true, onToggle: onSidebar });
    const list = screen.getByRole("button", { name: "Notes list" });
    const info = screen.getByRole("button", { name: "Info" });
    expect(list).toHaveAttribute("aria-pressed", "true");
    expect(info).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(list);
    expect([onSidebar.mock.calls.length, onInspector.mock.calls.length]).toEqual([1, 0]);
    fireEvent.click(info);
    expect([onSidebar.mock.calls.length, onInspector.mock.calls.length]).toEqual([1, 1]);
    expect(list.title).toMatch(/^Notes list \(/);
    expect(info.title).toMatch(/^Info \(/);
  });
  it("without a toggle (a full page) both cells are greyed out", () => {
    renderTopbar(undefined, undefined);
    expect(screen.getByRole("button", { name: "Info" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Notes list" })).toBeDisabled();
  });
  it("the list folds on its own, leaving the Info panel; the cell brings it back and ends focus mode", () => {
    const { result } = panes(1500);
    expect(result.current.sidebarVisible).toBe(true);
    act(() => result.current.toggleSidebar());
    expect(result.current.sidebarVisible).toBe(false);
    expect(result.current.sidebarCollapsed).toBe(true);
    expect(result.current.inspectorVisible).toBe(true);
    expect(result.current.focusMode).toBe(false);
    act(() => result.current.toggleSidebar());
    expect(result.current.sidebarVisible).toBe(true);
    act(() => result.current.setFocusMode(true));
    expect([result.current.sidebarVisible, result.current.inspectorVisible]).toEqual([false, false]);
    act(() => result.current.toggleSidebar());
    expect(result.current.focusMode).toBe(false);
    expect(result.current.sidebarVisible).toBe(true);
  });
  it("a full page has no list to open", () => {
    width(1500);
    const { result } = renderHook(() => useWorkspacePanes("timeline"));
    expect(result.current.sidebarVisible).toBe(false);
  });
  it("below 1000px: closed by default, called up by the button", () => {
    const { result } = panes(960);
    expect(result.current.inspectorVisible).toBe(false);
    act(() => result.current.toggleInspector());
    expect(result.current.inspectorVisible).toBe(true);
  });
  it("writing mode folds the panel away with the left sidebar (and exit brings both back)", () => {
    const css = readFileSync("src/styles/global.css", "utf8");
    const rule = css.slice(css.indexOf("body.onden-zen .app-topbar,"), css.indexOf("display: none !important;", css.indexOf("body.onden-zen .app-topbar,")));
    expect(rule).toContain("body.onden-zen .overview-activity");
    expect(rule).toContain("body.onden-zen .obsidian-sidebar");
    // Focus mode also hides it for the topbar's sidebar toggle.
    const { result } = panes(1500);
    act(() => result.current.setFocusMode(true));
    expect(result.current.inspectorVisible).toBe(false);
    const layout = readFileSync("src/components/ObsidianImport.css", "utf8");
    expect(layout).toContain(".obsidian-workspace.focus-mode .overview-activity");
  });
});
