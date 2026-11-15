// @vitest-environment jsdom
// Tapping a rendered block / section / note embed opens its source in an
// editor (components/EmbedEditSheet) and never turns it into `![[…]]` text;
// revealing the text is explicit (lib/editorEmbeds).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ApiError, type ContentNode } from "../lib/api";

const saveNoteBody = vi.fn(async (..._args: unknown[]) => {});
const editNoteText = vi.fn(async (..._args: unknown[]) => "applied" as const);
vi.mock("../lib/data/draftActions", async (original) => ({
  ...await original<typeof import("../lib/data/draftActions")>(), saveNoteBody, editNoteText,
}));

const { reads } = await import("../lib/data");
const { resetDrawingCache } = await import("../lib/embedSources");
const { editorEmbeds, embedLineRanges } = await import("../lib/editorEmbeds");
type EmbedEditRequest = import("../lib/editorEmbeds").EmbedEditRequest;
const { anchored, holdLegacyNote, holdAnchored } = await import("./helpers/anchoredText");
const { default: EmbedEditSheet } = await import("../components/EmbedEditSheet");

// Fixtures are written in the old form (`text ^id`); a note's ids are its anchors, the text has none.
const note = (over: Partial<ContentNode> & { id: string; title: string }) =>
  holdLegacyNote({ slug: over.title.toLowerCase(), markdown: "", node_type: "content", ...over }) as unknown as ContentNode;
const SOURCE = anchored("Intro\n\nThe key idea. ^key\n\n- item ^it\n  - child one\n  - child two\n\n## Goals\n\ngoal text\n\n## Next\n\nlater").markdown;
holdAnchored("s1", "Intro\n\nThe key idea. ^key\n\n- item ^it\n  - child one\n  - child two\n\n## Goals\n\ngoal text\n\n## Next\n\nlater");
const source = note({ id: "s1", title: "Source", markdown: SOURCE });
const LIST = "![[Source#^it]]";

let nodes: ContentNode[];
let canEdit = true;
const onOpenWikilink = vi.fn();
const views: EditorView[] = [];

/** A bare editor with the embed extension, and the sheet its taps open. */
function Harness({ doc }: { doc: string }) {
  const [request, setRequest] = useState<EmbedEditRequest | null>(null);
  const [view] = useState(() => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const v = new EditorView({
      parent,
      state: EditorState.create({ doc, selection: { anchor: 0 }, extensions: [editorEmbeds(() => ({ nodes, from: { id: "host" }, onEdit: setRequest }))] }),
    });
    views.push(v);
    return v;
  });
  return request && (
    <EmbedEditSheet
      embed={request.embed} hostNodeId="host" canEdit={canEdit}
      onOpenSource={(id, title) => onOpenWikilink(title, id)} onRevealSyntax={request.revealSource} onClose={() => setRequest(null)}
    />
  ) || <span data-testid="view-ready" data-view={views.indexOf(view)} />;
}

const context = () => ({ nodes, from: { id: "host" } });

beforeEach(() => { nodes = [source]; canEdit = true; saveNoteBody.mockClear(); editNoteText.mockClear(); onOpenWikilink.mockClear(); });
afterEach(() => { resetDrawingCache(); views.splice(0).forEach((v) => { v.dom.parentElement?.remove(); v.destroy(); }); });

async function openEditor(doc = `top\n\n${LIST}\n\nbottom`) {
  render(<Harness doc={doc} />);
  const view = views[0];
  await waitFor(() => {
    const state = view.dom.querySelector(".cm-embed-content")?.getAttribute("data-embed-state");
    expect(state && state !== "loading").toBeTruthy();
  });
  return view;
}

describe("a tap on an embed", () => {
  it("opens the source editor from the top, middle or bottom of a three-line embed, and never shows the text", async () => {
    const view = await openEditor();
    await waitFor(() => expect(view.dom.querySelectorAll(".md-transclusion-body li")).toHaveLength(3));
    const lis = view.dom.querySelectorAll<HTMLElement>(".md-transclusion-body li");
    const spots = [lis[0], lis[1], lis[2], view.dom.querySelector<HTMLElement>(".md-transclusion-body")!];
    expect(lis).toHaveLength(3);
    for (const spot of spots) {
      fireEvent.mouseDown(spot);
      fireEvent.click(spot);
      expect(await screen.findByRole("dialog", { name: "Edit: Source" })).toBeTruthy();
      fireEvent.keyDown(screen.getByLabelText("Source text"), { key: "Escape" });
      fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(view.contentDOM.textContent).not.toContain("![[");
      expect(view.state.selection.main.head).toBe(0);
      expect(embedLineRanges(view.state, context)).toHaveLength(1);
    }
  });

  it("opens the block's own text", async () => {
    const view = await openEditor();
    fireEvent.click(view.dom.querySelector(".md-transclusion-body")!);
    const text = (await screen.findByLabelText("Source text")) as HTMLTextAreaElement;
    expect(text.value).toBe("- item\n  - child one\n  - child two");
    expect(text.readOnly).toBe(false);
  });

  it("a link inside the embed still acts on its own", async () => {
    nodes = [source, note({ id: "o1", title: "Other", markdown: "x" }), note({ id: "s2", title: "Linky", markdown: "see [[Other]] ^lk" })];
    const view = await openEditor("![[Linky#^lk]]");
    const link = await waitFor(() => {
      const el = view.dom.querySelector<HTMLElement>(".md-transclusion-body a");
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.click(link);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the strip after the embed shows its text, with the caret on that line", async () => {
    const view = await openEditor();
    fireEvent.click(view.dom.querySelector(".cm-embed-end")!);
    expect(view.dom.querySelector(".cm-embed")).toBeNull();
    expect(view.contentDOM.textContent).toContain(LIST);
    expect(view.state.selection.main.head).toBe(view.state.doc.line(3).to);
  });

  it("a long press on a touch shows the text and does not also open the editor", async () => {
    {
      const view = await openEditor();
      const embed = view.dom.querySelector<HTMLElement>(".cm-embed")!;
      const body = embed.querySelector<HTMLElement>(".md-transclusion-body")!;
      fireEvent.pointerDown(body, { pointerType: "touch", clientX: 5, clientY: 5 });
      await act(async () => { await new Promise((done) => setTimeout(done, 650)); });
      fireEvent.pointerUp(body, { pointerType: "touch" });
      fireEvent.click(body);
      expect(view.contentDOM.textContent).toContain(LIST);
      expect(screen.queryByRole("dialog")).toBeNull();
    }
  });

  it("「編輯嵌入語法」 in the sheet closes it and shows the text", async () => {
    const view = await openEditor();
    fireEvent.click(view.dom.querySelector(".md-transclusion-body")!);
    fireEvent.click(await screen.findByText("Edit embed syntax"));
    await waitFor(() => expect(view.contentDOM.textContent).toContain(LIST));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the ↗ button opens the source note", async () => {
    const view = await openEditor();
    fireEvent.click(view.dom.querySelector(".md-transclusion-body")!);
    fireEvent.click(await screen.findByLabelText("Open the source note"));
    await waitFor(() => expect(onOpenWikilink).toHaveBeenCalledWith("Source", "s1"));
  });

  it("a drawing's picture opens the drawing and never shows the text", async () => {
    const drawing = note({ id: "d1", title: "Sketch" });
    const doc = "![[Sketch.excalidraw]]\n\nx";
    nodes = [drawing];
    const open = vi.fn();
    vi.spyOn(reads.notes, "attributeValues").mockResolvedValue({ ink_data: null, pdf_url: null } as never);
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ parent, state: EditorState.create({ doc, extensions: [editorEmbeds(() => ({ nodes, from: null, onOpen: open, onEdit: vi.fn() }))] }) });
    views.push(view);
    const picture = await waitFor(() => {
      const el = view.dom.querySelector<HTMLElement>(".md-drawing-picture");
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.click(picture);
    expect(open).toHaveBeenCalledWith("d1");
    expect(view.contentDOM.textContent).not.toContain("![[");
  });
});

describe("the editor sheet", () => {
  async function openSheet() {
    const view = await openEditor();
    fireEvent.click(view.dom.querySelector(".md-transclusion-body")!);
    return (await screen.findByLabelText("Source text")) as HTMLTextAreaElement;
  }

  it("writes the edited range back into the source note, keeping the rest", async () => {
    const text = await openSheet();
    fireEvent.change(text, { target: { value: "- item edited\n  - child one\n  - child two\n  - child three" } });
    fireEvent.blur(text);
    await waitFor(() => expect(saveNoteBody).toHaveBeenCalledTimes(1));
    const [id, whole, base] = saveNoteBody.mock.calls[0];
    expect(id).toBe("s1");
    expect(base).toBe(SOURCE);
    expect(whole).toBe(SOURCE.replace("- item\n  - child one\n  - child two", "- item edited\n  - child one\n  - child two\n  - child three"));
  });

  it("an edit that splits the block writes both parts, in place", async () => {
    nodes = [source];
    const view = await openEditor(`![[Source#^key]]\n\nafter`);
    fireEvent.click(await waitFor(() => {
      const el = view.dom.querySelector<HTMLElement>(".md-transclusion-body");
      expect(el?.textContent).toContain("The key idea.");
      return el!;
    }));
    const text = (await screen.findByLabelText("Source text")) as HTMLTextAreaElement;
    fireEvent.change(text, { target: { value: "First.\n\nSecond." } });
    fireEvent.blur(text);
    await waitFor(() => expect(saveNoteBody).toHaveBeenCalled());
    expect(saveNoteBody.mock.calls[0][1]).toContain("First.\n\nSecond.\n\n- item");
  });

  it("closing waits for the save, and keeps the input when it is refused", async () => {
    saveNoteBody.mockRejectedValueOnce(new Error("refused"));
    const text = await openSheet();
    fireEvent.change(text, { target: { value: "- changed" } });
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    await screen.findByText("Card changes not saved");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((screen.getByLabelText("Source text") as HTMLTextAreaElement).value).toBe("- changed");
  });

  it("a note the viewer cannot change opens read-only, with the reason", async () => {
    canEdit = false;
    const text = await openSheet();
    expect(text.readOnly).toBe(true);
    expect(screen.getByText("You can read this note but not change it, so this opens read-only.")).toBeTruthy();
    fireEvent.change(text, { target: { value: "x" } });
    fireEvent.blur(text);
    expect(saveNoteBody).not.toHaveBeenCalled();
  });

  it("the open note's own block is edited through its draft", async () => {
    nodes = [note({ id: "host", title: "Host", markdown: "Mine. ^me\n\n![[Host#^me]]" })];
    const view = await openEditor("![[Host#^me]]");
    fireEvent.click(await waitFor(() => {
      const el = view.dom.querySelector<HTMLElement>(".md-transclusion-body");
      expect(el?.textContent).toContain("Mine.");
      return el!;
    }));
    const text = (await screen.findByLabelText("Source text")) as HTMLTextAreaElement;
    fireEvent.change(text, { target: { value: "Mine, edited." } });
    fireEvent.blur(text);
    await waitFor(() => expect(editNoteText).toHaveBeenCalledTimes(1));
    const edit = editNoteText.mock.calls[0][1] as (body: string) => string;
    expect(edit("Mine.\n\n![[Host#^me]]")).toBe("Mine, edited.\n\n![[Host#^me]]");
    expect(saveNoteBody).not.toHaveBeenCalled();
  });
});

describe("an embed that cannot be edited", () => {
  it("an unreadable note shows a neutral placeholder without its title, and the sheet says the same", async () => {
    const slim = note({ id: "p1", title: "Private plans", markdown: "", body_len: 40 } as never);
    nodes = [slim];
    vi.spyOn(reads.notes, "full").mockRejectedValue(new ApiError(403, "{}"));
    const view = await openEditor("![[Private plans#^k]]");
    await waitFor(() => expect(view.dom.querySelector(".md-embed-notice")?.textContent).toBe("Content you cannot access"));
    expect(view.dom.textContent).not.toContain("Private plans");
    fireEvent.click(view.dom.querySelector(".md-embed-notice")!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a block that is not in the note says it was deleted", async () => {
    const view = await openEditor("![[Source#^nope]]");
    await waitFor(() => expect(view.dom.querySelector(".md-embed-notice")?.textContent).toBe("This paragraph was deleted"));
    expect(view.dom.textContent).not.toContain("— Source");
  });
});
