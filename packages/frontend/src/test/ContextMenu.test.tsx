// @vitest-environment jsdom
// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import ContextMenu from "../components/ContextMenu";
import { ApiError,  type ContentNode } from "../lib/api";
import { addToast, getAppState, resetAppState } from "../lib/appStore";
import { nodeActions, reads, relationWriter, tagWriter } from "../lib/data";
import { resetEdgeKindsForTest } from "../lib/edgeKinds";
import { reportWriteFailure } from "../lib/data/writeErrors";
import { setLocalePref } from "../lib/i18n";
import { resetSpacesForTest } from "../lib/spaces";
import { ownerData } from "./ownerData";

const menu = { kind: "graph-node" as const, nodeId: "note", x: 310, y: 730 };
function props() {
  return { menu, onClose: vi.fn(), onSelectNode: vi.fn(), onStartRename: vi.fn(), onCreateAt: vi.fn(),
    onRemoveFromCanvas: vi.fn(async () => {}) };
}
function seed(node: Partial<ContentNode> = {}) {
  resetAppState({
    data: { ...ownerData, nodes: [{ id: "note", title: "Note", node_type: "content", ...node } as ContentNode] },
    activeCanvas: { id: "board" } as never,
  });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}
// The first render and the first user-event gesture in a file pay a one-time
// start-up (~0.4 s idle, several seconds on a busy machine), which the first
// test's 5 s budget had to absorb. Pay it here, with its own budget.
beforeAll(async () => {
  setLocalePref("en"); seed();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  render(<ContextMenu {...props()} />);
  await userEvent.hover(screen.getByRole("menuitem", { name: "Delete" }));
  cleanup(); vi.unstubAllGlobals();
}, 30_000);
beforeEach(() => {
  setLocalePref("en"); seed();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("waits for removal acknowledgement, prevents duplicate actions and never deletes the note", async () => {
  const p = props(); const gate = deferred(); p.onRemoveFromCanvas.mockReturnValue(gate.promise);
  const del = vi.spyOn(nodeActions, "delete");
  render(<ContextMenu {...p} />);
  const remove = screen.getByRole("menuitem", { name: /Remove from canvas/ });
  expect(remove.textContent).toContain("The note stays in your library.");
  fireEvent.click(remove); fireEvent.click(remove);
  await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
  expect(p.onRemoveFromCanvas).toHaveBeenCalledExactlyOnceWith("note");
  expect(del).not.toHaveBeenCalled(); expect(p.onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("status").textContent).toBe("Removing…");
  await act(async () => gate.resolve());
  expect(p.onClose).toHaveBeenCalledOnce();
});

it("keeps a refused removal open and retryable, reporting a writer error only once", async () => {
  const p = props(); const error = new ApiError(403, "denied");
  p.onRemoveFromCanvas.mockImplementationOnce(async () => { reportWriteFailure(error, addToast); throw error; });
  render(<ContextMenu {...p} />);
  await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: /Remove from canvas/ })));
  expect(p.onClose).not.toHaveBeenCalled(); expect(getAppState().toasts).toHaveLength(1);
  expect(screen.queryByRole("status")).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: /Remove from canvas/ })));
  expect(p.onClose).toHaveBeenCalledOnce();
});

it("does not close a newer menu when an earlier removal finishes", async () => {
  const p = props(); const gate = deferred(); p.onRemoveFromCanvas.mockReturnValue(gate.promise);
  const { rerender } = render(<ContextMenu {...p} />);
  fireEvent.click(screen.getByRole("menuitem", { name: /Remove from canvas/ }));
  rerender(<ContextMenu {...p} menu={{ ...menu, x: 40 }} />);
  await act(async () => gate.resolve());
  expect(p.onClose).not.toHaveBeenCalled();
  expect(screen.queryByRole("status")).toBeNull();
});

it("allows dismissing during removal without a late second close, and restores keyboard focus", async () => {
  const trigger = document.createElement("button"); document.body.append(trigger); trigger.focus();
  const p = props(); const gate = deferred(); p.onRemoveFromCanvas.mockReturnValue(gate.promise);
  const { unmount } = render(<ContextMenu {...p} />);
  const dialog = screen.getByRole("menu", { name: "Card actions" });
  expect(document.activeElement).toBe(dialog);
  fireEvent.click(screen.getByRole("menuitem", { name: /Remove from canvas/ }));
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(p.onClose).toHaveBeenCalledOnce(); unmount();
  expect(document.activeElement).toBe(trigger);
  await act(async () => gate.resolve()); expect(p.onClose).toHaveBeenCalledOnce(); trigger.remove();
});

it("clamps the menu to the viewport and readjusts after resizing", () => {
  vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(320);
  const height = vi.spyOn(window, "innerHeight", "get").mockReturnValue(740);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 280, height: 540 } as DOMRect);
  render(<ContextMenu {...props()} />);
  const dialog = screen.getByRole("menu");
  expect(dialog.style.getPropertyValue("--popover-x")).toBe("32px");
  expect(dialog.style.getPropertyValue("--popover-y")).toBe("192px");
  height.mockReturnValue(400); fireEvent(window, new Event("resize"));
  expect(dialog.style.getPropertyValue("--popover-y")).toBe("8px");
});

it("hides duplicate for non-content nodes", () => {
  seed({ node_type: "class_tag" });
  render(<ContextMenu {...props()} />);
  expect(screen.queryByRole("menuitem", { name: "Duplicate" })).toBeNull();
});

it("offers no Delete for a reserved tag (T1)", () => {
  resetAppState({
    data: { ...ownerData,
      nodes: [{ id: "note", title: "Tasks", node_type: "class_tag" } as ContentNode],
      tags: [{ id: "note", name: "Tasks", reserved_key: "task", color: "", schema_id: null }] },
    activeCanvas: { id: "board" } as never,
  });
  render(<ContextMenu {...props()} />);
  expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
  expect(screen.getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
});

it("runs a note's actions through nodeActions, by id", async () => {
  const duplicate = vi.spyOn(nodeActions, "duplicate").mockResolvedValue();
  const del = vi.spyOn(nodeActions, "delete").mockResolvedValue(true);
  for (const [name, spy] of [["Duplicate", duplicate], ["Delete", del]] as const) {
    const { unmount } = render(<ContextMenu {...props()} />);
    await userEvent.click(screen.getByRole("menuitem", { name }));
    expect(spy).toHaveBeenCalledExactlyOnceWith("note");
    unmount();
  }
});

it("offers no Hide for a note, on the board or in the sidebar (D104: only tags can be hidden)", () => {
  for (const kind of ["graph-node", "sidebar-node"] as const) {
    const { unmount } = render(<ContextMenu {...props()} menu={{ kind, nodeId: "note", x: 10, y: 10 }} />);
    expect(screen.queryByRole("menuitem", { name: /Hide|Unhide/ })).toBeNull();
    unmount();
  }
});

it("a tag's menu hides it, and a hidden tag's menu shows it again, through tagWriter (owner only)", async () => {
  const setHidden = vi.spyOn(tagWriter, "setHidden").mockResolvedValue({ queued: false });
  const tagData = (hidden: boolean, owner = true) => resetAppState({
    data: { ...ownerData, actor_is_owner: owner,
      nodes: [{ id: "note", title: "Secret", node_type: "class_tag", hidden } as ContentNode],
      tags: [{ id: "note", name: "Secret", color: "", schema_id: null, hidden }] },
  });
  tagData(false);
  let view = render(<ContextMenu {...props()} menu={{ kind: "sidebar-node", nodeId: "note", x: 10, y: 10 }} />);
  await userEvent.click(screen.getByRole("menuitem", { name: "Hide tag" }));
  expect(setHidden).toHaveBeenLastCalledWith("note", true);
  view.unmount();

  tagData(true);
  view = render(<ContextMenu {...props()} />);
  await userEvent.click(screen.getByRole("menuitem", { name: "Unhide tag" }));
  expect(setHidden).toHaveBeenLastCalledWith("note", false);
  view.unmount();

  tagData(false, false);
  render(<ContextMenu {...props()} menu={{ kind: "sidebar-node", nodeId: "note", x: 10, y: 10 }} />);
  expect(screen.queryByRole("menuitem", { name: "Hide tag" })).toBeNull();
});

it("an arrow's type choices, names and swatches come from the edge manifest (D39)", async () => {
  vi.spyOn(reads.workspace, "edgeManifest").mockResolvedValue([]);
  const spec = (kind: string, label: string, color: string, extra = {}) =>
    ({ kind, label, color, describe: "", arrow: "source-to-target" as const, ...extra });
  resetEdgeKindsForTest([
    spec("knowledge_link", "linked to", "#7a8796", { pickable: true }),
    spec("highlight_source", "excerpt of", "#4c7fd6"),
    spec("embed", "embedded in", "#2b9470", { pickable: true, planned: true }),
    spec("cites", "cites", "#b0457a", { pickable: true }),
  ]);
  setLocalePref("zh-TW");
  resetAppState({
    data: { ...ownerData, edges: [{ id: "e1", source_node_id: "a", target_node_id: "b", edge_type: "knowledge_link", status: "active" }] },
  });
  const remove = vi.spyOn(relationWriter, "remove").mockResolvedValue(undefined as never);
  const connect = vi.spyOn(relationWriter, "connect").mockResolvedValue(undefined as never);
  render(<ContextMenu {...props()} menu={{ kind: "graph-edge", edgeId: "e1", edgeType: "knowledge_link", x: 1, y: 1 }} />);
  const choices = screen.getAllByRole("menuitemradio");
  expect(choices.map((i) => i.textContent)).toEqual(["連結到", "cites"]);
  expect(choices[0]).toHaveAttribute("aria-checked", "true");
  const swatch = choices[1]!.querySelector<HTMLElement>(".ctx-edge-swatch")!;
  expect(swatch.style.getPropertyValue("--edge-color")).toBe("#b0457a");
  await userEvent.click(choices[1]!);
  await vi.waitFor(() => expect(connect).toHaveBeenCalledExactlyOnceWith("a", "b", "cites"));
  expect(remove).toHaveBeenCalledExactlyOnceWith("e1");
  resetEdgeKindsForTest();
});

// ── The note menu (sidebar / long-press): "Move to…" picker, "New inside" ──
const tree = [
  ["root", "Root", null], ["a", "Alpha", "root"], ["a1", "Alpha kid", "a"], ["a2", "Alpha grandkid", "a1"],
  ["b", "Beta", "root"], ["c", "Gamma", null],
] as const;
function seedTree(extra: Partial<AppStateSeed> = {}) {
  resetAppState({
    data: { ...ownerData,
      nodes: [
        ...tree.map(([id, title, parent_id]) => ({ id, title, parent_id, node_type: "content" } as ContentNode)),
        { id: "tag", title: "Tag row", node_type: "class_tag" } as ContentNode,
      ] },
    ...extra,
  });
}
type AppStateSeed = Parameters<typeof resetAppState>[0];
const noteMenu = (nodeId: string) => ({ kind: "sidebar-node" as const, nodeId, x: 10, y: 10 });

it("the note menu lists no notes inline: one Move to… item instead", () => {
  seedTree();
  render(<ContextMenu {...props()} menu={noteMenu("a")} />);
  const items = screen.getAllByRole("menuitem").map((i) => i.textContent);
  expect(items).toContain("Move to…");
  for (const title of ["Root", "Beta", "Gamma", "Alpha kid"]) expect(items).not.toContain(title);
  // 「從上層移出」 is the picker's 最上層 row now.
  expect(items).not.toContain("Remove from parent");
});

it("the note menu says 「移動到…」, not 「換到其他空間」", () => {
  setLocalePref("zh-TW");
  seedTree();
  render(<ContextMenu {...props()} menu={noteMenu("a")} />);
  const items = screen.getAllByRole("menuitem").map((i) => i.textContent);
  expect(items).toContain("移動到…");
  expect(items).not.toContain("從上層移出");
  expect(items.join()).not.toContain("換到其他空間");
});

it("Move to… opens a picker that offers the top level and excludes the note, its descendants and tags", async () => {
  seedTree();
  const assign = vi.spyOn(nodeActions, "assignToGroup").mockResolvedValue();
  const p = props();
  render(<ContextMenu {...p} menu={noteMenu("a")} />);
  await userEvent.click(screen.getByRole("menuitem", { name: "Move to…" }));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(p.onClose).not.toHaveBeenCalled();
  const dialog = screen.getByRole("dialog", { name: "Move “Alpha” to…" });
  const labels = () => within(dialog).getAllByRole("option").map((o) => o.querySelector(".place-picker-label")!.textContent);
  expect(labels()).toEqual(["Top level", "Root", "Beta", "Gamma"]);
  // Where it is now: said once under the search, marked and not pickable in the list.
  expect(dialog.querySelector(".place-picker-where")).toHaveTextContent("Now in: Root");
  const here = within(dialog).getByRole("option", { name: /^Root/ });
  expect(here).toHaveAttribute("aria-current", "location");
  expect(here).toHaveAttribute("aria-disabled", "true");
  expect(here).toHaveTextContent("Current place");
  await userEvent.click(here);
  expect(assign).not.toHaveBeenCalled();
  expect(p.onClose).not.toHaveBeenCalled();
  // Typing filters.
  const input = within(dialog).getByRole("combobox", { name: "Search places to move to…" });
  expect(document.activeElement).toBe(input);
  await userEvent.type(input, "gam");
  expect(labels()).toEqual(["Gamma"]);
  await userEvent.click(within(dialog).getByRole("option", { name: /Gamma/ }));
  expect(assign).toHaveBeenCalledExactlyOnceWith("a", "c");
  expect(p.onClose).toHaveBeenCalledOnce();
});

it("searching lists the notes flat, each with its parent's title in small text, and no top-level row", async () => {
  seedTree();
  render(<ContextMenu {...props()} menu={noteMenu("b")} />);
  await userEvent.click(screen.getByRole("menuitem", { name: "Move to…" }));
  const dialog = screen.getByRole("dialog", { name: "Move “Beta” to…" });
  // Not searching: a tree, deeper notes indented (three levels at most).
  const rows = within(dialog).getAllByRole("option");
  const depthOf = (name: string) => Number(rows.find((r) => r.textContent?.startsWith(name))!.style.getPropertyValue("--depth"));
  expect([depthOf("Root"), depthOf("Alpha"), depthOf("Alpha kid"), depthOf("Alpha grandkid")]).toEqual([0, 1, 2, 3]);
  await userEvent.type(within(dialog).getByRole("combobox"), "alpha");
  const found = within(dialog).getAllByRole("option");
  expect(found.map((o) => o.querySelector(".place-picker-label")!.textContent)).toEqual(["Alpha", "Alpha kid", "Alpha grandkid"]);
  expect(found.map((o) => o.querySelector(".place-picker-hint")?.textContent)).toEqual(["Root", "Alpha", "Alpha kid"]);
  expect(found.every((o) => o.style.getPropertyValue("--depth") === "0")).toBe(true);
});

// D101: "Pin under another note…" was a window.prompt that matched any title
// (tags too) and pinned at the root on a blank answer — a pointer the sidebar
// never renders. It is the same picker now, with the placement rule.
it("Pin under another note… opens the picker: notes only (no tags, not the note itself), no top level, and pins under the pick", async () => {
  seedTree();
  const prompt = vi.spyOn(window, "prompt");
  const p = { ...props(), onCreatePointer: vi.fn() };
  render(<ContextMenu {...p} menu={noteMenu("a")} />);
  await userEvent.click(screen.getByRole("menuitem", { name: "📎 Pin under another note…" }));
  expect(prompt).not.toHaveBeenCalled();
  const dialog = screen.getByRole("dialog", { name: "Pin “Alpha” under…" });
  const labels = () => within(dialog).getAllByRole("option").map((o) => o.querySelector(".move-to-label")!.textContent);
  // Not the tag, not Alpha itself, and no "top level" row. A pin shows Alpha
  // in a second place (Alpha stays put), so its own sub-notes are places too.
  expect(labels()).toEqual(["Root", "Alpha kid", "Alpha grandkid", "Beta", "Gamma"]);
  expect(within(dialog).queryByRole("option", { current: "location" })).toBeNull();
  await userEvent.type(within(dialog).getByRole("combobox", { name: "Search notes to pin under…" }), "tag");
  expect(within(dialog).queryAllByRole("option")).toEqual([]);
  await userEvent.clear(within(dialog).getByRole("combobox"));
  await userEvent.click(within(dialog).getByRole("option", { name: /Beta/ }));
  expect(p.onCreatePointer).toHaveBeenCalledExactlyOnceWith("a", "b");
  expect(p.onClose).toHaveBeenCalledOnce();
});

it("the picker works from the keyboard: arrows, Enter moves, top level, Esc closes", async () => {
  seedTree();
  const assign = vi.spyOn(nodeActions, "assignToGroup").mockResolvedValue();
  const p = props();
  const { unmount } = render(<ContextMenu {...p} menu={noteMenu("a1")} />);
  await userEvent.click(screen.getByRole("menuitem", { name: "Move to…" }));
  const input = screen.getByRole("combobox");
  // Row 0 is the top level; Enter on it moves the note out of its parent — what
  // 「從上層移出」 used to be.
  expect(input.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[0]!.id);
  await userEvent.keyboard("{Enter}");
  expect(assign).toHaveBeenLastCalledWith("a1", null);
  unmount();

  const q = props();
  render(<ContextMenu {...q} menu={noteMenu("a1")} />);
  await userEvent.click(screen.getByRole("menuitem", { name: "Move to…" }));
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowUp}{ArrowDown}");
  const active = screen.getByRole("option", { selected: true });
  expect(active.querySelector(".place-picker-label")!.textContent).toBe("Alpha");
  // Alpha is a1's current parent: it cannot be picked, so nothing is written or closed.
  await userEvent.keyboard("{Enter}");
  expect(assign).toHaveBeenCalledTimes(1);
  expect(q.onClose).not.toHaveBeenCalled();
  cleanup();

  const r = props();
  render(<ContextMenu {...r} menu={noteMenu("a1")} />);
  await userEvent.click(screen.getByRole("menuitem", { name: "Move to…" }));
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
  expect(assign).toHaveBeenLastCalledWith("a1", "b"); // Root, Alpha, Beta…: a2 (its child) is not offered
  cleanup();

  const e = props();
  render(<ContextMenu {...e} menu={noteMenu("a1")} />);
  await userEvent.click(screen.getByRole("menuitem", { name: "Move to…" }));
  await userEvent.keyboard("{Escape}");
  expect(e.onClose).toHaveBeenCalledOnce();
  expect(assign).toHaveBeenCalledTimes(2);
});

it("a tag's menu offers neither Move to… nor New inside", () => {
  seedTree();
  const p = { ...props(), onCreateInside: vi.fn() };
  render(<ContextMenu {...p} menu={noteMenu("tag")} />);
  expect(screen.queryByRole("menuitem", { name: "Move to…" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "New inside" })).toBeNull();
});

it("New inside lists the placeable kinds and makes the chosen one under the pressed note", async () => {
  seedTree({ online: true });
  const p = { ...props(), onCreateInside: vi.fn() };
  render(<ContextMenu {...p} menu={noteMenu("b")} />);
  const items = screen.getAllByRole("menuitem").map((i) => i.textContent?.trim());
  expect(items.slice(0, 3)).toEqual(["Rename", "Duplicate", "New inside"]);
  await userEvent.click(screen.getByRole("menuitem", { name: "New inside" }));
  expect(p.onClose).not.toHaveBeenCalled();
  const names = screen.getAllByRole("menuitem").map((i) => i.textContent?.trim());
  expect(names.slice(0, 4)).toEqual(["Note", "Handwriting", "Upload a file", "Bookmark"]);
  // Modules' add dialogs live on their tag pages and the palette, not here.
  expect(names).not.toContain("RSS");
  expect(names.some((name) => /paper|SKILL/i.test(name ?? ""))).toBe(false);
  await userEvent.click(screen.getByRole("menuitem", { name: "Handwriting" }));
  expect(p.onCreateInside).toHaveBeenCalledExactlyOnceWith("ink", "b");
  expect(p.onClose).toHaveBeenCalledOnce();
});

it("New inside disables the kinds that need the server while offline", async () => {
  seedTree({ online: false });
  const p = { ...props(), onCreateInside: vi.fn() };
  render(<ContextMenu {...p} menu={noteMenu("b")} />);
  await userEvent.click(screen.getByRole("menuitem", { name: "New inside" }));
  expect(screen.getByRole("menuitem", { name: "Note" })).toBeEnabled();
  expect(screen.getByRole("menuitem", { name: "Upload a file" })).toBeDisabled();
});

it.each(["sidebar-node", "graph-node"] as const)("a viewer's %s menu offers nothing the server refuses: no Rename, Move, New inside or Delete (D112)", async (kind) => {
  resetSpacesForTest();
  vi.spyOn(reads.people, "spaces").mockResolvedValue({ spaces: [{ id: "team", kind: "shared", permission: "view", can_manage: false, name: "Team", is_default: false, capabilities: {} }] } as never);
  resetAppState({
    data: { ...ownerData, nodes: [{ id: "n", title: "Read only", node_type: "content", space_id: "team", parent_id: "p" } as ContentNode] },
    activeCanvas: { id: "board" } as never,
    online: true,
  });
  const del = vi.spyOn(nodeActions, "delete");
  const p = { ...props(), onCreateInside: vi.fn() };
  render(<ContextMenu {...p} menu={{ kind, nodeId: "n", x: 10, y: 10 }} />);
  await vi.waitFor(() => expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull());
  for (const name of ["Rename", "New inside", "Move to…"]) {
    expect(screen.queryByRole("menuitem", { name })).toBeNull();
  }
  // A copy is the viewer's own note (the server only reads the source).
  expect(screen.getByRole("menuitem", { name: "Duplicate" })).toBeInTheDocument();
  expect(del).not.toHaveBeenCalled();
  resetSpacesForTest();
});
