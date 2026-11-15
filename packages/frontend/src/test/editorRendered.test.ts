import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { cursorCharLeft, cursorCharRight, deleteCharBackward, deleteCharForward } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { editorCheckboxes, checkboxRanges } from "../lib/editorCheckboxes";
import { calloutLines, editorCallouts } from "../lib/editorCallouts";
import { cellOffset, editorTables, tableRanges } from "../lib/editorTables";
import { editorEmbeds, embedEditorFocus } from "../lib/editorEmbeds";
import { editorRendered } from "../lib/editorRendered";
import { taskToggleEdit } from "../lib/taskCheckbox";

// The three things the editor draws over Markdown that stays as written:
// checkboxes (always the box), tables (text only on a deliberate press), callouts (styled lines).

const context = () => ({ nodes: [], from: null });
let views: EditorView[] = [];
afterEach(() => { views.forEach((v) => v.destroy()); views = []; document.body.innerHTML = ""; });

function viewOf(doc: string, caret = 0): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc, selection: { anchor: caret },
      extensions: [markdown({ base: markdownLanguage }), editorRendered(editorEmbeds(context), context)],
    }),
  });
  ensureSyntaxTree(view.state, doc.length, 5000);
  view.dispatch({}); // draw with the parsed tree
  views.push(view);
  return view;
}
const stateOf = (doc: string) => { const s = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] }); ensureSyntaxTree(s, doc.length, 5000); return s; };
const compose = (view: EditorView, on: boolean) => view.contentDOM.dispatchEvent(new Event(on ? "compositionstart" : "compositionend"));

describe("checkboxes", () => {
  it("draws the three characters of every box that has text after it, any list marker, indented or quoted", () => {
    const doc = "- [ ] a\n* [x] b\n+ [X] c\n1. [ ] d\n  - [ ] e\n> - [ ] f\n- [ ]\n- [ ] \n```\n- [ ] code\n```";
    const ranges = checkboxRanges({ state: stateOf(doc) }, 0, doc.length);
    expect(ranges.map((r) => [doc.slice(r.from, r.to), r.checked])).toEqual([
      ["[ ]", false], ["[x]", true], ["[X]", true], ["[ ]", false], ["[ ]", false], ["[ ]", false],
    ]);
  });

  it("draws a box even on the caret's line, and keeps the text and the line length", () => {
    const view = viewOf("- [ ] buy milk", 8);
    const boxes = view.dom.querySelectorAll(".cm-task-box");
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.getAttribute("aria-checked")).toBe("false");
    expect(view.state.doc.toString()).toBe("- [ ] buy milk");
  });

  it("a press flips the box with a one-character edit that undo takes back", () => {
    const view = viewOf("- [ ] buy milk");
    (view.dom.querySelector(".cm-task-box") as HTMLElement).click();
    expect(view.state.doc.toString()).toBe("- [x] buy milk");
    expect(view.dom.querySelector(".cm-task-box")!.getAttribute("aria-checked")).toBe("true");
    (view.dom.querySelector(".cm-task-box") as HTMLElement).click();
    expect(view.state.doc.toString()).toBe("- [ ] buy milk");
  });

  it("a task line (… {task}) flips the same character as any box", () => {
    expect(taskToggleEdit("- [ ] buy milk {task}", 0)).toEqual({ from: 3, to: 4, insert: "x" });
    expect(taskToggleEdit("- [x] buy milk {task}", 0)).toEqual({ from: 3, to: 4, insert: " " });
    expect(taskToggleEdit("plain", 0)).toBeNull();
  });

  it("does nothing where the note is read-only", () => {
    const view = viewOf("- [ ] a");
    view.dispatch({ effects: [] });
    const ro = new EditorView({ parent: document.body, state: EditorState.create({ doc: "- [ ] a", extensions: [markdown({ base: markdownLanguage }), editorCheckboxes, EditorState.readOnly.of(true)] }) });
    views.push(ro);
    ensureSyntaxTree(ro.state, 7, 5000); ro.dispatch({});
    (ro.dom.querySelector(".cm-task-box") as HTMLElement).click();
    expect(ro.state.doc.toString()).toBe("- [ ] a");
  });

  it("the arrow keys step over the box as one unit, and Backspace / Delete remove its three characters", () => {
    const view = viewOf("- [ ] a", 5);
    cursorCharLeft(view);
    expect(view.state.selection.main.head).toBe(2); // from just after the box to just before it
    cursorCharRight(view);
    expect(view.state.selection.main.head).toBe(5);
    deleteCharBackward(view);
    expect(view.state.doc.toString()).toBe("-  a");
    const second = viewOf("- [ ] a", 2);
    deleteCharForward(second);
    expect(second.state.doc.toString()).toBe("-  a");
  });

  it("while an IME is composing no box is added or removed; they catch up when it ends", () => {
    const view = viewOf("x\n- [ ] a");
    compose(view, true);
    view.dispatch({ changes: { from: 0, insert: "- [ ] new\n" } }); // composed into a new box
    expect(view.dom.querySelectorAll(".cm-task-box")).toHaveLength(1);
    view.dispatch({ changes: { from: view.state.doc.length - 1, to: view.state.doc.length, insert: "b" } }); // the composed text goes in beside a box
    expect(view.dom.querySelectorAll(".cm-task-box")).toHaveLength(1);
    compose(view, false);
    expect(view.dom.querySelectorAll(".cm-task-box")).toHaveLength(2);
  });
});

describe("callouts", () => {
  it("styles every line of the quote, by type, without changing the text", () => {
    const doc = "> [!tip]- Title\n> body\n> more\n\nafter";
    const lines = calloutLines(stateOf(doc), 0, doc.length);
    expect(lines.map((l) => [doc.slice(l.from, l.to), l.type, l.first, l.last])).toEqual([
      ["> [!tip]- Title", "tip", true, false], ["> body", "tip", false, false], ["> more", "tip", false, true],
    ]);
  });

  it("aliases draw as their type, unknown names as note, a plain quote not at all", () => {
    const doc = "> [!hint] a\n\n> [!whatever] b\n\n> [!warning]+ c\n\n> just a quote";
    expect(calloutLines(stateOf(doc), 0, doc.length).map((l) => l.type)).toEqual(["tip", "note", "warning"]);
  });

  it("puts the type class on the line, and the same lines with the caret in or out", () => {
    const doc = "> [!danger] Careful\n> body";
    for (const caret of [0, 22]) {
      const view = viewOf(doc, caret);
      expect([...view.dom.querySelectorAll(".cm-line")].map((l) => l.className.includes("callout-danger"))).toEqual([true, true]);
      expect(view.state.doc.toString()).toBe(doc);
    }
  });

  it("holds the styling back while composing", () => {
    const view = viewOf("a");
    compose(view, true);
    view.dispatch({ changes: { from: 1, insert: "\n\n> [!note] x" } });
    expect(view.dom.querySelector(".cm-callout")).toBeNull();
    compose(view, false);
    expect(view.dom.querySelector(".cm-callout")).not.toBeNull();
  });
});

describe("tables", () => {
  const TABLE = "| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |";
  const doc = `before\n\n${TABLE}\n\nafter`;

  it("finds only top-level tables", () => {
    const d = `${TABLE}\n\n- item\n\n  | x | y |\n  | - | - |\n  | 1 | 2 |`;
    expect(tableRanges(stateOf(d)).map((r) => d.slice(r.from, r.to))).toEqual([TABLE]);
  });

  it("maps a pressed cell to its place in the text", () => {
    expect(cellOffset("| a | b |", 0)).toBe(2);
    expect(cellOffset("| a | b |", 1)).toBe(6);
    expect(cellOffset("a | b", 1)).toBe(4);
    expect(cellOffset("| a \\| x | b |", 1)).toBe(11);
    expect(cellOffset("|  | b |", 0)).toBe(3);
  });

  it("draws a table the caret is not in; moving the caret over it, or onto its edges, does not open it", () => {
    const view = viewOf(doc, 0);
    expect(view.dom.querySelector(".cm-table")).not.toBeNull();
    for (const pos of [1, 6, 8, doc.indexOf("\n\nafter"), doc.length]) {
      view.dispatch({ selection: { anchor: pos } });
      expect(view.dom.querySelector(".cm-table")).not.toBeNull();
    }
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("a press on the table opens its text with the caret in the pressed cell; leaving draws it again", () => {
    const view = viewOf(doc, 0);
    // jsdom has no preview renderer loaded yet: stand in a row of cells
    const host = view.dom.querySelector(".cm-table-body") as HTMLElement;
    host.innerHTML = "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td id='hit'>4</td></tr></tbody></table>";
    (host.querySelector("#hit") as HTMLElement).click();
    expect(view.dom.querySelector(".cm-table")).toBeNull();
    expect(view.state.selection.main.head).toBe(doc.indexOf("| 3 | 4 |") + 6);
    view.dispatch({ selection: { anchor: doc.length } }); // down to "after"
    expect(view.dom.querySelector(".cm-table")).not.toBeNull();
  });

  it("a selection strictly inside the table's text (find, undo) opens it; an edit from elsewhere does not", () => {
    const view = viewOf(doc, 0);
    view.dispatch({ changes: { from: doc.indexOf("2"), to: doc.indexOf("2") + 1, insert: "22" } });
    expect(view.dom.querySelector(".cm-table")).not.toBeNull();
    view.dispatch({ selection: { anchor: doc.indexOf("2") + 1 }, effects: embedEditorFocus.of(true) });
    expect(view.dom.querySelector(".cm-table")).toBeNull();
  });

  it("a press opens the table where it is now, also after text was typed above it", () => {
    const view = viewOf(doc, 0);
    view.dispatch({ changes: { from: 6, insert: "字字字" } }); // above the table: the widget is reused, only moved
    const host = view.dom.querySelector(".cm-table-body") as HTMLElement;
    host.innerHTML = "<table><thead><tr><th>a</th></tr></thead><tbody><tr><td id='hit'>1</td></tr></tbody></table>";
    (host.querySelector("#hit") as HTMLElement).click();
    expect(view.dom.querySelector(".cm-table")).toBeNull();
    const text = view.state.doc.toString();
    expect(view.state.selection.main.head).toBe(text.indexOf("| 1 | 2 |") + 2);
  });

  it("typing a new table: once its rule row is written the caret at its end shows the text, so later rows are not hidden", () => {
    const head = "intro\n\n| a | b |";
    const view = viewOf(head, 0);
    view.dispatch({ selection: { anchor: head.length }, effects: embedEditorFocus.of(true) });
    const rule = "\n| - | - |";
    view.dispatch({ changes: { from: head.length, insert: rule }, selection: { anchor: head.length + rule.length }, userEvent: "input.type" });
    expect(view.dom.querySelector(".cm-table")).toBeNull();
    const row = "\n| 1 | 你";
    const at = head.length + rule.length;
    view.dispatch({ changes: { from: at, insert: row }, selection: { anchor: at + row.length }, userEvent: "input.type" });
    expect(view.dom.querySelector(".cm-table")).toBeNull();
    expect(view.state.doc.toString().endsWith("| 1 | 你")).toBe(true);
  });

  it("Backspace right after a drawn table shows its text first; it does not delete the whole table", () => {
    const view = viewOf(`${TABLE}\n\nafter`, 0);
    const end = TABLE.length;
    view.dispatch({ selection: { anchor: end } });
    expect(view.dom.querySelector(".cm-table")).not.toBeNull();
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    expect(view.state.doc.toString()).toBe(`${TABLE}\n\nafter`);
    expect(view.dom.querySelector(".cm-table")).toBeNull();
    expect(view.state.selection.main.head).toBe(end);
  });

  it("nothing opens, closes or redraws while composing", () => {
    const view = viewOf(doc, 0);
    compose(view, true);
    view.dispatch({ changes: { from: 0, insert: "你" } });
    view.dispatch({ selection: { anchor: doc.indexOf("| 3") + 3 } });
    expect(view.dom.querySelector(".cm-table")).not.toBeNull();
    compose(view, false);
  });

  it("a table can be composed into place only once the composition ends", () => {
    const view = viewOf("x");
    compose(view, true);
    view.dispatch({ changes: { from: 1, insert: `\n\n${TABLE}\n\n` } });
    expect(view.dom.querySelector(".cm-table")).toBeNull();
    compose(view, false);
    expect(view.dom.querySelector(".cm-table")).not.toBeNull();
  });
});

describe("the group", () => {
  it("is one list", () => {
    expect(editorRendered([], context)).toHaveLength(5);
    void editorTables;
    void editorCallouts;
  });
});
