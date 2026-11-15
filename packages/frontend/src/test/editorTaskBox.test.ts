import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo, undoDepth } from "@codemirror/commands";
import { blockTaskTagName, editorBlocks } from "../lib/editorBlocks";
import { insertBlockTag, insertBlockTags } from "../lib/editorParagraphActions";
import { writeBlockTagName } from "../lib/editorCompletion";

// Applying the task tag gives the line its checkbox in the same edit (one undo), by every route:
// paragraph menu / phone bar, the `{` picker, a typed closing `}`. The tag is known by the name the
// editor was told (the reserved tag, whatever it is titled), not by the word `task`.

const views: EditorView[] = [];
function open(doc: string, caret = 0, taskTag: string | null = "任務") {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, selection: { anchor: caret }, extensions: [history(), editorBlocks, blockTaskTagName.of(taskTag)] }),
  });
  views.push(view);
  return { view, text: () => view.state.doc.toString() };
}
afterEach(() => { views.splice(0).forEach((v) => { v.dom.parentElement?.remove(); v.destroy(); }); });

describe("the task tag adds the checkbox", () => {
  it("menu / phone bar: a paragraph, a bullet and a numbered item", () => {
    const e = open("給你可以\n\n- 買牛奶\n\n1. 交報告", 0);
    insertBlockTag(e.view, 0, "任務");
    insertBlockTag(e.view, e.text().indexOf("買牛奶"), "任務");
    insertBlockTag(e.view, e.text().indexOf("交報告"), "任務");
    expect(e.text()).toBe("- [ ] 給你可以 {任務}\n\n- [ ] 買牛奶 {任務}\n\n1. [ ] 交報告 {任務}");
  });

  it("is one undo step with the tag, and a selection tags and boxes every line", () => {
    const e = open("甲\n\n乙", 0);
    insertBlockTag(e.view, 0, "任務");
    expect(undoDepth(e.view.state)).toBe(1);
    undo(e.view);
    expect(e.text()).toBe("甲\n\n乙");
    insertBlockTags(e.view, 0, e.text().length, "任務");
    expect(e.text()).toBe("- [ ] 甲 {任務}\n\n- [ ] 乙 {任務}");
  });

  it("leaves headings alone and other tags never add a box", () => {
    const e = open("# 標題\n\n段落", 0);
    insertBlockTag(e.view, 0, "任務");
    insertBlockTag(e.view, e.text().indexOf("段落"), "idea");
    expect(e.text()).toBe("# 標題 {任務}\n\n段落 {idea}");
  });

  it("does nothing when the editor knows no task tag", () => {
    const e = open("段落", 0, null);
    insertBlockTag(e.view, 0, "任務");
    expect(e.text()).toBe("段落 {任務}");
  });

  it("the picker: {ta → task}", () => {
    const e = open("買牛奶 {ta", 7);
    writeBlockTagName(e.view, 5, "任務");
    expect(e.text()).toBe("- [ ] 買牛奶 {任務}");
  });

  it("typed: the box appears when the closing } is typed, and removing the tag keeps it", () => {
    const e = open("買牛奶 {任務", 7);
    e.view.dispatch({ changes: { from: 7, insert: "}" }, selection: { anchor: 8 }, userEvent: "input.type" });
    expect(e.text()).toBe("- [ ] 買牛奶 {任務}");
    e.view.dispatch({ changes: { from: e.text().indexOf(" {任務}"), to: e.text().length, insert: "" }, userEvent: "delete.backward" });
    expect(e.text()).toBe("- [ ] 買牛奶");
  });

  it("typed with an IME: nothing changes until the composition ends", () => {
    const e = open("買牛奶 {任務", 7);
    e.view.contentDOM.dispatchEvent(new Event("compositionstart"));
    e.view.dispatch({ changes: { from: 7, insert: "}" }, selection: { anchor: 8 }, userEvent: "input.type.compose" });
    expect(e.text()).toBe("買牛奶 {任務}");
    e.view.contentDOM.dispatchEvent(new Event("compositionend"));
    expect(e.text()).toBe("- [ ] 買牛奶 {任務}");
  });

  it("a pasted or loaded line that already has {任務} is not touched", () => {
    const e = open("", 0);
    e.view.dispatch({ changes: { from: 0, insert: "買牛奶 {任務}" }, userEvent: "input.paste" });
    expect(e.text()).toBe("買牛奶 {任務}");
  });
});
