// @vitest-environment jsdom
// `![[drawing]]` embeds in the app: the resolver (lib/embeds), the preview
// (MarkdownRenderer → lib/embedDom) and the editor's block widget
// (lib/editorEmbeds). The user's case: a note whose body is
// `![[2025-12-08 09.58.38.excalidraw]]`, naming a drawing imported from
// Obsidian Excalidraw (title without `.excalidraw`, the old name an alias).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { encodeInk, type InkDocument } from "@onden/markdown/ink";
import type { ContentNode } from "../lib/api";

const ink: InkDocument = {
  version: 1, erased: {}, page: { width: 1000 },
  strokes: [{ id: "s", color: "#1e1e1e", size: 4, toolId: "pen", points: [[10, 10], [60, 40], [120, 20]] }],
};
const stored = new Map<string, Record<string, string | null>>();
const { reads } = await import("../lib/data");
// Spies are restored after every test (test/setup.ts): each test gets its own.
const fakeAttributeValues = (async (id: string, keys: readonly string[]) =>
  Object.fromEntries(keys.map((k) => [k, stored.get(id)?.[k] ?? null]))) as typeof reads.notes.attributeValues;
let loadInkAttributes = vi.spyOn(reads.notes, "attributeValues").mockImplementation(fakeAttributeValues);

const { resolveEmbed } = await import("../lib/embeds");
const { resetDrawingCache, drawingSvg } = await import("../lib/embedSources");
const { editorEmbeds, embedLineRanges, embedEditorFocus } = await import("../lib/editorEmbeds");
const { default: MarkdownRenderer } = await import("../components/MarkdownRenderer");
const { ZH_TW: zhTW } = await import("../lib/i18n.zh-TW");

const drawing = {
  id: "d1", title: "2025-12-08 09.58.38", slug: "2025-12-08-0958-38", markdown: "", node_type: "content",
  attrs: { aliases: JSON.stringify(["2025-12-08 09.58.38.excalidraw"]) },
} as unknown as ContentNode;
const plain = { id: "n1", title: "Plain note", slug: "plain-note", markdown: "", node_type: "content" } as unknown as ContentNode;
const nodes = [drawing, plain];
const BODY = "![[2025-12-08 09.58.38.excalidraw]]";

beforeEach(() => {
  resetDrawingCache();
  loadInkAttributes = vi.spyOn(reads.notes, "attributeValues").mockImplementation(fakeAttributeValues);
  stored.clear();
  stored.set("d1", { ink_data: encodeInk(ink) });
});

describe("embed resolution", () => {
  it("resolves an Excalidraw name to the imported drawing: by title without .excalidraw, or by its alias", () => {
    const byAlias = resolveEmbed("2025-12-08 09.58.38.excalidraw", null, nodes);
    expect(byAlias).toMatchObject({ kind: "drawing", node: { id: "d1" }, label: "2025-12-08 09.58.38" });
    const noAlias = { ...drawing, attrs: {} } as ContentNode;
    expect(resolveEmbed("2025-12-08 09.58.38.excalidraw", null, [noAlias])).toMatchObject({ kind: "drawing", node: { id: "d1" } });
    expect(resolveEmbed("2025-12-08 09.58.38", null, nodes)).toMatchObject({ kind: "note", node: { id: "d1" } });
    expect(resolveEmbed("Plain note#^b1", null, nodes)).toMatchObject({ kind: "block", blockId: "b1" });
    expect(resolveEmbed("Nothing.excalidraw", null, nodes).kind).toBe("missing");
  });

  it("caches the picture per drawing version and redraws when the drawing changed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const first = await drawingSvg("d1");
      expect(first).toContain("<svg");
      expect(await drawingSvg("d1")).toBe(first);
      expect(loadInkAttributes).toHaveBeenCalledTimes(1); // one read for mounts close together
      vi.setSystemTime(Date.now() + 5000);
      stored.set("d1", { ink_data: encodeInk({ ...ink, strokes: [...ink.strokes, { ...ink.strokes[0]!, id: "t", points: [[200, 200], [260, 240]] }] }) });
      const second = await drawingSvg("d1");
      expect(second).not.toBe(first);
      stored.set("n1", { ink_data: null });
      expect(await drawingSvg("n1")).toBeNull();
    } finally { vi.useRealTimers(); }
  });
});

describe("preview", () => {
  it("draws the drawing with a 「開啟手寫頁」 link that opens it", async () => {
    expect(zhTW["Open drawing"]).toBe("開啟手寫頁");
    const onNavigate = vi.fn();
    const { container, findByText } = render(
      <MarkdownRenderer nodes={nodes} onNavigate={onNavigate}>{`intro\n\n${BODY}\n`}</MarkdownRenderer>,
    );
    await waitFor(() => expect(container.querySelector(".md-drawing-picture svg")).not.toBeNull());
    expect(container.textContent).not.toContain("![[");
    fireEvent.click(await findByText("Open drawing"));
    expect(onNavigate).toHaveBeenCalledWith("2025-12-08-0958-38", "d1", undefined);
  });

  it("an embed of an ordinary (empty) note is its source line, linking to it; one naming nothing stays as written", async () => {
    stored.set("n1", {});
    const { container } = render(
      <MarkdownRenderer nodes={nodes} onNavigate={() => {}}>{"![[Plain note]]\n\n![[Missing]]"}</MarkdownRenderer>,
    );
    await waitFor(() => expect(container.querySelector(".md-embed-source")?.textContent).toBe("— Plain note"));
    expect(container.textContent).toContain("![[Missing]]");
    expect(container.querySelector(".md-drawing")).toBeNull();
  });

  it("the published profile leaves embeds to the server", () => {
    const { container } = render(<MarkdownRenderer nodes={nodes} profile="published" onNavigate={() => {}}>{BODY}</MarkdownRenderer>);
    expect(container.querySelector(".md-embed-block")).toBeNull();
  });
});

describe("editor", () => {
  const views: EditorView[] = [];
  afterEach(() => { views.splice(0).forEach((v) => { v.dom.parentElement?.remove(); v.destroy(); }); });
  const DOC = `# Title\n\n${BODY}\n\nafter ![[2025-12-08 09.58.38.excalidraw]] inline\n\n\`\`\`\n${BODY}\n\`\`\``;
  const context = () => ({ nodes, from: null, onOpen: vi.fn() });
  function open(cursor: number) {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ parent, state: EditorState.create({ doc: DOC, selection: { anchor: cursor }, extensions: [editorEmbeds(context)] }) });
    views.push(view);
    return view;
  }

  it("shows the drawing in place of a whole-line embed while the cursor is elsewhere", async () => {
    const view = open(0);
    await waitFor(() => expect(view.dom.querySelector(".cm-embed .md-drawing-picture svg")).not.toBeNull());
    expect(view.dom.querySelectorAll(".cm-embed")).toHaveLength(1); // not inline, not in code
    expect(view.contentDOM.textContent).not.toContain(`\n${BODY}`);
    expect(view.dom.querySelector(".md-drawing-open")?.textContent).toBe("Open drawing");
  });

  it("shows the raw text again when the cursor enters the line", () => {
    const view = open(0);
    const line = view.state.doc.line(3);
    expect(line.text).toBe(BODY);
    act(() => { view.dispatch({ selection: { anchor: line.from + 4 }, effects: embedEditorFocus.of(true) }); });
    expect(view.dom.querySelector(".cm-embed")).toBeNull();
    expect(view.contentDOM.textContent).toContain(BODY);
    expect(embedLineRanges(view.state, context)).toEqual([]);
    act(() => { view.dispatch({ selection: { anchor: 0 } }); });
    expect(embedLineRanges(view.state, context).map((r) => r.body)).toEqual(["2025-12-08 09.58.38.excalidraw"]);
  });
  it("a note that is only the embed shows the drawing until the editor is focused on that line", async () => {
    const only = new EditorView({ parent: document.body.appendChild(document.createElement("div")),
      state: EditorState.create({ doc: BODY, selection: { anchor: 0 }, extensions: [editorEmbeds(context)] }) });
    views.push(only);
    // The default caret sits on the only line; unfocused, it is not editing it.
    await waitFor(() => expect(only.dom.querySelector(".cm-embed .md-drawing-picture svg")).not.toBeNull());
    act(() => { only.dispatch({ effects: embedEditorFocus.of(true) }); });
    expect(only.dom.querySelector(".cm-embed")).toBeNull();
    expect(only.contentDOM.textContent).toContain(BODY);
    act(() => { only.dispatch({ effects: embedEditorFocus.of(false) }); });
    expect(embedLineRanges(only.state, context).map((r) => r.body)).toEqual(["2025-12-08 09.58.38.excalidraw"]);
  });
});
