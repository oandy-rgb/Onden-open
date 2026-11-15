// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { searchPanelOpen } from "@codemirror/search";
import {
  editorFind, findStatusText, firstMatchFor, openFind, revealFirstMatch, tallyMatches,
} from "../lib/editorFind";
import { lastFindQuery, setPendingFind, takePendingFind } from "../lib/findInNote";

// jsdom has no layout; CodeMirror's measure pass needs these on Range.
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

const views: EditorView[] = [];
function mount(doc: string): EditorView {
  const view = new EditorView({ state: EditorState.create({ doc, extensions: [editorFind] }), parent: document.body });
  views.push(view);
  return view;
}
afterEach(() => { views.splice(0).forEach((v) => v.destroy()); vi.useRealTimers(); document.body.innerHTML = ""; });

const type = (input: HTMLInputElement, value: string) => { input.value = value; input.dispatchEvent(new Event("input")); };
const key = (el: Element, k: string, shiftKey = false) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true }));
const panelParts = (view: EditorView) => ({
  input: view.dom.querySelector<HTMLInputElement>(".note-find-input")!,
  status: view.dom.querySelector(".note-find-status")!,
});

describe("命中計數", () => {
  it("大小寫不敏感，中文與英文都能找", () => {
    const state = EditorState.create({ doc: "Onden 筆記\nonden ONDEN\n再一則筆記" });
    expect(tallyMatches(state, "onden").total).toBe(3);
    expect(tallyMatches(state, "筆記").total).toBe(2);
    expect(tallyMatches(state, "找不到").total).toBe(0);
    expect(tallyMatches(state, "").total).toBe(0);
  });
  it("白話狀態文字", () => {
    expect(findStatusText({ total: 12, current: 3, capped: false }, true)).toBe("Match 3 of 12");
    expect(findStatusText({ total: 12, current: 0, capped: false }, true)).toBe("12 matches");
    expect(findStatusText({ total: 0, current: 0, capped: false }, true)).toBe("No results");
    expect(findStatusText({ total: 0, current: 0, capped: false }, false)).toBe("");
  });
});

describe("找字面板", () => {
  it("輸入即顯示筆數，Enter／Shift+Enter 上下移動，Esc 關閉並留在命中", () => {
    const view = mount("alpha beta\nBeta gamma\nbeta");
    openFind(view);
    expect(searchPanelOpen(view.state)).toBe(true);
    const { input, status } = panelParts(view);
    type(input, "beta");
    expect(status.textContent).toBe("Match 1 of 3");
    key(input, "Enter");
    expect(status.textContent).toBe("Match 2 of 3");
    key(input, "Enter");
    key(input, "Enter");
    expect(status.textContent).toBe("Match 1 of 3");
    key(input, "Enter", true);
    expect(status.textContent).toBe("Match 3 of 3");
    key(input, "Escape");
    expect(searchPanelOpen(view.state)).toBe(false);
    const { from, to } = view.state.selection.main;
    expect(view.state.sliceDoc(from, to).toLowerCase()).toBe("beta");
    expect(from).toBe(view.state.doc.length - 4);
  });

  it("找不到時說明並停用上下一筆", () => {
    const view = mount("hello");
    openFind(view);
    type(panelParts(view).input, "zzz");
    expect(panelParts(view).status.textContent).toBe("No results");
    expect(view.dom.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')!.disabled).toBe(true);
  });

  it("再開時預先填入上一次搜尋的字", () => {
    const view = mount("one two one");
    openFind(view);
    type(panelParts(view).input, "one");
    key(panelParts(view).input, "Escape");
    openFind(view);
    expect(panelParts(view).input.value).toBe("one");
    expect(lastFindQuery()).toBe("one");
  });
});

describe("從搜尋結果開啟", () => {
  it("等待中的搜尋字只被取用一次", () => {
    setPendingFind("n1", " 專案 ");
    expect(takePendingFind("n1")).toBe("專案");
    expect(takePendingFind("n1")).toBeNull();
  });

  it("捲到第一個命中並短暫標示，之後消失", () => {
    vi.useFakeTimers();
    const scroll = vi.spyOn(EditorView, "scrollIntoView");
    const view = mount("前言\n\n很長的內容\n\n專案進度在這裡，專案第二次");
    expect(revealFirstMatch(view, "專案")).toBe(true);
    expect(scroll).toHaveBeenCalledWith(view.state.doc.toString().indexOf("專案"), { y: "center" });
    expect(view.dom.querySelectorAll(".cm-findFlash").length).toBe(1);
    expect(view.dom.querySelector(".cm-findFlash")!.textContent).toBe("專案");
    vi.advanceTimersByTime(2000);
    expect(view.dom.querySelector(".cm-findFlash")).toBeNull();
    scroll.mockRestore();
  });

  it("整句找不到時退回最長的單詞；都沒有就不動", () => {
    const state = EditorState.create({ doc: "會議紀錄與預算" });
    expect(firstMatchFor(state, "預算 會議紀錄")).toEqual({ from: 0, to: 4 });
    expect(firstMatchFor(state, "完全不存在")).toBeNull();
    const view = mount("abc");
    expect(revealFirstMatch(view, "zzz")).toBe(false);
  });
});
