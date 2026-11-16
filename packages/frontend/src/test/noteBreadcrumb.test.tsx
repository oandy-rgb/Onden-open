// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import NoteBreadcrumb from "../components/NoteBreadcrumb";
import { resetAppState } from "../lib/appStore";
import type { Bootstrap, ContentNode } from "../lib/api";
import { noWorkspaceData } from "../lib/api";
import { setLocalePref } from "../lib/i18n";

// The left of the note's top row: ancestors (not the note itself, its title is
// right below) open their note, "Move…" (editors only) opens the shared parent
// picker, long trails collapse.

const node = (over: Partial<ContentNode>): ContentNode =>
  ({ id: "n", source_type: "manual", node_type: "content", title: "T", slug: "t", markdown: "", ...over } as ContentNode);

function seed(nodes: ContentNode[]) {
  const data: Bootstrap = { ...noWorkspaceData, nodes };
  resetAppState({ data, bootstrapped: true, online: true });
}

/** A chain a0 > a1 > … with the open note under the last one. */
function chain(depth: number) {
  const ancestors: ContentNode[] = [];
  for (let i = 0; i < depth; i++) ancestors.push(node({ id: `a${i}`, title: `Level ${i}`, parent_id: i ? `a${i - 1}` : null }));
  const self = node({ id: "self", title: "Open note", parent_id: depth ? `a${depth - 1}` : null });
  const other = node({ id: "other", title: "Elsewhere" });
  return { ancestors, self, all: [...ancestors, self, other] };
}

const baseProps = { canEdit: true, onOpenNote: () => {} };

afterEach(() => {
  vi.restoreAllMocks();
  resetAppState();
  act(() => setLocalePref("system"));
});

describe("NoteBreadcrumb", () => {
  it("is a labelled nav; each ancestor opens its note and the note itself is not repeated", () => {
    const { ancestors, self, all } = chain(2);
    seed(all);
    const onOpenNote = vi.fn();
    render(<NoteBreadcrumb {...baseProps} node={self} ancestors={ancestors} nodes={all} onOpenNote={onOpenNote} onAssignGroup={vi.fn()} />);
    const nav = screen.getByRole("navigation", { name: "Where this note sits" });
    fireEvent.click(within(nav).getByRole("button", { name: "Level 1" }));
    expect(onOpenNote).toHaveBeenCalledWith("a1");
    expect(within(nav).queryByText("Open note")).toBeNull();
  });

  it("shows Move… only to someone who can edit", () => {
    const { ancestors, self, all } = chain(1);
    seed(all);
    const { rerender } = render(<NoteBreadcrumb {...baseProps} node={self} ancestors={ancestors} nodes={all} onAssignGroup={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Move…" })).toBeInTheDocument();
    rerender(<NoteBreadcrumb {...baseProps} canEdit={false} node={self} ancestors={ancestors} nodes={all} onAssignGroup={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Move…" })).toBeNull();
    // The trail itself stays for a viewer.
    expect(screen.getByRole("button", { name: "Level 0" })).toBeInTheDocument();
  });

  it("a top-level note: editors get just 'Set parent', read-only viewers get nothing", () => {
    const { self, all } = chain(0);
    seed(all);
    const { rerender, container } = render(<NoteBreadcrumb {...baseProps} node={self} ancestors={[]} nodes={all} onAssignGroup={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Set parent" })).toBeInTheDocument();
    rerender(<NoteBreadcrumb {...baseProps} canEdit={false} node={self} ancestors={[]} nodes={all} onAssignGroup={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("Move… opens the picker, filters, and picking calls onAssignGroup", () => {
    const { ancestors, self, all } = chain(1);
    seed(all);
    const onAssignGroup = vi.fn();
    render(<NoteBreadcrumb {...baseProps} node={self} ancestors={ancestors} nodes={all} onAssignGroup={onAssignGroup} />);
    fireEvent.click(screen.getByRole("button", { name: "Move…" }));
    const input = screen.getByRole("combobox", { name: "Search parent notes…" });
    fireEvent.change(input, { target: { value: "else" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["No parent (top level)", "Elsewhere"]);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAssignGroup).toHaveBeenCalledWith("self", "other");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("the picker can move a note to the top level and never offers the note itself", () => {
    const { ancestors, self, all } = chain(1);
    seed(all);
    const onAssignGroup = vi.fn();
    render(<NoteBreadcrumb {...baseProps} node={self} ancestors={ancestors} nodes={all} onAssignGroup={onAssignGroup} />);
    fireEvent.click(screen.getByRole("button", { name: "Move…" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).not.toContain("Open note");
    fireEvent.click(screen.getByRole("option", { name: "No parent (top level)" }));
    expect(onAssignGroup).toHaveBeenCalledWith("self", null);
  });

  it("the picker floats outside the top row (not inline), and Esc, an outside press or the same word closes it", () => {
    const { ancestors, self, all } = chain(1);
    seed(all);
    const { container } = render(<NoteBreadcrumb {...baseProps} node={self} ancestors={ancestors} nodes={all} onAssignGroup={vi.fn()} />);
    const move = screen.getByRole("button", { name: "Move…" });
    fireEvent.click(move);
    const picker = screen.getByRole("dialog", { name: "Move…" });
    expect(container.contains(picker)).toBe(false);
    expect(move).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(move);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(move);
    fireEvent.click(move);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("pressing Move… with a mouse while the picker is open closes it (the press must not blur the field first)", () => {
    const { ancestors, self, all } = chain(1);
    seed(all);
    render(<NoteBreadcrumb {...baseProps} node={self} ancestors={ancestors} nodes={all} onAssignGroup={vi.fn()} />);
    const move = screen.getByRole("button", { name: "Move…" });
    fireEvent.click(move);
    const input = screen.getByRole("combobox");
    // A real press blurs the focused field unless mousedown is default-prevented.
    if (fireEvent.mouseDown(move)) fireEvent.blur(input);
    fireEvent.click(move);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Esc that only cancels an IME candidate keeps the picker open", () => {
    const { ancestors, self, all } = chain(1);
    seed(all);
    render(<NoteBreadcrumb {...baseProps} node={self} ancestors={ancestors} nodes={all} onAssignGroup={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Move…" }));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape", isComposing: true });
    expect(screen.getByRole("dialog", { name: "Move…" })).toBeInTheDocument();
  });

  it("keeps up to three ancestors, each with the full name in its title attribute", () => {
    const long = "A very long parent title that would not fit on a 320px phone line";
    const ancestors = [node({ id: "a0", title: long })];
    const self = node({ id: "self", title: "Open note", parent_id: "a0" });
    seed([...ancestors, self]);
    render(<NoteBreadcrumb {...baseProps} node={self} ancestors={ancestors} nodes={[...ancestors, self]} />);
    expect(screen.getByRole("button", { name: long })).toHaveAttribute("title", long);
    expect(screen.queryByRole("button", { name: /more parent notes/ })).toBeNull();
    // No handler: viewers and read-only hosts get no move action.
    expect(screen.queryByRole("button", { name: "Move…" })).toBeNull();
  });

  it("collapses the middle of a long trail into a … menu that opens those notes", () => {
    const { ancestors, self, all } = chain(5);
    seed(all);
    const onOpenNote = vi.fn();
    render(<NoteBreadcrumb {...baseProps} node={self} ancestors={ancestors} nodes={all} onOpenNote={onOpenNote} onAssignGroup={vi.fn()} />);
    const nav = screen.getByRole("navigation");
    // First and last stay; the three between are folded away.
    expect(within(nav).getByRole("button", { name: "Level 0" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Level 4" })).toBeInTheDocument();
    for (const mid of ["Level 1", "Level 2", "Level 3"]) expect(screen.queryByRole("button", { name: mid })).toBeNull();
    const more = within(nav).getByRole("button", { name: "Show 3 more parent notes" });
    expect(more).toHaveAttribute("aria-haspopup", "menu");
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu", { name: "Parent notes in the path" });
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Level 1", "Level 2", "Level 3"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Level 2" }));
    expect(onOpenNote).toHaveBeenCalledWith("a2");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("translates the line under zh-TW", () => {
    act(() => setLocalePref("zh-TW"));
    const { ancestors, self, all } = chain(1);
    seed(all);
    render(<NoteBreadcrumb {...baseProps} node={self} ancestors={ancestors} nodes={all} onAssignGroup={vi.fn()} />);
    expect(screen.getByRole("navigation", { name: "此筆記的位置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "移到…" })).toBeInTheDocument();
  });
});
