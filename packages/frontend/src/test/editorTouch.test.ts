import { afterEach, describe, expect, it } from "vitest";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorTouch, placeCaretForTap } from "../lib/editorTouch";
import { TAP_MAX_MS, TAP_SLOP_PX } from "../lib/ink";

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

  it("a single tap on text is placed by the editor too, in ONE selection change", () => {
    const { v, changes } = setup();
    const e = press(v.contentDOM.querySelectorAll(".cm-line")[1]!, 150);
    expect(placeCaretForTap(v, e, 10)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    expect(changes).toHaveLength(1);
    expect(v.state.doc.lineAt(v.state.selection.main.head).number).toBe(2);
  });

  it("a double tap and a tap on a link or control stay native", () => {
    const { v, changes } = setup();
    const line = v.contentDOM.querySelector(".cm-line")!;
    const double = new MouseEvent("mousedown", { cancelable: true, clientY: 124, button: 0, detail: 2 });
    Object.defineProperty(double, "target", { value: line });
    expect(placeCaretForTap(v, double, 10)).toBe(false);
    const link = line.appendChild(document.createElement("a"));
    expect(placeCaretForTap(v, press(link, 124), 10)).toBe(false);
    const widget = line.appendChild(document.createElement("span"));
    widget.setAttribute("contenteditable", "false");
    expect(placeCaretForTap(v, press(widget, 124), 10)).toBe(false);
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

// The blank below the editor box: the tap is a press and release in a container around the editor, under the last line (ends at y 197).
describe("a tap in the blank below the editor", () => {
  function column() {
    const { v, changes } = setup();
    const container = document.createElement("section");
    v.dom.parentElement!.replaceWith(container);
    container.appendChild(v.dom);
    v.dom.getBoundingClientRect = () => ({ left: 0, right: 300, top: 100, bottom: 240, width: 300, height: 140, x: 0, y: 100, toJSON() {} }) as DOMRect;
    return { v, changes, container };
  }
  // Pointer events on the window the way a browser orders them: down, optional moves, up, then the click.
  function gesture(target: Element, at: { x: number; y: number }, opts: { moveTo?: { x: number; y: number }; heldMs?: number; cancel?: boolean } = {}) {
    const fire = (type: string, p: { x: number; y: number }, timeStamp: number) => {
      const e = new MouseEvent(type, { bubbles: true, clientX: p.x, clientY: p.y, button: 0 });
      Object.defineProperties(e, { pointerId: { value: 1 }, isPrimary: { value: true }, timeStamp: { value: timeStamp } });
      target.dispatchEvent(e);
    };
    fire("pointerdown", at, 1000);
    if (opts.moveTo) fire("pointermove", opts.moveTo, 1050);
    if (opts.cancel) { target.dispatchEvent(new Event("pointercancel", { bubbles: true })); return; }
    fire("pointerup", opts.moveTo ?? at, 1000 + (opts.heldMs ?? 80));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }
  const END = LINES.join("\n").length;
  /** Whether a clean tap at (x, y) on `target` ends with the caret at the end of the note (it starts at 0). */
  const claims = (v: EditorView, target: Element, x: number, y: number) => {
    v.dispatch({ selection: { anchor: 0 } });
    gesture(target, { x, y });
    return v.state.selection.main.head === END;
  };

  it("puts the caret at the end of the note and focuses the editor (a container around the editor)", () => {
    const { v, changes, container } = column();
    gesture(container, { x: 50, y: 300 });
    expect(v.state.selection.main.head).toBe(END);
    expect(v.hasFocus).toBe(true);
    expect(changes).toEqual([END]);
  });

  it("the editor box itself counts, under the last line", () => {
    const { v, container } = column();
    expect(claims(v, v.dom, 50, 230)).toBe(true);
    expect(claims(v, container, 50, 230)).toBe(true);
  });

  it("not on or above the last line, not beside the editor", () => {
    const { v, container } = column();
    expect(claims(v, container, 50, 190)).toBe(false);
    expect(claims(v, container, 50, 100)).toBe(false);
    expect(claims(v, container, 400, 300)).toBe(false);
  });

  it("not on something else in the page: a sibling block, a link, a control, an editor that is not this one", () => {
    const { v, container } = column();
    const sibling = container.appendChild(document.createElement("div"));
    expect(claims(v, sibling, 50, 300)).toBe(false);
    const wrapper = container.appendChild(document.createElement("div"));
    const link = wrapper.appendChild(document.createElement("a"));
    expect(claims(v, link, 50, 300)).toBe(false);
    const other = container.appendChild(document.createElement("div"));
    other.className = "cm-editor";
    other.getBoundingClientRect = () => ({ left: 0, right: 300, top: 260, bottom: 400, width: 300, height: 140, x: 0, y: 260, toJSON() {} }) as DOMRect;
    expect(claims(v, container, 50, 300)).toBe(false);
    // ...but one in another pane (outside this editor's width) does not take the blank away.
    other.getBoundingClientRect = () => ({ left: 400, right: 700, top: 260, bottom: 400, width: 300, height: 140, x: 400, y: 260, toJSON() {} }) as DOMRect;
    sibling.remove(); link.remove();
    expect(claims(v, container, 50, 300)).toBe(true);
  });

  it("a finger that scrolls (moves, or is cancelled by the browser) is not a tap", () => {
    const { v, changes, container } = column();
    gesture(container, { x: 50, y: 300 }, { moveTo: { x: 50, y: 300 - TAP_SLOP_PX - 5 } });
    gesture(container, { x: 50, y: 300 }, { cancel: true });
    expect(changes).toEqual([]);
    expect(v.hasFocus).toBe(false);
  });

  it("a small wobble within the slop is still a tap; a long press is not", () => {
    const { v, changes, container } = column();
    gesture(container, { x: 50, y: 300 }, { heldMs: TAP_MAX_MS + 100 });
    expect(changes).toEqual([]);
    gesture(container, { x: 50, y: 300 }, { moveTo: { x: 53, y: 301 } });
    expect(v.state.selection.main.head).toBe(END);
  });

  it("an IME composition is left alone", () => {
    const { v, changes, container } = column();
    Object.defineProperty(v, "composing", { value: true });
    gesture(container, { x: 50, y: 300 });
    expect(changes).toEqual([]);
  });

  it("a read-only editor is left alone", () => {
    const { v, container } = column();
    v.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
    expect(claims(v, container, 50, 300)).toBe(false);
  });
});
