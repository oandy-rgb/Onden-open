import { afterEach, describe, expect, it, vi } from "vitest";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { collapseEndRoom, endRoom } from "./editorEndRoom";

const views: EditorView[] = [];
function mount(doc: string) {
  const room = new Compartment();
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions: [room.of([])] }) });
  views.push(view);
  return { view, setRoom: (px: number, edge: () => number) => view.dispatch({ effects: room.reconfigure(endRoom(px, edge)) }) };
}
afterEach(() => { views.splice(0).forEach((v) => { v.destroy(); v.dom.parentElement?.remove(); }); });

const FAR = () => 10_000; // the last line is nowhere near the bottom of the screen
const NEAR = () => 0; // the last line is at (past) the bottom of the screen
/** Runs the pending measure and the dispatch it queues. */
const settle = async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); await Promise.resolve(); };
const room = (view: EditorView) => view.dom.querySelector<HTMLElement>(".cm-end-room");

describe("room under the last line", () => {
  it("is not there while the last line is far from the bottom, and a note that is only focused does not move", async () => {
    const { view, setRoom } = mount("one\ntwo");
    setRoom(160, FAR);
    await settle();
    expect(room(view)).toBeNull();
    view.dispatch({ selection: { anchor: 7 } });
    await settle();
    expect(room(view)).toBeNull();
  });

  it("appears, one empty block of the asked size at the end, when the last line is near the bottom", async () => {
    const { view, setRoom } = mount("one\ntwo");
    setRoom(160, NEAR);
    await settle();
    expect(room(view)?.style.height).toBe("160px");
    expect(room(view)?.textContent).toBe("");
    expect(view.state.doc.toString()).toBe("one\ntwo");
  });

  it("appears when typing brings the last line near the bottom, and stays while writing", async () => {
    let edge = 10_000;
    const { view, setRoom } = mount("one");
    setRoom(160, () => edge);
    await settle();
    expect(room(view)).toBeNull();
    edge = 0;
    view.dispatch({ changes: { from: 3, insert: "\ntwo" } });
    await settle();
    expect(room(view)).not.toBeNull();
    edge = 10_000; // the line rose off the edge: the room is not taken back mid-writing
    view.dispatch({ changes: { from: 7, insert: "x" } });
    await settle();
    expect(room(view)).not.toBeNull();
  });

  it("stays at the end of a note that grows", async () => {
    const { view, setRoom } = mount("one");
    setRoom(100, NEAR);
    await settle();
    view.dispatch({ changes: { from: 3, insert: "\ntwo\nthree" } });
    const lines = view.contentDOM.children;
    expect(lines[lines.length - 1]?.className).toContain("cm-end-room");
  });

  it("is gone when the extension is removed", async () => {
    const { view, setRoom } = mount("one");
    setRoom(100, NEAR);
    await settle();
    setRoom(0, NEAR);
    expect(room(view)).toBeNull();
  });

  it("keeps the room while a pointer is down and lets go of it after the release", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { view, setRoom } = mount("one");
      setRoom(100, NEAR);
      await settle();
      window.dispatchEvent(new Event("pointerdown"));
      let removed = false;
      collapseEndRoom(view, () => { removed = true; setRoom(0, NEAR); });
      expect(removed).toBe(false);
      expect(room(view)).not.toBeNull();
      window.dispatchEvent(new Event("pointerup"));
      expect(removed).toBe(false); // the click of this press comes first
      vi.runAllTimers();
      expect(removed).toBe(true);
      expect(room(view)).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("collapses at once when no pointer is down", async () => {
    const { view, setRoom } = mount("one");
    setRoom(100, NEAR);
    await settle();
    collapseEndRoom(view, () => setRoom(0, NEAR));
    expect(room(view)).toBeNull();
  });
});
