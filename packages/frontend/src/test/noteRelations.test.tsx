import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import NoteRelations from "../components/NoteRelations";
import { parentCandidates } from "../components/ParentPicker";
import { resetAppState } from "../lib/appStore";
import type { Bootstrap, ContentNode, NodeEdge } from "../lib/api";
import { noWorkspaceData } from "../lib/api";
import { setLocalePref } from "../lib/i18n";
import type { CanvasMembership } from "@onden/contract";

// This note's relationships, under the body (moved out of the right-hand
// inspector): backlinks with their linking context, unlinked mentions
// (collapsed), canvases, parent and children with a type-to-filter picker,
// and outgoing links + local graph under one collapsed "More".

const node = (over: Partial<ContentNode>): ContentNode =>
  ({ id: "n", source_type: "manual", node_type: "content", title: "T", slug: "t", markdown: "", ...over } as ContentNode);

const link = (id: string, source: string, target: string, origin = "wikilink"): NodeEdge =>
  ({ id, source_node_id: source, target_node_id: target, edge_type: "knowledge_link", status: "active", origin } as NodeEdge);

function seed(nodes: ContentNode[], edges: NodeEdge[] = [], canvas_memberships: CanvasMembership[] = []) {
  const data: Bootstrap = { ...noWorkspaceData, nodes, edges, canvas_memberships };
  resetAppState({ data, bootstrapped: true, online: true });
}

const noop = () => {};
const baseProps = { onOpenNote: noop };

afterEach(() => {
  vi.restoreAllMocks();
  resetAppState();
  act(() => setLocalePref("system"));
});

describe("NoteRelations backlinks", () => {
  it("shows the source title AND a quoted snippet of the linking context", () => {
    const target = node({ id: "target", title: "Photosynthesis", slug: "photosynthesis" });
    const source = node({
      id: "src", title: "Plant biology", slug: "plant-biology",
      markdown: "Energy comes from [[Photosynthesis]] in the chloroplast.",
    });
    seed([target, source], [link("e1", "src", "target")]);

    render(<NoteRelations {...baseProps} node={target} />);

    expect(screen.getByRole("heading", { name: "Mentioned in 1 note" })).toBeInTheDocument();
    expect(screen.getByText("Plant biology")).toBeInTheDocument();
    expect(screen.getByText(/in the chloroplast/)).toBeInTheDocument();
    expect(screen.getByText("Photosynthesis")).toBeInTheDocument();
    expect(screen.queryByText(/linked from this note/)).not.toBeInTheDocument();
  });

  it("degrades to title-only fallback when the source has no body snippet", () => {
    const target = node({ id: "target", title: "Photosynthesis", slug: "photosynthesis" });
    const source = node({ id: "src", title: "Plant biology", slug: "plant-biology", markdown: "" });
    seed([target, source], [link("e1", "src", "target", "manual")]);

    render(<NoteRelations {...baseProps} node={target} />);

    expect(screen.getByText("Plant biology")).toBeInTheDocument();
    expect(screen.getByText(/linked from this note/)).toBeInTheDocument();
  });

  it("shows the first five backlinks, then all of them on request", () => {
    const target = node({ id: "target", title: "Hub" });
    const sources = Array.from({ length: 7 }, (_, i) => node({ id: `s${i}`, title: `Source ${i}`, markdown: "See [[Hub]]." }));
    seed([target, ...sources], sources.map((s, i) => link(`e${i}`, s.id, "target")));

    render(<NoteRelations {...baseProps} node={target} />);

    expect(screen.getByRole("heading", { name: "Mentioned in 7 notes" })).toBeInTheDocument();
    expect(document.querySelectorAll(".backlink-card")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Show all 7" }));
    expect(document.querySelectorAll(".backlink-card")).toHaveLength(7);
  });
});

describe("NoteRelations sections", () => {
  it("a note without links shows no hint and no empty sections", () => {
    const lonely = node({ id: "a", title: "Lonely" });
    seed([lonely]);

    render(<NoteRelations {...baseProps} node={lonely} />);

    expect(screen.queryByText(/No linked notes yet/)).toBeNull();
    expect(screen.queryByText(/Use \[\[ to connect/)).toBeNull();
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("orders the sections and keeps unlinked mentions and More collapsed", async () => {
    const target = node({ id: "t", title: "Gravity", parent_id: "p" });
    const parent = node({ id: "p", title: "Physics" });
    const child = node({ id: "c", title: "Orbits", parent_id: "t" });
    const linker = node({ id: "l", title: "Linker", markdown: "About [[Gravity]]." });
    const mentioner = node({ id: "m", title: "Mentioner", markdown: "Gravity pulls apples." });
    const out = node({ id: "o", title: "Newton" });
    seed([target, parent, child, linker, mentioner, out],
      [link("e1", "l", "t"), link("e2", "t", "o")],
      [{ canvas_id: "c1", canvas_title: "Mechanics board", node_id: "t" }]);
    const onOpenNote = vi.fn();

    render(<NoteRelations {...baseProps} node={target} onOpenNote={onOpenNote} />);

    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(["Sub-notes1", "Mentioned in 1 note", "Unlinked mentions1", "Appears on canvases1", "More"]);

    // Canvas rows look like the other relation rows: just the title, no icon.
    expect(screen.getByRole("button", { name: "Mechanics board" }).textContent).toBe("Mechanics board");

    // Unlinked mentions: closed until asked; the row still opens the source.
    const mentions = screen.getByRole("button", { name: /Unlinked mentions/ });
    expect(mentions).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Mentioner")).toBeNull();
    fireEvent.click(mentions);
    fireEvent.click(screen.getByText("Mentioner"));
    expect(onOpenNote).toHaveBeenCalledWith("m");

    // The parent is no longer here (the breadcrumb owns it); the sub-notes
    // are their own section: a foldable plain list (the views are tabs above the note).
    expect(screen.queryByRole("region", { name: "Parent note" })).toBeNull();
    const subNotes = screen.getByRole("region", { name: /Sub-notes/ });
    expect(await within(subNotes).findByRole("button", { name: "Orbits" })).toBeInTheDocument();
    expect(within(subNotes).getByRole("button", { name: /Sub-notes/ })).toHaveAttribute("aria-expanded", "true");

    // Outgoing links sit under More; the local graph is the info panel's tab.
    expect(screen.queryByText("Newton")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("heading", { name: /Outgoing Links/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Newton" })).toBeInTheDocument();
    expect(document.querySelector("svg.ov-mini-graph")).toBeNull();
  });

  it("translates the headings under zh-TW", () => {
    act(() => setLocalePref("zh-TW"));
    const target = node({ id: "t", title: "Target", parent_id: "p" });
    const parent = node({ id: "p", title: "Up" });
    const src = node({ id: "s", title: "Source", markdown: "[[Target]]" });
    seed([target, parent, src], [link("e1", "s", "t")]);
    render(<NoteRelations {...baseProps} node={target} />);
    expect(screen.getByRole("heading", { name: "被 1 篇筆記提到" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "上層筆記" })).toBeNull();
  });
});

describe("parent picker", () => {
  const tree = () => {
    const self = node({ id: "self", title: "Project", parent_id: "root" });
    const root = node({ id: "root", title: "Projects" });
    const kid = node({ id: "kid", title: "Project plan", parent_id: "self" });
    const grandkid = node({ id: "gk", title: "Project risks", parent_id: "kid" });
    const other = node({ id: "other", title: "Project archive" });
    return { self, nodes: [self, root, kid, grandkid, other] };
  };

  it("never offers the note itself or its descendants", () => {
    const { self, nodes } = tree();
    const ids = parentCandidates(self, nodes, "project").map((n) => n.id);
    expect(ids).toEqual(["root", "other"]);
  });

  it("never offers a note in another space (a note and its parent share a space)", () => {
    const { self, nodes } = tree();
    const inSpace = nodes.map((n) => ({ ...n, space_id: "s1" }));
    const elsewhere = node({ id: "elsewhere", title: "Project elsewhere", space_id: "s2" });
    const unknown = node({ id: "unknown", title: "Project unknown" });
    const ids = parentCandidates(inSpace.find((n) => n.id === self.id)!, [...inSpace, elsewhere, unknown], "project").map((n) => n.id);
    expect(ids).toEqual(["root", "other", "unknown"]);
  });

  it("never offers a tag: a note's parent is a note (T12)", () => {
    const { self, nodes } = tree();
    const tagNode = node({ id: "tag", title: "Project tag", node_type: "class_tag" });
    const ids = parentCandidates(self, [...nodes, tagNode], "project").map((n) => n.id);
    expect(ids).toEqual(["root", "other"]);
  });
});
