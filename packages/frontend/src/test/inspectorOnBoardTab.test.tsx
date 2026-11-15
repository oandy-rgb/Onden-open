// On a note's whiteboard tab and in 並排 the info column folds by itself (the card's own info is one tap away),
// and the content tab comes back exactly as the person had it: the stored choice is never touched.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetAppState } from "../lib/appStore";
import { useWorkspacePanes } from "../hooks/useWorkspacePanes";
import { PREFS } from "../lib/prefs";

const stored = () => localStorage.getItem(PREFS.inspectorOpen.key);
function setup(initialStored: "1" | "0") {
  localStorage.setItem(PREFS.inspectorOpen.key, initialStored);
  return renderHook(({ boardTab }: { boardTab: boolean }) => useWorkspacePanes("notes", { boardTab }), { initialProps: { boardTab: false } });
}
beforeEach(() => { localStorage.clear(); resetAppState({}); });
afterEach(cleanup);

describe("the info column on the whiteboard tab", () => {
  it("folds when the whiteboard tab opens and returns to the person's own state on the content tab", () => {
    const hook = setup("1");
    expect(hook.result.current.inspectorOpen).toBe(true);
    hook.rerender({ boardTab: true });
    expect(hook.result.current.inspectorOpen).toBe(false);
    expect(hook.result.current.inspectorVisible).toBe(false);
    hook.rerender({ boardTab: false });
    expect(hook.result.current.inspectorOpen).toBe(true);
    expect(stored()).toBe("1");
  });

  it("a column the person had closed stays closed when they come back", () => {
    const hook = setup("0");
    hook.rerender({ boardTab: true });
    hook.rerender({ boardTab: false });
    expect(hook.result.current.inspectorOpen).toBe(false);
    expect(stored()).toBe("0");
  });

  it("opening it on the whiteboard tab is that tab's own choice: it shows there, is forgotten when the tab is left, and is not stored", () => {
    const hook = setup("0");
    hook.rerender({ boardTab: true });
    act(() => hook.result.current.toggleInspector());
    expect(hook.result.current.inspectorVisible).toBe(true);
    expect(stored()).toBe("0");
    act(() => hook.result.current.toggleInspector());
    expect(hook.result.current.inspectorVisible).toBe(false);
    act(() => hook.result.current.showInspector());
    expect(hook.result.current.inspectorOpen).toBe(true);
    hook.rerender({ boardTab: false });
    hook.rerender({ boardTab: true });
    expect(hook.result.current.inspectorOpen).toBe(false);
  });

  it("closing it on the content tab is still stored as before", () => {
    const hook = setup("1");
    act(() => hook.result.current.toggleInspector());
    expect(hook.result.current.inspectorOpen).toBe(false);
    expect(stored()).toBe("0");
  });
});

describe("the info column in 並排 (the note's text also open on the right)", () => {
  it("folds so the editor and the rendered page share the width, and comes back as it was", () => {
    localStorage.setItem(PREFS.inspectorOpen.key, "1");
    const hook = renderHook(({ sideBySide }: { sideBySide: boolean }) => useWorkspacePanes("notes", { sideBySide }), { initialProps: { sideBySide: false } });
    expect(hook.result.current.inspectorVisible).toBe(true);
    hook.rerender({ sideBySide: true });
    expect(hook.result.current.inspectorVisible).toBe(false);
    act(() => hook.result.current.toggleInspector());
    expect(hook.result.current.inspectorVisible).toBe(true);
    expect(stored()).toBe("1");
    hook.rerender({ sideBySide: false });
    expect(hook.result.current.inspectorVisible).toBe(true);
    expect(stored()).toBe("1");
  });
});
