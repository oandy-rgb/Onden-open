// @vitest-environment jsdom
// D99: every modal is a ui/Modal, so a modal opened from a modal stacks on
// top and takes focus, Esc closes only the top one, and the page's shortcuts
// wait while a modal is open — except the palette's, which opens above it.
// The real app wiring: the global dispatcher (useKeyboardShortcuts) opens the
// CommandPalette while Version history (NoteHistory) is open.
// jsdom has no top layer: test/setup.ts's dialog stub keeps the open order and
// sends an uncancelled Esc to the last-opened dialog only, as browsers do.
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NoteHistory } from "../components/history";
import type { NoteHistoryVersion } from "../lib/history";
import CommandPalette from "../components/CommandPalette";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import type { ContentNode } from "../lib/api";
import { setLocalePref } from "../lib/i18n";
// History rows read the session; the real store keeps a 1 s unmount timer that can outlive the test environment.
vi.mock("../lib/accountSession", () => ({ useAccountSession: () => null }));

const note: ContentNode = {
  id: "a", title: "Current note", markdown: "Current body", slug: "a", node_type: "content", source_type: "manual",
};
const versions: NoteHistoryVersion[] = [{
  id: "version-1", title: "Old note", markdown: "Old body", changed_at: "2026-09-12T00:00:00Z", actor_name: "Test author", actor_type: "user",
}];

const ctrlK = { key: "k", code: "KeyK", ctrlKey: true };
const ctrlN = { key: "n", code: "KeyN", ctrlKey: true };

function App({ createNote }: { createNote: () => void }) {
  const [historyOpen, setHistoryOpen] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const noop = () => {};
  useKeyboardShortcuts({
    mode: "notes", notesView: "editor", selectedId: "a", setSelectedId: noop,
    createOpen: false, setCreateOpen: noop, createNote, canvasSearch: "", setCanvasSearch: noop,
    onOpenOverviewSearch: noop, setPaletteOpen, setPaletteQuery: setQuery, setPaletteIndex: setIndex,
    saveOverviewDraft: noop, setOverviewView: noop, openDailyNote: noop,
    setFocusMode: noop,
  });
  return <>
    <button type="button">Page behind</button>
    {historyOpen && <NoteHistory node={note} versions={versions} currentMarkdown={note.markdown} nodes={[note]}
      online={false} onOpenNote={noop} onClose={() => setHistoryOpen(false)} />}
    <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} query={query} onQueryChange={setQuery}
      index={index} onIndexChange={setIndex} items={[]} inputRef={inputRef} searching={false} onSelect={noop} />
  </>;
}

const history = () => screen.queryByRole("dialog", { name: "Version history" });
const palette = () => screen.queryByRole("dialog", { name: "Command palette" });

beforeEach(() => setLocalePref("en"));
afterEach(() => setLocalePref("system"));

describe("modals opened from modals", () => {
  it("⌘K inside Version history opens the palette on top, with focus; Esc closes only the palette", async () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    render(<App createNote={vi.fn()} />);
    const card = document.querySelector(".nh")!;
    expect(card).toHaveFocus();

    fireEvent.keyDown(card, ctrlK);
    expect(palette()).not.toBeNull();
    // Opened after the history: on top of it in the browser's top layer.
    expect(showModal.mock.contexts).toEqual([history(), palette()]);
    expect(screen.getByRole("searchbox")).toHaveFocus();
    expect(palette()!.contains(document.activeElement)).toBe(true);

    await userEvent.keyboard("{Escape}");
    expect(palette()).toBeNull();
    expect(history()).not.toBeNull();
    // Focus goes back into the history, the next Esc is the history's.
    expect(card).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(history()).toBeNull();
  });

  it("⌘K in the palette over the history closes the palette and leaves the history", () => {
    render(<App createNote={vi.fn()} />);
    fireEvent.keyDown(document.querySelector(".nh")!, ctrlK);
    fireEvent.keyDown(screen.getByRole("searchbox"), ctrlK);
    expect(palette()).toBeNull();
    expect(history()).not.toBeNull();
  });
});

describe("page shortcuts behind an open modal", () => {
  it("do not fire, whether the key starts in the modal or on the page", () => {
    const createNote = vi.fn();
    render(<App createNote={createNote} />);
    fireEvent.keyDown(document.querySelector(".nh")!, ctrlN);
    fireEvent.keyDown(screen.getByRole("button", { name: "Back" }), ctrlN);
    // Focus fell to <body> (a press on a non-control), or a key sent to the window.
    fireEvent.keyDown(document.body, ctrlN);
    fireEvent.keyDown(window, ctrlN);
    expect(createNote).not.toHaveBeenCalled();
  });

  it("fire again once the modal is closed", () => {
    const createNote = vi.fn();
    render(<App createNote={createNote} />);
    act(() => { fireEvent.click(screen.getByRole("button", { name: "Back" })); });
    expect(history()).toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { name: "Page behind" }), ctrlN);
    expect(createNote).toHaveBeenCalledTimes(1);
  });

  it("the palette's own chord reaches the page from behind a modal too (focus on <body>)", () => {
    render(<App createNote={vi.fn()} />);
    fireEvent.keyDown(document.body, ctrlK);
    expect(palette()).not.toBeNull();
  });
});
