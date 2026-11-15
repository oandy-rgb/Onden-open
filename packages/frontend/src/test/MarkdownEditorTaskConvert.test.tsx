import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import MarkdownEditor from "../components/MarkdownEditor";

// Checkbox → task (Mod-Shift-Enter) knows a checkbox the way the renderer
// does (lib/taskLines.ts): any list marker, inside a quote, never inside a
// code block. The box it ticks afterwards is the one on the line it started
// on, not the first line with the same text.

const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

const viewOf = (container: HTMLElement) => EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;

function setup(value: string) {
  const onCreateTask = vi.fn(async (_title: string) => true);
  const editLeftNote = vi.fn();
  const editor = (nodeKey: string, text: string) => (
    <MarkdownEditor nodeKey={nodeKey} value={text} onChange={vi.fn()} nodes={[]}
      onMediaInsert={vi.fn(async () => null)} onCreateTask={onCreateTask} editLeftNote={editLeftNote} />
  );
  const utils = render(editor("note-a", value));
  const view = viewOf(utils.container);
  /** Put the caret at the end of 1-based line `n` and press Mod-Shift-Enter. */
  const convertLine = (n: number) => {
    act(() => { view.dispatch({ selection: { anchor: view.state.doc.line(n).to } }); });
    fireEvent.keyDown(view.contentDOM, { key: "Enter", ctrlKey: true, shiftKey: true });
  };
  const switchTo = (nodeKey: string, text: string) => utils.rerender(editor(nodeKey, text));
  return { view, onCreateTask, editLeftNote, convertLine, switchTo };
}

describe("checkbox → task in the editor", { timeout: 30_000 }, () => {
  it.each([
    ["+ [ ] call Sam", "+ [x] call Sam"],
    ["1. [ ] call Sam", "1. [x] call Sam"],
    ["2) [ ] call Sam", "2) [x] call Sam"],
    ["> - [ ] call Sam", "> - [x] call Sam"],
  ])("converts %s", async (line, ticked) => {
    const s = setup(line);
    s.convertLine(1);
    await act(async () => {});
    expect(s.onCreateTask).toHaveBeenCalledWith("call Sam");
    expect(s.view.state.doc.toString()).toBe(ticked);
  });

  it("does not offer a checkbox inside a code fence", async () => {
    const s = setup("```\n- [ ] not a task\n```");
    s.convertLine(2);
    await act(async () => {});
    expect(s.onCreateTask).not.toHaveBeenCalled();
    expect(s.view.state.doc.toString()).toBe("```\n- [ ] not a task\n```");
  });

  it("ticks the line it started on when another line has the same text", async () => {
    const body = "- [ ] buy milk\n- [ ] buy milk";
    const s = setup(body);
    s.convertLine(2);
    await act(async () => {});
    expect(s.view.state.doc.toString()).toBe("- [ ] buy milk\n- [x] buy milk");
  });

  it("ticks the line it started on in a note the editor left", async () => {
    let mint!: (ok: boolean) => void;
    const body = "- [ ] buy milk\n- [ ] buy milk";
    const s = setup(body);
    s.onCreateTask.mockImplementation(() => new Promise<boolean>((r) => { mint = r; }));
    s.convertLine(2);
    s.switchTo("note-b", "other");
    await act(async () => { mint(true); });
    expect(s.editLeftNote).toHaveBeenCalledTimes(1);
    const [nodeKey, edit] = s.editLeftNote.mock.calls[0]!;
    expect(nodeKey).toBe("note-a");
    expect(edit(body)).toBe("- [ ] buy milk\n- [x] buy milk");
  });
});

describe("checkbox → task line (B4)", { timeout: 30_000 }, () => {
  it("writes {task} on the line instead of minting a separate task; the box stays open", async () => {
    const onCreateTask = vi.fn(async (_title: string) => true);
    const utils = render(<MarkdownEditor nodeKey="note-b" value={"- [ ] call Sam\n- [ ] other"} onChange={vi.fn()} nodes={[]}
      onMediaInsert={vi.fn(async () => null)} onCreateTask={onCreateTask} taskTagName="任務" />);
    const view = viewOf(utils.container);
    act(() => { view.dispatch({ selection: { anchor: view.state.doc.line(1).to } }); });
    fireEvent.keyDown(view.contentDOM, { key: "Enter", ctrlKey: true, shiftKey: true });
    await act(async () => {});
    expect(onCreateTask).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("- [ ] call Sam {任務}\n- [ ] other");
  });
});
