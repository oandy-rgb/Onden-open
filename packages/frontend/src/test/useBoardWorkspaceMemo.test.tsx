// H4 re-render hygiene for the board's groups (depth audit D5): BuilderApp
// re-renders often and hands useBoardWorkspace fresh option objects and fresh
// closures every time. The memoized KnowledgeWorkspace (and the cards'
// callback context) skip those renders only if `actions` keeps ONE identity
// and `board` changes only when a value in it does.

// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { resetAppState } from "../lib/appStore";
import { useBoardWorkspace } from "../hooks/useBoardWorkspace";

function options() {
  return {
    ui: { mode: "notes", notesView: "canvas", setNotesView: vi.fn() },
    focus: {
      selectedNode: null, openBoardId: null, selectInWorkspace: vi.fn(),
      settleCardRemoval: vi.fn(), createBoard: vi.fn(),
    },
    menus: { canvasNavStack: [], setCanvasNavStack: vi.fn(), setCtxMenu: vi.fn() },
    createNodeRaw: vi.fn(),
    assignToGroup: vi.fn(),
    refresh: vi.fn(async () => {}),
  } as unknown as Parameters<typeof useBoardWorkspace>[0];
}

describe("useBoardWorkspace groups", () => {
  beforeEach(() => resetAppState());

  it("keeps actions and board when the shell re-renders with fresh closures", () => {
    const hook = renderHook((opts) => useBoardWorkspace(opts), { initialProps: options() });
    const first = hook.result.current;
    hook.rerender(options());
    expect(hook.result.current.actions).toBe(first.actions);
    expect(hook.result.current.board).toBe(first.board);
  });

  it("a handler calls the latest closure", () => {
    const first = options();
    const hook = renderHook((opts) => useBoardWorkspace(opts), { initialProps: first });
    const next = options();
    hook.rerender(next);
    act(() => hook.result.current.actions.onSelectNode("n1"));
    expect(next.focus.selectInWorkspace).toHaveBeenCalledWith("n1");
    expect(first.focus.selectInWorkspace).not.toHaveBeenCalled();
  });

  it("a new board object when a value in it changes", () => {
    const hook = renderHook((opts) => useBoardWorkspace(opts), { initialProps: options() });
    const first = hook.result.current;
    act(() => first.board.setCanvasSearch("foo"));
    expect(hook.result.current.board).not.toBe(first.board);
    expect(hook.result.current.board.canvasSearch).toBe("foo");
    expect(hook.result.current.actions).toBe(first.actions);
  });
});
