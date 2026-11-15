import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import NoteActions from "../components/NoteActions";
import { NOTE_HEADER_ACTIONS, noteActionList, noteActionView, type NoteActionContext } from "../lib/data";
import type { NoteCommand } from "../modules/types";
import { clearPhoneLayout, setPhoneLayout } from "./phoneMedia";
import { setAppState } from "../lib/appStore";
import { noWorkspaceData } from "../lib/api";

// Globals are unstubbed after every test (test/setup.ts): stub per test.
beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} }); });
afterEach(() => clearPhoneLayout());

// surface [per-note-actions-menu]: the header ⋯ shows the NOTE_HEADER_ACTIONS
// of lib/data noteActionList — wide: a popover, phone: a bottom sheet — and
// calls the EXISTING handlers it is wired to. What it no longer shows is
// still in the list (the sidebar's context menu and ⌘K render from it).

const NOTE = { id: "n1", node_type: "content", parent_id: null, markdown: "Body" } as const;
const COMMANDS: NoteCommand[] = [
  { id: "a-extract-cards", label: "Extract review cards (Q:/A:)", keywords: [], run: vi.fn() },
  { id: "a-review-here", label: "Review cards under this note", keywords: [], run: vi.fn() },
];
const actionsFor = (ctx: Partial<NoteActionContext<NoteCommand>> = {}) =>
  noteActionView(noteActionList(NOTE, { canEdit: true, online: true, hasVersions: true, commands: COMMANDS, ...ctx }));

const baseProps = () => ({
  actions: actionsFor(),
  onDuplicate: vi.fn(),
  onExport: vi.fn(),
  onCopyMarkdown: vi.fn().mockResolvedValue(true),
  onVersionHistory: vi.fn(),
  onDelete: vi.fn(),
});

const openMenu = () => fireEvent.click(screen.getByTitle("More actions"));
const rows = () => screen.getAllByRole("menuitem").map((el) => el.textContent);

describe("wide ⋯ menu", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is a popover with history, a copy, export ›, a divider and Delete — nothing else", () => {
    render(<NoteActions {...baseProps()} />);
    openMenu();
    expect(rows()).toEqual(["History of this note", "Duplicate", "Export as", "Text style…", "Delete"]);
    expect(screen.getAllByRole("separator")).toHaveLength(1);
    expect(screen.queryByText("More actions", { selector: ".ui-menu-heading *" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(document.querySelector(".ui-menu--sheet")).toBeNull();
  });

  it("has no module commands (they are in the info panel's 功能 tab), even when the list offers some", () => {
    const skill: NoteCommand = { id: "switch-skills", label: "Use as a skill", keywords: [], run: vi.fn() };
    render(<NoteActions {...baseProps()} actions={actionsFor({ commands: [skill] })} />);
    openMenu();
    expect(rows()).toEqual(["History of this note", "Duplicate", "Export as", "Text style…", "Delete"]);
    expect(screen.queryByRole("menuitem", { name: "Use as a skill" })).toBeNull();
  });

  it("starts with the note's length, then its paragraphs, tasks and creation day", async () => {
    const body = vi.fn(() => "one two three\n\n- [ ] four\n- [x] five\n\nsix seven");
    // The tasks are the note's in the store (the 「功能」 tab's 任務 row counts the same), not its checkbox lines.
    setAppState({ data: { ...noWorkspaceData, tasks: [{ id: "t1", node_id: "n1" }, { id: "t2", node_id: "n1" }, { id: "t3", node_id: "other" }] as never } });
    render(<NoteActions {...baseProps()} stats={{ nodeId: "n1", body, createdAt: "2026-10-24T08:00:00Z" }} />);
    expect(body).not.toHaveBeenCalled(); // counted when the menu opens, not on every render
    openMenu();
    const group = await screen.findByRole("group", { name: "About this note" });
    expect(group).toHaveTextContent(/\d+ words · 1 min read/);
    expect(group).toHaveTextContent("4 paragraphs · 2 tasks · Created");
    expect(screen.getAllByRole("menuitem")[0]).toHaveTextContent("History of this note");
  });

  it("says so for a note with no text", async () => {
    render(<NoteActions {...baseProps()} stats={{ nodeId: "n1", body: () => "" }} />);
    openMenu();
    expect(await screen.findByRole("group", { name: "About this note" })).toHaveTextContent("No text yet");
  });

  it("leaves out what moved: pin, colour, module commands, rename, 更多, Info", () => {
    render(<NoteActions {...baseProps()} actions={actionsFor()} />);
    openMenu();
    for (const label of ["Pin", "Color", "Set color", 
      "Review cards under this note", "Extract review cards (Q:/A:)", "Rename", "More", "Image", "Writing mode", "Info"]) {
      expect(screen.queryByText(label), label).toBeNull();
    }
  });

  it("Export as › holds Copy Markdown, a Markdown file, HTML and Print / PDF, and routes the format", async () => {
    const p = baseProps();
    render(<NoteActions {...p} />);
    openMenu();
    fireEvent.click(screen.getByText("Export as"));
    const group = screen.getByRole("menu", { name: "Export as" });
    expect(within(group).getAllByRole("menuitem").map((el) => el.textContent)).toEqual(["Copy Markdown", "Markdown file", "Markdown file (paragraph links as footnotes)", "Markdown file (Obsidian compatible)", "HTML", "Print / save as PDF", "Word (sans-serif)", "Word (serif)"]);
    fireEvent.keyDown(group, { key: "Escape" });
    // A finished export closes the menu, so each format is its own opening.
    for (const [label, format] of [["Markdown file", "markdown"], ["HTML", "html"], ["Print / save as PDF", "pdf"]] as const) {
      if (!screen.queryByText("Export as")) openMenu();
      if (!screen.queryByRole("menu", { name: "Export as" })) fireEvent.click(screen.getByText("Export as"));
      await act(async () => { fireEvent.click(screen.getByText(label)); });
      expect(p.onExport).toHaveBeenLastCalledWith(format);
    }
  });

  it("clicking an item calls the wired handler", () => {
    const p = baseProps();
    const { unmount } = render(<NoteActions {...p} />);
    openMenu(); fireEvent.click(screen.getByText("Duplicate"));
    expect(p.onDuplicate).toHaveBeenCalledTimes(1);
    unmount();
    render(<NoteActions {...p} />);
    openMenu(); fireEvent.click(screen.getByText("History of this note"));
    expect(p.onVersionHistory).toHaveBeenCalledTimes(1);
    openMenu(); fireEvent.click(screen.getByText("Delete"));
    expect(p.onDelete).toHaveBeenCalledTimes(1);
  });

  it("an export in flight disables the others, and a refused copy keeps the menu open", async () => {
    let finish!: (ok: boolean) => void;
    const onExport = vi.fn().mockImplementationOnce(() => new Promise<boolean>(yes => { finish = yes; })).mockResolvedValue(true);
    const { unmount } = render(<NoteActions {...baseProps()} onExport={onExport} />);
    openMenu(); fireEvent.click(screen.getByText("Export as"));
    fireEvent.click(screen.getByText("Markdown file"));
    expect((screen.getByText("Markdown file") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("Markdown file")); expect(onExport).toHaveBeenCalledTimes(1);
    await act(async () => { finish(true); });
    unmount();
    const copy = vi.fn().mockResolvedValue(false);
    render(<NoteActions {...baseProps()} onCopyMarkdown={copy} />);
    openMenu(); fireEvent.click(screen.getByText("Export as"));
    await act(async () => { fireEvent.click(screen.getByText("Copy Markdown")); });
    expect(copy).toHaveBeenCalledOnce(); expect(screen.getByText("Copy Markdown")).toBeTruthy();
  });

  it("a viewer: no Delete; Duplicate, history and export stay (D112)", () => {
    render(<NoteActions {...baseProps()} actions={actionsFor({ canEdit: false })} />);
    openMenu();
    expect(rows()).toEqual(["History of this note", "Duplicate", "Export as", "Text style…"]);
  });

  it("history is offered only where the note has versions", () => {
    render(<NoteActions {...baseProps()} actions={actionsFor({ hasVersions: false })} onVersionHistory={undefined} />);
    openMenu();
    expect(screen.queryByText("History of this note")).toBeNull();
  });
});

describe("the list still offers what the ⋯ no longer shows", () => {
  it("顯示… is the one added item: after Export as, before the divider, and only when the editor lists rows", () => {
    const run = vi.fn();
    const displayRows = [
      { id: "wide", label: "Full width", pressed: false, run },
      { id: "zen", label: "Writing mode", run },
    ];
    const { unmount } = render(<NoteActions {...baseProps()} displayRows={displayRows} />);
    openMenu();
    expect(rows()).toEqual(["History of this note", "Duplicate", "Export as", "Display…", "Text style…", "Delete"]);
    fireEvent.click(screen.getByText("Display…"));
    const group = screen.getByRole("menu", { name: "Display" });
    expect(within(group).getAllByRole("menuitemradio", { hidden: true }).map((el) => el.textContent)).toEqual(["Full width"]);
    fireEvent.click(within(group).getByText("Writing mode"));
    // The row hears where the ⋯ is, to open its panel there.
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu", { name: "More actions" })).toBeNull();
    unmount();
    render(<NoteActions {...baseProps()} displayRows={[]} />);
    openMenu();
    expect(screen.queryByText("Display…")).toBeNull();
  });

  it("NOTE_HEADER_ACTIONS is a choice among the list's actions, not a second list", () => {
    const ids = actionsFor().list.map((a) => a.id);
    for (const id of NOTE_HEADER_ACTIONS) expect(ids, id).toContain(id);
    for (const id of ["toggle-pin", "set-color", "rename"]) {
      expect(actionsFor().has(id), id).toBe(true);
      expect(NOTE_HEADER_ACTIONS as readonly string[], id).not.toContain(id);
    }
  });
});

// 2026-11-03: a note's views are added from the title strip's 「＋」 (ViewTabs), not from ⋯: the menu has no
// 「檢視」 section and no group labels, on a wide screen or a phone.
describe("⋯ has no view section", () => {
  afterEach(() => clearPhoneLayout());
  it.each([["wide", false], ["phone", true]])("%s: no 「Add a view」 label and no view kinds", (_name, phone) => {
    setPhoneLayout(phone);
    render(<NoteActions {...baseProps()} />);
    openMenu();
    expect(document.querySelectorAll(".ui-menu-label")).toHaveLength(0);
    for (const kind of ["Table", "Calendar", "Board", "Cards"]) expect(screen.queryByRole("menuitem", { name: kind })).toBeNull();
  });
});

describe("phone ⋯: a bottom sheet", () => {
  beforeEach(() => { vi.clearAllMocks(); setPhoneLayout(true); });
  const sheet = () => document.querySelector(".ui-menu--sheet") as HTMLElement;
  const phone = (view: "edit" | "preview" | null = "edit") => ({ view, onSetView: vi.fn(), onFind: vi.fn() });

  it("is exactly as before: no 顯示…, whatever rows the editor has", () => {
    render(<NoteActions {...baseProps()} displayRows={[{ id: "wide", label: "Full width", run: vi.fn() }]} phoneEditor={phone()} />);
    openMenu();
    expect(screen.queryByText("Display…")).toBeNull();
    expect(screen.queryByText("Full width")).toBeNull();
  });

  it("has a handle, four equal tiles (find, preview, history, export), a copy block and a red Delete", () => {
    render(<NoteActions {...baseProps()} phoneEditor={phone()} />);
    openMenu();
    expect(sheet()).toBeTruthy();
    expect(sheet().querySelector(".ui-sheet-handle")).toBeTruthy();
    const tiles = [...sheet().querySelectorAll(".note-sheet-tile")];
    expect(tiles.map((el) => el.textContent)).toEqual(["Find", "Preview", "History", "Export"]);
    for (const tile of tiles) expect(tile.querySelector("svg")).toBeTruthy();
    expect(rows()).toEqual(["Find", "Preview", "History", "Export", "Text style…", "Duplicate", "Delete"]);
    const groups = [...sheet().querySelectorAll(".note-sheet-group")];
    expect(groups.map((g) => g.textContent)).toEqual(["Text style…", "Duplicate", "Delete"]);
    expect(screen.getByRole("menuitem", { name: "Delete" }).className).toContain("ui-menu-item--danger");
  });

  it("has no 「更多動作」 heading and no ✕", () => {
    render(<NoteActions {...baseProps()} phoneEditor={phone()} />);
    openMenu();
    expect(sheet().querySelector(".ui-menu-heading")).toBeNull();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("the preview tile says Edit while previewing, and flips the view", () => {
    const p = phone("preview");
    render(<NoteActions {...baseProps()} phoneEditor={p} />);
    openMenu();
    expect(screen.queryByRole("menuitem", { name: "Preview" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(p.onSetView).toHaveBeenCalledWith("edit");
  });

  it("a note with no preview (PDF, handwriting) has no such tile", () => {
    render(<NoteActions {...baseProps()} phoneEditor={phone(null)} />);
    openMenu();
    expect(rows().slice(0, 3)).toEqual(["Find", "History", "Export"]);
  });

  it("Export expands in the sheet: Copy Markdown, Markdown file, HTML, Print / PDF", () => {
    const p = baseProps();
    render(<NoteActions {...p} phoneEditor={phone()} />);
    openMenu();
    const tile = screen.getByRole("menuitem", { name: "Export" });
    expect(tile.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(tile);
    expect(tile.getAttribute("aria-expanded")).toBe("true");
    const group = screen.getByRole("group", { name: "Export as" });
    expect(within(group).getAllByRole("menuitem").map((el) => el.textContent)).toEqual(["Copy Markdown", "Markdown file", "Markdown file (paragraph links as footnotes)", "Markdown file (Obsidian compatible)", "HTML", "Print / save as PDF", "Word (sans-serif)", "Word (serif)"]);
    fireEvent.click(within(group).getByText("HTML"));
    expect(p.onExport).toHaveBeenCalledWith("html");
  });

  it("Find, History, Duplicate and Delete call their handlers and close the sheet", () => {
    const p = baseProps();
    const ph = phone();
    render(<NoteActions {...p} phoneEditor={ph} />);
    for (const [name, spy] of [["Find", ph.onFind], ["History", p.onVersionHistory], ["Duplicate", p.onDuplicate], ["Delete", p.onDelete]] as const) {
      openMenu();
      fireEvent.click(screen.getByRole("menuitem", { name }));
      expect(spy, name).toHaveBeenCalledTimes(1);
      expect(sheet(), name).toBeNull();
    }
  });

  it("Esc closes it", () => {
    render(<NoteActions {...baseProps()} phoneEditor={phone()} />);
    openMenu();
    fireEvent.keyDown(sheet(), { key: "Escape" });
    expect(sheet()).toBeNull();
  });

  it("a viewer's sheet has no Delete", () => {
    render(<NoteActions {...baseProps()} actions={actionsFor({ canEdit: false })} phoneEditor={phone()} />);
    openMenu();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
  });
});

describe("the Info button", () => {
  it("is on the phone too, once, beside ⋯, and runs the toggle", () => {
    setPhoneLayout(true);
    const onToggle = vi.fn();
    render(<NoteActions {...baseProps()} inspectorToggle={{ pressed: false, onToggle }} phoneEditor={{ view: "edit", onSetView: vi.fn() }} />);
    const info = screen.getAllByRole("button", { name: "Info" });
    expect(info).toHaveLength(1);
    expect(info[0]!.className).toContain("tap-target");
    expect(info[0]!.nextElementSibling?.contains(screen.getByTitle("More actions"))).toBe(true);
    fireEvent.click(info[0]!);
    expect(onToggle).toHaveBeenCalledTimes(1);
    openMenu();
    expect(screen.queryByRole("menuitem", { name: "Info" })).toBeNull();
  });
});
