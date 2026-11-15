import { openNoteColorDialog } from "../components/NoteColorDialog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import ContextMenu from "../components/ContextMenu";
import NodeInspector from "../components/NodeInspector";
import MarkdownEditor from "../components/MarkdownEditor";
import { useCommandPalette } from "../hooks/useCommandPalette";
import { usePaletteState } from "../hooks/usePaletteState";
import { capabilitiesFor } from "../lib/capabilities";
import { noWorkspaceData, type ContentNode, type Tag } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { noteMarkActions, reads } from "../lib/data";
import { resetSpacesForTest } from "../lib/spaces";
import { getCompletions, applyCompletion, type SlashItem } from "../lib/editorCompletion";
import { setLocalePref } from "../lib/i18n";
import { ALL_MODULES, SLASH_INSERTS, NOTE_COMMANDS } from "../modules";
import { Quote } from "lucide-react";
import { skillsModule } from "../modules/skills";
import { ownerData } from "./ownerData";
import type { Space } from "../lib/spaces";

// The note's ⋯ menu shed everything but history, a copy, export and Delete.
// What it shed is still somewhere else; these tests lock where:
//   pin, colour, rename … the sidebar's context menu and ⌘K (>)
//   image … the `/` menu · writing mode … ⌘K (and the editor toolbar)
//   module commands … the info panel's 「功能」 section and ⌘K
//   a module's `/` text … the `/` menu (and ⌘K) · new skill … ⌘K

const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

const mk = (id: string, extra: Partial<ContentNode> = {}): ContentNode => ({
  id, title: id, slug: id, markdown: "", node_type: "content", source_type: "manual", updated_at: "2026-10-01T00:00:00Z", space_id: "s1", ...extra,
});
const reviewTag: Tag = { id: "t-review", name: "複習", color: "", schema_id: "s-review", schema_module: "review", effective_modules: ["review"] };

function seed(nodes: ContentNode[], modules: string[], tags: Tag[] = [reviewTag]) {
  resetAppState({
    data: { ...ownerData, nodes, tags, workspace: { ...noWorkspaceData.workspace, modules } },
    online: true,
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  act(() => setLocalePref("en"));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); resetAppState(); act(() => setLocalePref("system")); });

describe("still in the sidebar's context menu", () => {
  const sidebar = (node: ContentNode) => {
    seed([node], []);
    return render(<ContextMenu menu={{ kind: "sidebar-node", nodeId: node.id, x: 10, y: 10 }} onClose={vi.fn()} onSelectNode={vi.fn()}
      onStartRename={vi.fn()} onCreateAt={vi.fn()} onCreateInside={vi.fn()} />);
  };

  it("Rename, Pin, a colour row and Delete", () => {
    sidebar(mk("n1"));
    for (const name of ["Rename", "Pin", "Delete"]) expect(screen.getByRole("menuitem", { name }), name).toBeTruthy();
    expect(screen.getByText("Color")).toBeTruthy();
    expect(screen.getByTitle("Red")).toBeTruthy();
  });

  it("Pin and a swatch write the note's pin and colour through the shared operation", () => {
    const pin = vi.spyOn(noteMarkActions, "togglePin").mockImplementation(() => {});
    const color = vi.spyOn(noteMarkActions, "setColor").mockImplementation(() => {});
    sidebar(mk("n1"));
    fireEvent.click(screen.getByTitle("Red"));
    expect(color).toHaveBeenCalledWith("n1", "#ef4444");
    cleanup();
    sidebar(mk("n1"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin" }));
    expect(pin).toHaveBeenCalledTimes(1);
  });

  it("a pinned note says Unpin", () => {
    sidebar(mk("n1", { attrs: { _pinned: "true" } }));
    expect(screen.getByRole("menuitem", { name: "Unpin" })).toBeTruthy();
  });

  it("a viewer is offered neither", async () => {
    resetSpacesForTest();
    vi.spyOn(reads.people, "spaces").mockResolvedValue({ spaces: [{ id: "team", kind: "shared", permission: "view", can_manage: false, name: "Team", is_default: false, capabilities: {} }] } as never);
    resetAppState({ data: { ...ownerData, nodes: [mk("n1", { space_id: "team" })] }, online: true });
    render(<ContextMenu menu={{ kind: "sidebar-node", nodeId: "n1", x: 10, y: 10 }} onClose={vi.fn()} onSelectNode={vi.fn()}
      onStartRename={vi.fn()} onCreateAt={vi.fn()} />);
    await vi.waitFor(() => expect(screen.queryByRole("menuitem", { name: "Pin" })).toBeNull());
    expect(screen.queryByText("Color")).toBeNull();
    resetSpacesForTest();
  });
});

describe("still in ⌘K (>)", () => {
  const text = mk("n1", { markdown: "- [ ] a\n## H\n" });
  const child = mk("c1", { parent_id: "n1" });
  const options = () => ({ setMode: vi.fn(), showTags: vi.fn(), setNotesView: vi.fn(), setSelectedId: vi.fn(), setCreateOpen: vi.fn(),
    setOverviewPane: vi.fn(), refresh: vi.fn(async () => {}), nodes: [text, child], canvases: [], activeCanvasId: null as string | null,
    selectedNode: text as ContentNode | null, openNoteColor: openNoteColorDialog, selectCanvas: vi.fn(), capabilities: capabilitiesFor(true, [], false) });
  const ids = (opts = options()) => {
    const { result } = renderHook(() => useCommandPalette(opts, usePaletteState()));
    act(() => { result.current.setPaletteOpen(true); result.current.setPaletteQuery(">"); });
    return { result, ids: result.current.paletteItems.map((x) => x.id) };
  };

  it("pin, colour and writing mode", () => {
    seed([text, child], []);
    const { ids: list } = ids();
    for (const id of ["a-pin-note", "a-set-color", "a-writing-mode", "a-note-history", "a-copy-md"]) {
      expect(list, id).toContain(id);
    }
  });

  it("Pin and Set color act on the selected note", async () => {
    seed([text, child], []);
    const pin = vi.spyOn(noteMarkActions, "togglePin").mockImplementation(() => {});
    const { result } = ids();
    await act(async () => { await result.current.runPaletteItem(result.current.paletteItems.find((x) => x.id === "a-pin-note")!); });
    expect(pin).toHaveBeenCalledWith(text);
    act(() => { result.current.setPaletteOpen(true); result.current.setPaletteQuery(">"); });
    await act(async () => { await result.current.runPaletteItem(result.current.paletteItems.find((x) => x.id === "a-set-color")!); });
    fireEvent.click(await screen.findByTitle("Blue"));
    // The shared operation ran, and the choice closed its dialog.
    expect(screen.queryByTitle("Blue")).toBeNull();
  });

  it("not for a viewer: no pin or colour, as in the list", () => {
    seed([text, child], []);
    const viewer = capabilitiesFor(false, [{ id: "s1", kind: "shared", permission: "view", can_manage: false } as Space], true);
    const { ids: list } = ids({ ...options(), capabilities: viewer });
    expect(list).not.toContain("a-pin-note");
    expect(list).not.toContain("a-set-color");
  });

  it("module commands, a module's commands and New skill (skills, review)", () => {
    const rich = mk("n1", { markdown: "Q: One?\nA: Yes.\nSee [@a2020]." });
    const card = mk("c1", { parent_id: "n1" });
    seed([rich, card], ["review", "skills", "slides"]);
    const { ids: list } = ids({ ...options(), selectedNode: rich, nodes: [rich, card] });
    for (const id of ["a-extract-cards", "a-review-here", "a-present", "b-new-skill"]) {
      expect(list, id).toContain(id);
    }
  });

  it("offers only the one of 'make this note a review card' / 'stop' that fits what the server says", async () => {
    const asked = vi.spyOn(reads.modules.review, "resource");
    const cardCommands = async (id: string, isCard: boolean) => {
      asked.mockResolvedValue({ card: isCard, node_id: id } as never);
      const note = mk(id);
      seed([note], ["review"]);
      const { result } = renderHook(() => useCommandPalette({ ...options(), nodes: [note], selectedNode: note }, usePaletteState()));
      const list = () => { act(() => { result.current.setPaletteOpen(true); result.current.setPaletteQuery(">"); }); return result.current.paletteItems.map((x) => x.id); };
      list(); // the first look starts the question
      await vi.waitFor(() => expect(asked).toHaveBeenCalledWith(`/api/review/cards/${id}`));
      await act(async () => {});
      act(() => { result.current.setPaletteOpen(false); }); // opening it again asks `available` afresh
      return list().filter((x) => x.startsWith("a-review-card"));
    };
    expect(await cardCommands("is-card", true)).toEqual(["a-review-card-off"]);
    expect(await cardCommands("not-card", false)).toEqual(["a-review-card-on"]);
  });
});

describe("New skill is a ⌘K command, not a row of the info panel", () => {
  it("is a note command without a row, so only the palette lists it", () => {
    const command = skillsModule.noteCommands!.find((c) => c.label === "New skill")!;
    expect(command.row).toBeUndefined();
  });
});

describe("the / menu", () => {
  const ctx = (moduleItems: Array<Extract<SlashItem, { kind: "module" }>> = []) => ({
    nodes: [], tags: [], attrClassTags: [], canSetAttr: false, canInsertPage: false, canCreateNote: false, moduleItems,
  });
  const item = (run: () => void): Extract<SlashItem, { kind: "module" }> => ({ kind: "module", title: "Insert sample", Icon: Quote, run });

  it("lists a module's insert after the built-in ones, filtered by what is typed", () => {
    const titles = (query: string) => (getCompletions({ type: "slash", query }, ctx([item(vi.fn())])) as SlashItem[]).map((i) => i.title);
    expect(titles("")).toContain("Insert sample");
    expect(titles("")).toContain("Image, audio or video");
    expect(titles("samp")).toEqual(["Insert sample"]);
    expect((getCompletions({ type: "slash", query: "" }, ctx()) as SlashItem[]).map((i) => i.title)).not.toContain("Insert sample");
  });

  it("choosing it removes the / and hands the module the caret", () => {
    const run = vi.fn();
    const rows = getCompletions({ type: "slash", query: "samp" }, ctx([item(run)]));
    const container = document.createElement("div");
    const view = new EditorView({ doc: "/samp", parent: container, selection: { anchor: 5 } });
    const follow = applyCompletion(view, { type: "slash", triggerStart: 0 }, rows[0]!);
    expect(view.state.doc.toString()).toBe("");
    expect(follow?.kind).toBe("module-insert");
    (follow as { run: () => void }).run();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("no shipped module adds a `/` insert now", () => {
    expect(SLASH_INSERTS).toEqual([]);
  });

  it("the editor shows it in the popup and runs it with the caret where / was", async () => {
    const run = vi.fn();
    const onChange = vi.fn();
    const { container } = render(<MarkdownEditor value="" onChange={onChange} nodes={[]} onMediaInsert={vi.fn(async () => null)} moduleInserts={[item(run)]} />);
    const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
    view.dispatch({ changes: { from: 0, insert: "/samp" }, selection: { anchor: 5 }, userEvent: "input.type" });
    fireEvent.mouseDown(await screen.findByRole("button", { name: /Insert sample/ }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(view.state.doc.toString()).toBe("");
  });
});

describe("the info panel's 「功能」 tab", () => {
  const panel = (node: ContentNode, props: Partial<React.ComponentProps<typeof NodeInspector>> = {}) =>
    render(<NodeInspector node={node} onSelectNode={() => {}} onRunNoteCommand={vi.fn()} {...props} />);
  const cards = () => [...document.querySelectorAll(".info-fn-card")].map((el) => el.querySelector(".info-fn-status")?.textContent);

  it("has no card when no module has anything to do with this note; what could be used is one folded line", async () => {
    const plain = mk("n1", { markdown: "just a sentence" });
    seed([plain], ["review", "skills", "slides"]);
    panel(plain);
    // The modules' files are loaded when the panel opens.
    const more = await screen.findByRole("button", { name: /Also usable here/ });
    expect(cards()).toEqual([]);
    // Playing a note as slides and turning it into a skill are offered, not tied to it.
    await vi.waitFor(() => expect(screen.getByRole("button", { name: /Also usable here/ })).toHaveTextContent("Slides"));
    expect(more).toHaveTextContent("Skills");
  });

  it("lists only the commands that apply, each as a sentence about this note; opened, with a button", async () => {
    const body = "Q: One?\nA: Yes.\nQ: Two?\nA: No.\nQ: Three?\nA: Maybe.";
    const note = mk("n1", { markdown: body });
    seed([note], ["review", "slides"]);
    const onRun = vi.fn();
    panel(note, { onRunNoteCommand: onRun });
    await screen.findByRole("button", { name: /Also usable here/ });
    expect(cards()).toEqual(["3 Q&A pairs in this note"]);
    // Not about this note: no cards under it, so no "Review"; slides can play any note, so it is offered, not a card.
    expect(cards().join()).not.toContain("cards under");
    expect(cards().join()).not.toContain("slides");
    fireEvent.click(screen.getByRole("button", { name: /3 Q&A pairs/ }));
    fireEvent.click(screen.getByRole("button", { name: "Make cards" }));
    expect(onRun.mock.calls[0]![0]).toMatchObject({ id: "a-extract-cards" });
  });

  it("offers to study the cards in and under the note, and the button runs the module's command", async () => {
    // The app no longer knows which notes are cards (a card holds its own reference on the server), so the row names no number.
    const deck = mk("deck", { markdown: "" });
    seed([deck, mk("c1", { parent_id: "deck" })], ["review"]);
    const onRun = vi.fn();
    panel(deck, { onRunNoteCommand: onRun });
    // A deck has children, but 「功能」 is the first tab and opens by itself.
    expect(screen.getByRole("tab", { name: "Functions" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(await screen.findByRole("button", { name: /Study the cards in this note and under it/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun.mock.calls[0]![0]).toMatchObject({ id: "a-review-here" });
  });

  it("offers the note's own review when the server says the note is a card, or a paragraph carries the review word, and not otherwise", async () => {
    const asked = vi.spyOn(reads.modules.review, "resource").mockResolvedValue({ card: true, node_id: "own" } as never);
    const own = mk("own");
    seed([own], ["review"]);
    panel(own);
    fireEvent.click(await screen.findByRole("button", { name: /Study the cards in this note and under it/ }));
    expect(screen.getByRole("button", { name: "Review" })).toBeInTheDocument();
    expect(asked).toHaveBeenCalledWith("/api/review/cards/own");
    cleanup();
    asked.mockResolvedValue({ card: false, node_id: "paras" } as never);
    const paragraphs = mk("paras", { markdown: "What is a register? {#複習}\n\nOther text." });
    seed([paragraphs], ["review"]);
    panel(paragraphs);
    expect(await screen.findByRole("button", { name: /Study the cards in this note and under it/ })).toBeInTheDocument();
    cleanup();
    const plain = mk("plain", { markdown: "Nothing here {#idea}" });
    seed([plain], ["review"]);
    panel(plain);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /Study the cards in this note and under it/ })).toBeNull();
  });

  it("a module that is not imported adds nothing", async () => {
    const note = mk("n1", { markdown: "Q: One?\nA: Yes." });
    seed([note], []);
    panel(note);
    expect(cards()).toEqual([]);
    expect(screen.queryByText(/Q&A pairs/)).toBeNull();
  });

  it("shows nothing for a board's card (the note's text is not on screen)", () => {
    const note = mk("n1", { markdown: "Q: One?\nA: Yes." });
    seed([note], ["review"]);
    panel(note, { noHeadings: true });
    expect(document.querySelector(".info-fn")).toBeNull();
  });
});

describe("one module list for everyone", () => {
  it("every note command with a row has a verb and a sentence", () => {
    for (const { command } of NOTE_COMMANDS) {
      if (!command.row) continue;
      expect(command.row.action).toBeTruthy();
      expect(typeof command.row.describe(mk("n"), "")).toBe("string");
    }
    expect(ALL_MODULES("review")).toBe(true);
  });
});
