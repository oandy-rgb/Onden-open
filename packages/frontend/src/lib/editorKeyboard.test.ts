import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEditorKeyboard } from "../hooks/useEditorKeyboard";
import { baseRoomPx, editorKeyboard } from "./editorKeyboard";

// A fake visualViewport that pans and shrinks like a phone's does while the keyboard is up.
function installViewport(height: number) {
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
  const listeners = new Set<() => void>();
  const vv = { height, offsetTop: 0, addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) };
  Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
  return { move(next: { height?: number; offsetTop?: number }) { Object.assign(vv, next); act(() => listeners.forEach((fn) => fn())); } };
}

const views: EditorView[] = [];
function mount(doc = "one\ntwo") {
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions: [editorKeyboard()] }) });
  views.push(view);
  const bar = document.createElement("div");
  bar.getBoundingClientRect = () => ({ height: 52 }) as DOMRect;
  return { view, viewRef: { current: view }, barRef: { current: bar } };
}
const bottomMargin = (view: EditorView) => Math.max(0, ...view.state.facet(EditorView.scrollMargins).map((f) => f(view)?.bottom ?? 0));

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(window, "innerHeight", { value: 768, configurable: true });
  vi.restoreAllMocks();
  Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });
  views.splice(0).forEach((v) => { v.destroy(); v.dom.parentElement?.remove(); });
});

describe("editor keyboard owner", () => {
  it("keeps the caret clear of the bar: the bottom margin is the bar's height plus a gap, and none without the bar", () => {
    const { view, viewRef, barRef } = mount();
    const { rerender } = renderHook((p) => useEditorKeyboard({ ...p, viewRef, barRef, onKeyboardClosed: () => {} }), { initialProps: { barUp: false, writing: false } });
    expect(bottomMargin(view)).toBe(0);
    rerender({ barUp: true, writing: false });
    expect(bottomMargin(view)).toBe(52 + 8);
    rerender({ barUp: false, writing: false });
    expect(bottomMargin(view)).toBe(0);
  });

  it("never scrolls because the visual viewport panned or the keyboard inset changed", () => {
    vi.useFakeTimers();
    const vv = installViewport(800);
    const { view, viewRef, barRef } = mount();
    const scroll = vi.spyOn(EditorView, "scrollIntoView");
    const dispatch = vi.spyOn(view, "dispatch");
    renderHook(() => useEditorKeyboard({ viewRef, barRef, barUp: true, writing: true, onKeyboardClosed: () => {} }));
    scroll.mockClear();
    dispatch.mockClear();
    // The keyboard rises and the browser pans while a hand scroll goes on (the real phone's offsetTop bounced 208…232).
    vv.move({ height: 500 });
    for (const top of [222, 214, 232, 212, 227, 210, 224, 208]) vv.move({ offsetTop: top });
    expect(scroll).not.toHaveBeenCalled();
    expect(dispatch.mock.calls.some(([spec]) => (spec as { scrollIntoView?: boolean })?.scrollIntoView)).toBe(false);
  });

  it("asks for one 'nearest' scroll once the keyboard has finished opening, and none for later inset changes", () => {
    vi.useFakeTimers();
    const vv = installViewport(800);
    const { view, viewRef, barRef } = mount();
    view.focus();
    const scroll = vi.spyOn(EditorView, "scrollIntoView");
    renderHook(() => useEditorKeyboard({ viewRef, barRef, barUp: true, writing: true, onKeyboardClosed: () => {} }));
    vv.move({ height: 500 });
    act(() => { vi.advanceTimersByTime(100); });
    expect(scroll).not.toHaveBeenCalled(); // still rising
    act(() => { vi.advanceTimersByTime(200); });
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.calls[0]![1]).toEqual({ y: "nearest" });
    vv.move({ offsetTop: 30 });
    vv.move({ height: 480 });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("decides the room under the last line once when writing starts, and does not follow the inset", () => {
    vi.useFakeTimers();
    const vv = installViewport(800);
    const { view, viewRef, barRef } = mount();
    renderHook(() => useEditorKeyboard({ viewRef, barRef, barUp: true, writing: true, onKeyboardClosed: () => {} }));
    const started = bottomMargin(view);
    expect(started).toBe(baseRoomPx(800));
    // The browser only shrinks the visual viewport here (no resizes-content): the room covers keyboard + bar, once.
    vv.move({ height: 500 });
    act(() => { vi.advanceTimersByTime(400); });
    const grown = bottomMargin(view);
    expect(grown).toBe(Math.max(started, 300 + 52 + 8));
    for (const inset of [310, 280, 330, 300]) { vv.move({ height: 800 - inset }); act(() => { vi.advanceTimersByTime(400); }); }
    expect(bottomMargin(view)).toBe(grown);
  });

  it("places the bar by the inset only, and reports a keyboard that stayed closed", () => {
    vi.useFakeTimers();
    const vv = installViewport(800);
    const { viewRef, barRef } = mount();
    const closed = vi.fn();
    const { result } = renderHook(() => useEditorKeyboard({ viewRef, barRef, barUp: true, writing: true, onKeyboardClosed: closed }));
    expect(result.current.barInset).toBe("0px");
    vv.move({ height: 500 });
    expect(result.current.barInset).toBe("300px");
    vv.move({ height: 800 });
    act(() => { vi.advanceTimersByTime(400); });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("with a layout the browser already shrank (resizes-content) the inset is 0 and the bar stays at bottom 0", () => {
    vi.useFakeTimers();
    const vv = installViewport(800);
    const { viewRef, barRef } = mount();
    const { result } = renderHook(() => useEditorKeyboard({ viewRef, barRef, barUp: true, writing: true, onKeyboardClosed: () => {} }));
    Object.defineProperty(window, "innerHeight", { value: 500, configurable: true });
    vv.move({ height: 500 });
    expect(result.current.barInset).toBe("0px");
  });
});
