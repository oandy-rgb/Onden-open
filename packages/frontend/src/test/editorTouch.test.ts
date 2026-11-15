import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorTouch, placeCaretForTap } from "../lib/editorTouch";

// Caret placement for a tap that is not on text. jsdom has no layout, so the geometry the owner asks CodeMirror
// for (documentTop, lineBlockAt, posAtCoords) is stood in for: three lines at y 124 / 153 / 182, the last ending at 211.

const LINES = ["one", "two", "three"];
const TOPS = [110, 139, 168]; // each line is 29px tall

let view: EditorView | null = null;
afterEach(() => { view?.destroy(); view = null; document.body.innerHTML = ""; });

function setup() {
  const changes: number[] = [];
  const parent = document.body.appendChild(document.createElement("div"));
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc: LINES.join("\n"),
      extensions: [editorTouch(), EditorView.updateListener.of((u) => { if (u.selectionSet) changes.push(u.state.selection.main.head); })],
    }),
  });
  const v = view;
  const lineAt = (pos: number) => v.state.doc.lineAt(pos).number - 1;
  Object.defineProperty(v, "documentTop", { value: 0 });
  v.lineBlockAt = ((pos: number) => ({ top: TOPS[lineAt(pos)]!, bottom: TOPS[lineAt(pos)]! + 29 })) as never;
  v.posAtCoords = ((p: { x: number; y: number }) => {
    const i = Math.max(0, TOPS.findIndex((t) => p.y < t + 29));
    return v.state.doc.line(i + 1).from + Math.min(Math.max(0, Math.round(p.x / 10)), LINES[i]!.length);
  }) as never;
  return { v, changes };
}

function tap(target: Element, y: number, x = 40, pointerType = "touch") {
  const up = new MouseEvent("pointerup", { bubbles: true });
  Object.defineProperty(up, "pointerType", { value: pointerType });
  target.dispatchEvent(up);
  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  target.dispatchEvent(down);
  return down;
}

describe("a tap that is not on text", () => {
  it("below the last line puts the caret at the end of the last line in ONE selection change, native default prevented", () => {
    const { v, changes } = setup();
    const down = tap(v.contentDOM, 330);
    expect(down.defaultPrevented).toBe(true);
    expect(changes).toEqual([v.state.doc.length]);
    expect(v.state.selection.main.head).toBe(v.state.doc.length);
  });

  it("the end-room element counts like the content padding", () => {
    const { v, changes } = setup();
    const room = v.contentDOM.appendChild(document.createElement("div"));
    room.className = "cm-end-room";
    tap(room, 340);
    expect(changes).toEqual([v.state.doc.length]);
  });

  it("beside a line it picks the nearest line by CodeMirror's own mapping, above the first line the start", () => {
    const { v, changes } = setup();
    tap(v.contentDOM, 150, 20);
    expect(v.state.doc.lineAt(v.state.selection.main.head).number).toBe(2);
    tap(v.contentDOM, 5);
    expect(v.state.selection.main.head).toBe(0);
    expect(changes).toHaveLength(2);
  });

  const press = (target: Element, y = 330) =>
    Object.defineProperty(new MouseEvent("mousedown", { cancelable: true, clientY: y, button: 0 }), "target", { value: target }) as MouseEvent;

  it("a tap on text keeps the native path", () => {
    const { v, changes } = setup();
    const e = press(v.contentDOM.querySelector(".cm-line")!, 124);
    expect(placeCaretForTap(v, e, 10)).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    expect(changes).toEqual([]);
  });

  it("a mousedown with no finger tap just before it (a mouse, a stale touch) is CodeMirror's own business", () => {
    const { v, changes } = setup();
    const e = press(v.contentDOM);
    expect(placeCaretForTap(v, e, 5000)).toBe(false);
    expect(placeCaretForTap(v, e, Infinity)).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    expect(changes).toEqual([]);
  });

  it("does nothing while an IME composes", () => {
    const { v, changes } = setup();
    Object.defineProperty(v, "composing", { value: true });
    const e = press(v.contentDOM);
    expect(placeCaretForTap(v, e, 10)).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    expect(changes).toEqual([]);
  });
});
