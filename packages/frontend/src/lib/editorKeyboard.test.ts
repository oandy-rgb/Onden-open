import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  bar.getBoundingClientRect = () => ({ top: 716, height: 52 }) as DOMRect; // the window is 768 px high
  return { view, viewRef: { current: view }, barRef: { current: bar } };
}
const bottomMargin = (view: EditorView) => Math.max(0, ...view.state.facet(EditorView.scrollMargins).map((f) => f(view)?.bottom ?? 0));

beforeEach(() => { Object.defineProperty(document.documentElement, "clientHeight", { value: 768, configurable: true }); });
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
    // (the bar covers the page's foot by its own height here: window 768, bar from 716)
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

  // The wait is frames of nothing changing (what scrolls the editor, the keyboard's size), not milliseconds: a frame is 16 ms here.
  const frames = (n: number) => act(() => { vi.advanceTimersByTime(16 * n); });

  it("asks for one 'nearest' scroll once the keyboard has been still for a few frames, again only after its SIZE changes (never for a pan)", () => {
    vi.useFakeTimers();
    const vv = installViewport(800);
    const { view, viewRef, barRef } = mount();
    view.focus();
    const scroll = vi.spyOn(EditorView, "scrollIntoView");
    renderHook(() => useEditorKeyboard({ viewRef, barRef, barUp: true, writing: true, onKeyboardClosed: () => {} }));
    vv.move({ height: 500 });
    frames(3);
    expect(scroll).not.toHaveBeenCalled(); // still rising
    frames(5);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.calls[0]![1]).toEqual({ y: "nearest" });
    vv.move({ offsetTop: 30 });
    frames(30);
    expect(scroll).toHaveBeenCalledTimes(1); // a pan moves the viewport, not the keyboard
    vv.move({ height: 480 });
    frames(30);
    expect(scroll).toHaveBeenCalledTimes(2); // a keyboard that grew: one more, once it is still
  });

  it("a keyboard that rises in steps is waited for: every size change restarts the wait, one scroll when it has been still", () => {
    vi.useFakeTimers();
    const vv = installViewport(800);
    const { view, viewRef, barRef } = mount();
    view.focus();
    const scroll = vi.spyOn(EditorView, "scrollIntoView");
    renderHook(() => useEditorKeyboard({ viewRef, barRef, barUp: true, writing: true, onKeyboardClosed: () => {} }));
    for (const height of [650, 530, 450]) { vv.move({ height }); frames(4); } // steps closer than the wait
    expect(scroll).not.toHaveBeenCalled();
    frames(4);
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  const room = (view: EditorView) => view.dom.querySelector<HTMLElement>(".cm-end-room");

  it("without resizes-content (iOS) the room under the last line is put in ONCE when the keyboard has settled, never at the start of writing or while typing", async () => {
    vi.useFakeTimers();
    const vv = installViewport(800);
    const { view, viewRef, barRef } = mount();
    renderHook(() => useEditorKeyboard({ viewRef, barRef, barUp: true, writing: true, onKeyboardClosed: () => {} }));
    frames(3);
    expect(room(view)).toBeNull(); // writing started: no room yet
    vv.move({ height: 500 });
    frames(3);
    expect(room(view)).toBeNull(); // the keyboard is still rising
    frames(25);
    await Promise.resolve(); // the room is dispatched from a microtask after its measure
    await Promise.resolve();
    const height = room(view)?.style.height;
    expect(height).toBeTruthy();
    for (let typed = 0; typed < 10; typed++) { view.dispatch({ changes: { from: view.state.doc.length, insert: "\nx" } }); frames(10); await Promise.resolve(); expect(room(view)?.style.height).toBe(height); }
    expect(bottomMargin(view)).toBeLessThanOrEqual(baseRoomPx(500)); // the room's size is not the caret's margin
  });

  it("where the browser shrinks the layout for the keyboard (Android: the inset stays 0) there is no room under the last line at any time", () => {
    vi.useFakeTimers();
    const vv = installViewport(800);
    const { view, viewRef, barRef } = mount();
    renderHook(() => useEditorKeyboard({ viewRef, barRef, barUp: true, writing: true, onKeyboardClosed: () => {} }));
    for (const height of [800, 650, 500, 450]) {
      Object.defineProperty(window, "innerHeight", { value: height, configurable: true }); // the window shrinks with the keyboard
      vv.move({ height }); frames(30); expect(room(view), `${height}`).toBeNull();
    }
    for (let typed = 0; typed < 10; typed++) { view.dispatch({ changes: { from: view.state.doc.length, insert: "\nx" } }); frames(10); expect(room(view)).toBeNull(); }
  });

  it("a keyboard that closed while nobody was writing does not end the next writing session before its keyboard is up", () => {
    vi.useFakeTimers();
    const vv = installViewport(800);
    const { viewRef, barRef } = mount();
    const closed = vi.fn();
    const { rerender } = renderHook((p) => useEditorKeyboard({ viewRef, barRef, barUp: true, onKeyboardClosed: closed, ...p }), { initialProps: { writing: true } });
    vv.move({ height: 450 }); // up under the first session
    rerender({ writing: false }); // it ends (blur); the keyboard goes away with it
    vv.move({ height: 800 });
    act(() => { vi.advanceTimersByTime(1000); });
    closed.mockClear();
    rerender({ writing: true }); // a tap: the keyboard is still on its way up
    act(() => { vi.advanceTimersByTime(1000); });
    expect(closed).not.toHaveBeenCalled();
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
    frames(25);
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
