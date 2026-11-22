import "./helpers/offlineNetwork";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import OverviewEditor from "../components/OverviewEditor";
import type { ContentNode } from "../lib/api";
import { getAppState, setData } from "../lib/appStore";

// A local copy from before the server sent the task-line words, opened offline: Ctrl/⌘+Shift+Enter on a
// checkbox must not create a second task node that is not on the line; the line becomes a task once the words arrive.

vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), apiFetch: vi.fn(async () => new Response("[]", { status: 200 })) }));

const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

const note: ContentNode = { id: "note-a", title: "A", slug: "a", markdown: "- [ ] call Sam", node_type: "content", source_type: "manual" };

function open(onCreateTask: (t: string) => Promise<boolean>) {
  const utils = render(
    <OverviewEditor node={note} titleDraft={note.title} onTitleChange={() => {}} draft={note.markdown ?? ""} onDraftChange={() => {}}
      view="edit" setView={() => {}} saveStatus="saved" onSave={() => {}} online={false} nodes={[note]}
      onOpenWikilink={() => {}} onCreateFirst={() => {}} onSelectNode={() => {}} onCreateTask={onCreateTask} />,
  );
  const view = EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  act(() => { view.dispatch({ selection: { anchor: view.state.doc.line(1).to } }); });
  fireEvent.keyDown(view.contentDOM, { key: "Enter", ctrlKey: true, shiftKey: true });
  return view;
}

afterEach(() => {
  cleanup();
  act(() => { setData((d) => ({ ...d, workspace: d.workspace && { ...d.workspace, line_words: undefined } })); });
});

describe("Ctrl/⌘+Shift+Enter before the line words are known", () => {
  it("does not create a task node that is not on the line", async () => {
    expect(getAppState().data.workspace?.line_words).toBeUndefined();
    const onCreateTask = vi.fn(async () => true);
    const view = open(onCreateTask);
    await act(async () => {});
    expect(onCreateTask).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("- [ ] call Sam");
  });
});
