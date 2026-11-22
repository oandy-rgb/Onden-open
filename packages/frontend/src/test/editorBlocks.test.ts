import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { BLOCK_PARSE_MAX } from "@onden/markdown";
import { blockAt, blockScanField, blockTaskWords, editorBlocks, scanBlocks } from "../lib/editorBlocks";

// The block-node display in the editor: chips for {…}, the range line and the too-long notice. A paragraph's identity is
// an anchor, not text: nothing in the text is hidden, and a `^word` shows as typed.

const views: EditorView[] = [];
function open(doc: string, cursor = 0, taskTag: string | null = null) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ parent, state: EditorState.create({ doc, selection: { anchor: cursor }, extensions: [editorBlocks, blockTaskWords.of(taskTag ? [taskTag] : [])] }) });
  views.push(view);
  return view;
}
afterEach(() => { views.splice(0).forEach((v) => { v.dom.parentElement?.remove(); v.destroy(); }); vi.useRealTimers(); });

const NOTE = "## 搜尋 {考點}\n\n- 二分搜尋 {重要, 易錯}\n\nplain line";

describe("editor block nodes", () => {
  it("shows {…} as chips when the cursor is elsewhere", () => {
    const view = open(NOTE, NOTE.length);
    const chips = [...view.dom.querySelectorAll(".cm-block-tag")].map((c) => c.textContent);
    expect(chips).toEqual(["考點", "重要", "易錯"]);
    expect(view.contentDOM.textContent).not.toContain("{考點}");
  });

  it("shows the {…} text on the cursor's line", () => {
    const view = open(NOTE, 3);
    const first = view.contentDOM.querySelector(".cm-line")!;
    expect(first.textContent).toContain("{考點}");
    expect(first.querySelector(".cm-block-tags-raw")?.textContent).toBe("{考點}");
  });

  it("hides nothing else: a `^word` at the end of a line, in code or in a URL shows as typed", () => {
    const doc = "@ai 幫我整理成三點 ^mvm9lz8m-fhl6\n\n用 `x ^a1` 與 https://e.com/a^b 說明\n\n```\ncode ^zz9\n```\n\n尾 ^ok1";
    for (const cursor of [0, doc.length]) {
      const view = open(doc, cursor);
      const text = view.contentDOM.textContent!;
      for (const shown of ["^mvm9lz8m-fhl6", "`x ^a1`", "a^b", "code ^zz9", "^ok1"]) expect(text).toContain(shown);
      expect(view.state.doc.toString()).toBe(doc);
    }
  });

  it("a Backspace next to the end of a line deletes what it is next to", () => {
    const doc = "普通 ^p1\n\n尾端";
    const view = open(doc, doc.indexOf("\n"));
    view.dispatch(view.state.update({ changes: { from: doc.indexOf("\n") - 1, to: doc.indexOf("\n") }, userEvent: "delete.backward" }));
    expect(view.state.doc.toString()).toBe("普通 ^p\n\n尾端");
  });

  it("marks the lines of the block the cursor is in", () => {
    const at = NOTE.indexOf("二分");
    const view = open(NOTE, at);
    const marked = [...view.contentDOM.querySelectorAll(".cm-block-range")].map((l) => l.textContent);
    // The list item is the innermost block holding the cursor, not the heading.
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("二分搜尋");
  });

  it("deleting a whole line deletes it", () => {
    const view = open(NOTE, 0);
    const line = view.state.doc.line(1);
    view.dispatch(view.state.update({ changes: { from: line.from, to: line.to + 1 }, userEvent: "delete.selection" }));
    expect(view.state.doc.toString()).toBe(NOTE.slice(line.to + 1));
  });

  it("re-reads the blocks after a pause in typing", () => {
    vi.useFakeTimers();
    const view = open("text", 4);
    view.dispatch({ changes: { from: 4, insert: " {新標籤}" }, userEvent: "input.type" });
    expect(view.state.field(blockScanField).blocks).toHaveLength(0);
    vi.advanceTimersByTime(300);
    expect(view.state.field(blockScanField).blocks.map((b) => b.tags)).toEqual([["新標籤"]]);
  });

  it("flags a note too long to read only when it uses block tags", () => {
    const long = "x".repeat(BLOCK_PARSE_MAX + 1);
    expect(scanBlocks(long).tooLong).toBe(false);
    expect(scanBlocks(`${long}\n\nend {標籤}`).tooLong).toBe(true);
    const view = open(`${long}\n\nend {標籤}`);
    expect(view.dom.querySelector(".cm-block-too-long")?.textContent).toContain("too long");
  });

  it("blockAt picks the innermost block", () => {
    const { blocks } = scanBlocks(NOTE);
    expect(blockAt(blocks, NOTE.indexOf("二分"))?.tags).toEqual(["重要", "易錯"]);
    expect(blockAt(blocks, 2)?.tags).toEqual(["考點"]);
  });

  describe("the tasks module's tag", () => {
    const TASKS = "- [ ] 搞信用卡 {task}\n- [x] 買口罩 {task}";
    const tagEnd = TASKS.indexOf("{task}") + 6;
    const icons = (v: EditorView) => v.dom.querySelectorAll(".cm-block-task-icon");

    it("is an icon, not a text chip, away from the braces", () => {
      const view = open(TASKS, TASKS.length, "task");
      expect(icons(view)).toHaveLength(1);
      expect(view.dom.querySelector(".cm-block-tag")).toBeNull();
      expect(icons(view)[0].getAttribute("aria-label")).toBeTruthy();
    });

    it("stays an icon with the caret on the line but not touching the braces", () => {
      const view = open(TASKS, 8, "task");
      expect(icons(view)).toHaveLength(2);
      expect(view.contentDOM.textContent).not.toContain("{task}");
    });

    it("shows the raw text when the caret is in or touching the braces", () => {
      for (const at of [tagEnd, tagEnd - 3, TASKS.indexOf("{task}")]) {
        const view = open(TASKS, at, "task");
        expect(view.dom.querySelector(".cm-block-tags-raw")?.textContent).toBe("{task}");
        expect(icons(view)).toHaveLength(1);
      }
    });

    it("keeps other tags as chips next to the icon", () => {
      const doc = "- [ ] 讀書 {task, 書籍}\n\n尾";
      const view = open(doc, doc.length, "task");
      expect(icons(view)).toHaveLength(1);
      expect([...view.dom.querySelectorAll(".cm-block-tag")].map((c) => c.textContent)).toEqual(["書籍"]);
    });

    it("Backspace after the brace selects the tag; the second press deletes it", () => {
      const view = open(TASKS, tagEnd, "task");
      view.dispatch(view.state.update({ changes: { from: tagEnd - 1, to: tagEnd }, userEvent: "delete.backward" }));
      expect(view.state.doc.toString()).toBe(TASKS);
      const sel = view.state.selection.main;
      expect([sel.from, sel.to]).toEqual([TASKS.indexOf("{task}"), tagEnd]);
      view.dispatch(view.state.update({ changes: { from: sel.from, to: sel.to }, userEvent: "delete.selection" }));
      expect(view.state.doc.line(1).text).toBe("- [ ] 搞信用卡 ");
    });

    it("typing inside the braces is untouched", () => {
      const view = open(TASKS, tagEnd - 1, "task");
      view.dispatch(view.state.update({ changes: { from: tagEnd - 2, to: tagEnd - 1 }, userEvent: "delete.backward" }));
      expect(view.state.doc.toString()).toContain("{tas}");
    });
  });
});
