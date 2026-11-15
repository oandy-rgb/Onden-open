import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import HandwritingPane from "../modules/handwriting/HandwritingPane";
import { apiFetch, type ContentNode } from "../lib/api";
import { saveInk } from "../lib/data/inkWriter";
import { handwritingModule } from "../modules/handwriting";
import { NOTE_VIEW_MODULES, hiddenNoteViewLayouts } from "../modules";
import { noteDoc, notePages, type InkDocument, type InkPages } from "@onden/markdown/ink";

// The 「手寫」 tab of a note: a note view of the handwriting module whose pane keeps the pages in the note's own
// attribute `note_ink` (never `ink_data`, which would turn the note's content tab into a handwriting page).

vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), apiFetch: vi.fn() }));
vi.mock("../lib/data/inkWriter", async (original) => ({ ...await original<typeof import("../lib/data/inkWriter")>(), saveInk: vi.fn() }));
const seen = vi.hoisted(() => ({ pages: undefined as unknown, readOnly: undefined as unknown, notice: undefined as unknown }));
vi.mock("../components/InkNodeView", () => ({
  default: ({ initialPages, onPagesChange, readOnly, readOnlyNotice }: { initialPages: InkPages; onPagesChange: (pages: InkPages, options?: { keepalive?: boolean }) => void; readOnly?: boolean; readOnlyNotice?: string }) => {
    seen.pages = initialPages;
    seen.readOnly = readOnly;
    seen.notice = readOnlyNotice;
    return <button onClick={() => onPagesChange(notePages({ ...(noteDoc(initialPages) as InkDocument), erased: { s1: [[0, 0]] } }), { keepalive: true })}>pages</button>;
  },
}));

const node: ContentNode = { id: "n1", title: "Lecture", slug: "lecture", markdown: "words", node_type: "content", source_type: "manual" };
const page = { version: 1, strokes: [{ id: "s1", points: [[0, 0]], color: "#000", size: 2, toolId: "pen" }], erased: {}, page: { width: 1000 } };

function pane(attrs: Array<{ key: string; value: string }>, canEdit = true) {
  vi.mocked(apiFetch).mockImplementation(async (path) => new Response(JSON.stringify(String(path).startsWith(`/api/nodes/${node.id}/attributes?`) ? attrs : []), { status: 200 }));
  return render(<HandwritingPane node={node} canEdit={canEdit} onOpenNode={() => {}} />);
}

afterEach(() => { vi.mocked(saveInk).mockReset(); seen.pages = undefined; seen.readOnly = undefined; seen.notice = undefined; });

describe("the 手寫 tab", () => {
  it("is a note view of the built-in handwriting module, offered on a note and never on a tag", () => {
    expect(NOTE_VIEW_MODULES.find((m) => m.id === "handwriting")).toMatchObject({ library: { title: "Handwriting" } });
    expect(handwritingModule.noteView?.title).toBe("Handwriting");
    expect(hiddenNoteViewLayouts(() => true, "node").has("handwriting")).toBe(false);
    expect(hiddenNoteViewLayouts(() => true, "tag").has("handwriting")).toBe(true);
  });

  it("opens the pages stored in note_ink and saves an edit back to note_ink with the stored drawing as its base", async () => {
    pane([{ key: "note_ink", value: JSON.stringify(page) }, { key: "ink_data", value: "ignored" }]);
    fireEvent.click(await screen.findByRole("button", { name: "pages" }, { timeout: 10_000 }));
    expect(noteDoc(seen.pages as InkPages)).toMatchObject({ strokes: [{ id: "s1" }] });
    expect(saveInk).toHaveBeenCalledTimes(1);
    const [nodeId, doc, base, options] = vi.mocked(saveInk).mock.calls[0]!;
    expect(nodeId).toBe("n1");
    expect(doc).toMatchObject({ erased: { s1: [[0, 0]] } });
    expect(base).toMatchObject({ strokes: [{ id: "s1" }], erased: {} });
    expect(options).toMatchObject({ attr: "note_ink", keepalive: true });
  });

  it("starts empty when the note has no strokes yet", async () => {
    pane([]);
    await screen.findByRole("button", { name: "pages" }, { timeout: 10_000 });
    expect(noteDoc(seen.pages as InkPages)).toBeNull();
    expect(saveInk).not.toHaveBeenCalled();
  });

  it("is read-only for someone who cannot edit the note", async () => {
    pane([{ key: "note_ink", value: JSON.stringify(page) }], false);
    await screen.findByRole("button", { name: "pages" }, { timeout: 10_000 });
    expect(seen.readOnly).toBe(true);
    // Not the 「update the app」 notice: the drawing is fine, the person just may not change this note.
    expect(seen.notice).toBe("You can read this note but not change it, so this opens read-only.");
  });

  it("keeps the update notice for a drawing made with a newer version (no notice of its own)", async () => {
    pane([{ key: "note_ink", value: JSON.stringify({ ...page, requires: ["future-feature"] }) }]);
    await screen.findByRole("button", { name: "pages" }, { timeout: 10_000 });
    expect(seen.readOnly).toBe(true);
    expect(seen.notice).toBeUndefined();
  });
});
