import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import OverviewEditor from "../components/OverviewEditor";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import type { ContentNode } from "../lib/api";

// ⌘S was bound twice — the shortcut dispatcher (lib/shortcuts "save-draft")
// and a window listener of OverviewEditor's own — so one press sent two
// identical PATCHes. The dispatcher is the one binding; it must still fire
// with the caret inside the CodeMirror editor.

vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), apiFetch: vi.fn(async () => new Response("[]", { status: 200 })) }));

const note: ContentNode = { id: "note-a", title: "A", slug: "a", markdown: "text", node_type: "content", source_type: "manual" };

function Shortcuts({ save }: { save: () => void }) {
  const noop = () => {};
  useKeyboardShortcuts({
    mode: "notes", notesView: "editor", selectedId: note.id, setSelectedId: noop,
    createOpen: false, setCreateOpen: noop, createNote: noop, canvasSearch: "", setCanvasSearch: noop,
    onOpenOverviewSearch: noop, setPaletteOpen: noop, setPaletteQuery: noop, setPaletteIndex: noop,
    saveOverviewDraft: save, setOverviewView: noop, openDailyNote: noop,
    setFocusMode: noop,
  });
  return null;
}

describe("⌘S in the note editor", () => {
  it("saves once, also from inside the editor", { timeout: 20_000 }, async () => {
    const save = vi.fn();
    const { container } = render(<>
      <Shortcuts save={save} />
      <OverviewEditor node={note} titleDraft={note.title} onTitleChange={() => {}} draft={note.markdown ?? ""} onDraftChange={() => {}}
        view="edit" setView={() => {}} saveStatus="saved" onSave={save} online nodes={[note]}
        onOpenWikilink={() => {}} onCreateFirst={() => {}} onSelectNode={() => {}} />
    </>);
    const content = await waitFor(() => {
      const el = container.querySelector<HTMLElement>(".cm-content");
      expect(el).not.toBeNull();
      return el!;
    }, { timeout: 10_000 });
    content.focus();

    fireEvent.keyDown(content, { key: "s", ctrlKey: true });

    expect(save).toHaveBeenCalledTimes(1);
  });
});
