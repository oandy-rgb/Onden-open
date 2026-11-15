import { afterEach, describe, it, expect, vi } from "vitest";
import { renderHook, act, cleanup, fireEvent } from "@testing-library/react";
import { useCanvasUndo } from "../hooks/useCanvasUndo";

const card = (nodeId: string, x: number, y: number) => [{ nodeId, x, y }];
function setup(canvasId: string | null = "c1") {
  const save = vi.fn();
  const hook = renderHook(
    ({ id }: { id: string | null }) => useCanvasUndo({ canvasId: id, onRestorePositions: save }),
    { initialProps: { id: canvasId } },
  );
  return { hook, save };
}
afterEach(cleanup);

describe("canvas gesture undo", () => {
  it("owns copied positions for every card and group, and retains the complete inverse when refused", async () => {
    const { hook, save } = setup();
    const nodes = [...card("a", 10, 20), ...card("b", 30, 40)];
    const sections = [{ id: "s1", x: 1, y: 2 }, { id: "s2", x: 3, y: 4 }];
    act(() => hook.result.current.recordPositions(nodes, sections));
    nodes[0].x = 999; sections[0].x = 999;
    save.mockRejectedValueOnce(new Error("denied"));
    await act(async () => { await expect(hook.result.current.undo()).rejects.toThrow("denied"); });
    expect(hook.result.current.canUndo).toBe(true);
    await act(async () => { await hook.result.current.undo(); });
    expect(save).toHaveBeenLastCalledWith([...card("a", 10, 20), ...card("b", 30, 40)], [{ id: "s1", x: 1, y: 2 }, { id: "s2", x: 3, y: 4 }]);
    expect(hook.result.current.canUndo).toBe(false);
  });

  it("restores consecutive group moves and their original members in reverse order", async () => {
    const { hook, save } = setup();
    act(() => {
      hook.result.current.recordPositions(card("a", 20, 30), [{ id: "s", x: 0, y: 0 }]);
      hook.result.current.recordPositions(card("a", 120, 30), [{ id: "s", x: 100, y: 0 }]);
    });
    await act(async () => { await hook.result.current.undo(); });
    expect(save).toHaveBeenLastCalledWith(card("a", 120, 30), [{ id: "s", x: 100, y: 0 }]);
    await act(async () => { await hook.result.current.undo(); });
    expect(save).toHaveBeenLastCalledWith(card("a", 20, 30), [{ id: "s", x: 0, y: 0 }]);
    expect(hook.result.current.canUndo).toBe(false);
  });

  it("waits, prevents duplicate submission and retains a refused inverse for retry", async () => {
    const { hook, save } = setup(); let reject!: (error: Error) => void;
    save.mockImplementationOnce(() => new Promise((_, no) => { reject = no; }));
    act(() => hook.result.current.recordPositions([], [{ id: "s", x: 1, y: 2 }]));
    let pending!: Promise<boolean>;
    act(() => { pending = hook.result.current.undo(); });
    expect(hook.result.current.canUndo).toBe(false);
    expect(await hook.result.current.undo()).toBe(false);
    await act(async () => { reject(new Error("denied")); await expect(pending).rejects.toThrow("denied"); });
    expect(hook.result.current.canUndo).toBe(true);
    await act(async () => { expect(await hook.result.current.undo()).toBe(true); });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("a late accepted inverse keeps a newer gesture", async () => {
    const { hook, save } = setup(); let finish!: () => void;
    save.mockImplementationOnce(() => new Promise<void>(yes => { finish = yes; }));
    act(() => hook.result.current.recordPositions(card("a", 1, 2)));
    let pending!: Promise<boolean>; act(() => { pending = hook.result.current.undo(); });
    act(() => hook.result.current.recordPositions(card("b", 3, 4)));
    await act(async () => { finish(); await pending; });
    await act(async () => { await hook.result.current.undo(); });
    expect(save).toHaveBeenLastCalledWith(card("b", 3, 4), []);
  });

  it("an old completion cannot clear another canvas's history", async () => {
    const { hook, save } = setup(); let finish!: () => void;
    save.mockImplementationOnce(() => new Promise<void>(yes => { finish = yes; }));
    act(() => hook.result.current.recordPositions(card("a", 1, 2)));
    let pending!: Promise<boolean>; act(() => { pending = hook.result.current.undo(); });
    hook.rerender({ id: "c2" });
    act(() => hook.result.current.recordPositions(card("b", 3, 4)));
    await act(async () => { finish(); await pending; });
    expect(hook.result.current.canUndo).toBe(true);
    await act(async () => { await hook.result.current.undo(); });
    expect(save).toHaveBeenLastCalledWith(card("b", 3, 4), []);
  });

  it("restores a single card through the same save path, then reports an empty stack", async () => {
    const { hook, save } = setup();
    act(() => hook.result.current.recordPositions(card("n1", 10, 20)));
    await act(async () => { expect(await hook.result.current.undo()).toBe(true); });
    expect(save).toHaveBeenCalledExactlyOnceWith(card("n1", 10, 20), []);
    expect(await hook.result.current.undo()).toBe(false);
  });

  it("can restore an empty group without inventing card positions", async () => {
    const { hook, save } = setup();
    act(() => hook.result.current.recordPositions([], [{ id: "s", x: 5, y: 6 }]));
    await act(async () => { await hook.result.current.undo(); });
    expect(save).toHaveBeenCalledExactlyOnceWith([], [{ id: "s", x: 5, y: 6 }]);
  });

  it("switching canvases clears the history", async () => {
    const { hook } = setup();
    act(() => hook.result.current.recordPositions(card("n1", 10, 20)));
    hook.rerender({ id: "c2" });
    expect(await hook.result.current.undo()).toBe(false);
  });

  it("does not record an empty position set", () => {
    const { hook } = setup();
    act(() => hook.result.current.recordPositions([], []));
    expect(hook.result.current.canUndo).toBe(false);
  });

  it("keeps only the most recent fifty gestures", async () => {
    const { hook, save } = setup();
    act(() => { for (let i = 0; i < 51; i++) hook.result.current.recordPositions(card("a", i, 0)); });
    await act(async () => { while (await hook.result.current.undo()) { /* drain */ } });
    expect(save).toHaveBeenCalledTimes(50);
    expect(save).toHaveBeenLastCalledWith(card("a", 1, 0), []);
  });

  it("Ctrl+Z undoes the card move in pen mode too: one key, one history", async () => {
    const { hook, save } = setup();
    act(() => hook.result.current.recordPositions(card("n1", 10, 20)));
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true })); });
    expect(save).toHaveBeenCalledWith(card("n1", 10, 20), []);
  });

  it("leaves Ctrl+Z inside a text surface to that editor", async () => {
    const { hook, save } = setup();
    act(() => hook.result.current.recordPositions(card("n1", 10, 20)));
    const input = document.createElement("input"); document.body.appendChild(input); input.focus();
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true })));
    expect(save).not.toHaveBeenCalled();
    input.remove();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true })); });
    expect(save).toHaveBeenCalledWith(card("n1", 10, 20), []);
  });
});

describe("undo keeps later moves (GAP-180)", () => {
  type Layout = { nodes: Array<{ nodeId: string; x: number; y: number }> };
  function withLayout(initial: Layout) {
    const save = vi.fn();
    const onSkipped = vi.fn();
    const hook = renderHook(
      ({ layout }: { layout: Layout }) => useCanvasUndo({ canvasId: "c1", layout, onRestorePositions: save, onSkipped }),
      { initialProps: { layout: initial } },
    );
    return { hook, save, onSkipped };
  }

  it("leaves a card that another device moved after the gesture", async () => {
    const { hook, save, onSkipped } = withLayout({ nodes: [{ nodeId: "a", x: 0, y: 0 }, { nodeId: "b", x: 0, y: 0 }] });
    act(() => hook.result.current.recordPositions([...card("a", 0, 0), ...card("b", 0, 0)], [], {
      nodes: [...card("a", 100, 0), ...card("b", 100, 0)], sections: [],
    }));
    // Local move landed for a; b was then moved elsewhere remotely.
    hook.rerender({ layout: { nodes: [{ nodeId: "a", x: 100, y: 0 }, { nodeId: "b", x: 1500, y: 1500 }] } });
    await act(async () => { await hook.result.current.undo(); });
    expect(save).toHaveBeenLastCalledWith(card("a", 0, 0), []);
    expect(onSkipped).toHaveBeenCalledWith(1);
  });

  it("drops the gesture without writing when everything moved since", async () => {
    const { hook, save, onSkipped } = withLayout({ nodes: [{ nodeId: "a", x: 0, y: 0 }] });
    act(() => hook.result.current.recordPositions(card("a", 0, 0), [], { nodes: card("a", 100, 0), sections: [] }));
    hook.rerender({ layout: { nodes: [{ nodeId: "a", x: 1500, y: 1500 }] } });
    await act(async () => { expect(await hook.result.current.undo()).toBe(false); });
    expect(save).not.toHaveBeenCalled();
    expect(onSkipped).toHaveBeenCalledWith(1);
    expect(hook.result.current.canUndo).toBe(false);
  });

  it("learns where an arrangement put things from the next layout", async () => {
    const { hook, save, onSkipped } = withLayout({ nodes: [{ nodeId: "a", x: 0, y: 0 }] });
    act(() => hook.result.current.recordPositions(card("a", 0, 0)));
    hook.rerender({ layout: { nodes: [{ nodeId: "a", x: 40, y: 40 }] } });
    hook.rerender({ layout: { nodes: [{ nodeId: "a", x: 40, y: 40 }] } });
    await act(async () => { await hook.result.current.undo(); });
    expect(save).toHaveBeenLastCalledWith(card("a", 0, 0), []);
    expect(onSkipped).not.toHaveBeenCalled();
  });
});

describe("canvas gesture redo", () => {
  const after = (x: number) => ({ nodes: card("a", x, 0), sections: [] });

  it("puts an undone move back, and a new move forgets what was undone", async () => {
    const { hook, save } = setup();
    act(() => hook.result.current.recordPositions(card("a", 0, 0), [], after(50)));
    expect(hook.result.current.canRedo).toBe(false);
    await act(async () => { await hook.result.current.undo(); });
    expect(hook.result.current.canRedo).toBe(true);
    expect(hook.result.current.canUndo).toBe(false);
    await act(async () => { await hook.result.current.redo(); });
    expect(save).toHaveBeenLastCalledWith(card("a", 50, 0), []);
    expect(hook.result.current.canUndo).toBe(true);
    expect(hook.result.current.canRedo).toBe(false);

    await act(async () => { await hook.result.current.undo(); });
    act(() => hook.result.current.recordPositions(card("a", 0, 0), [], after(70)));
    expect(hook.result.current.canRedo).toBe(false);
  });

  it("leaves a card alone that moved since the undo, and says so", async () => {
    const save = vi.fn();
    const skipped = vi.fn();
    const layout = (x: number) => ({ nodes: [{ nodeId: "a", x, y: 0 }] });
    const hook = renderHook(
      ({ l }: { l: ReturnType<typeof layout> }) => useCanvasUndo({ canvasId: "c1", layout: l, onRestorePositions: save, onSkipped: skipped }),
      { initialProps: { l: layout(50) } },
    );
    act(() => hook.result.current.recordPositions(card("a", 0, 0), [], after(50)));
    await act(async () => { await hook.result.current.undo(); });
    hook.rerender({ l: layout(300) }); // moved by someone else after the undo
    await act(async () => { expect(await hook.result.current.redo()).toBe(false); });
    expect(save).toHaveBeenCalledTimes(1);
    expect(skipped).toHaveBeenCalledWith(1);
  });

  it("does not put an undone move into a redo line that a new move has since started", async () => {
    const { hook, save } = setup();
    let accept!: () => void;
    save.mockImplementationOnce(() => new Promise<void>((yes) => { accept = yes; }));
    act(() => hook.result.current.recordPositions(card("a", 0, 0), [], { nodes: card("a", 50, 0), sections: [] }));
    let pending!: Promise<boolean>;
    act(() => { pending = hook.result.current.undo(); });
    // The person drags another card before the server has accepted the undo.
    act(() => hook.result.current.recordPositions(card("b", 0, 0), [], { nodes: card("b", 9, 9), sections: [] }));
    await act(async () => { accept(); await pending; });
    expect(hook.result.current.canRedo).toBe(false);
    save.mockClear();
    await act(async () => { expect(await hook.result.current.redo()).toBe(false); });
    expect(save).not.toHaveBeenCalled();
  });

  it("drops a redo that never learned where its move ended, so redo does not stay lit", async () => {
    const { hook, save } = setup();
    act(() => hook.result.current.recordPositions(card("a", 0, 0))); // an arrangement: no `after`, no next layout
    await act(async () => { await hook.result.current.undo(); });
    expect(hook.result.current.canRedo).toBe(true);
    save.mockClear();
    await act(async () => { expect(await hook.result.current.redo()).toBe(false); });
    expect(save).not.toHaveBeenCalled();
    expect(hook.result.current.canRedo).toBe(false);
    const press = new KeyboardEvent("keydown", { key: "z", metaKey: true, shiftKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(false); // nothing to redo: the key is left to the browser
  });

  it("leaves ⌘Z and ⌘⇧Z alone when something closer (a PDF card's strokes) already took them", () => {
    const { hook, save } = setup();
    act(() => hook.result.current.recordPositions(card("a", 0, 0), [], { nodes: card("a", 50, 0), sections: [] }));
    const taken = (event: Event) => event.preventDefault();
    document.addEventListener("keydown", taken);
    try {
      fireEvent.keyDown(document.body, { key: "z", metaKey: true });
      fireEvent.keyDown(document.body, { key: "z", metaKey: true, shiftKey: true });
    } finally { document.removeEventListener("keydown", taken); }
    expect(save).not.toHaveBeenCalled();
    expect(hook.result.current.canUndo).toBe(true);
    fireEvent.keyDown(document.body, { key: "z", metaKey: true }); // nobody took it: undo runs
    expect(save).toHaveBeenCalledTimes(1);
  });
});
