// A board's parent arrow (parent mode: drawing source → target makes the
// target a child of the source) is a move, so it asks the one placement rule
// (lib/data placementRefusal, depth audit D101) before writing. It used to
// check nothing: an arrow to a tag, to another space's note or to the note's
// own descendant went straight to the server and came back refused.

// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { getAppState, resetAppState } from "../lib/appStore";
import { setLocalePref } from "../lib/i18n";
import { useBoardWorkspace } from "../hooks/useBoardWorkspace";

const node = (id: string, over: Partial<ContentNode> = {}) =>
  ({ id, title: id, slug: id, markdown: "", node_type: "content", source_type: "manual", parent_id: null, space_id: "s1", ...over }) as ContentNode;

function connect(childId: string, parentId: string) {
  const assignToGroup = vi.fn(async () => {});
  const options = {
    ui: { mode: "notes", notesView: "canvas", setNotesView: vi.fn() },
    focus: { selectedNode: null, openBoardId: null, selectInWorkspace: vi.fn(), settleCardRemoval: vi.fn(), createBoard: vi.fn() },
    menus: { canvasNavStack: [], setCanvasNavStack: vi.fn(), setCtxMenu: vi.fn() },
    createNodeRaw: vi.fn(),
    assignToGroup,
    refresh: vi.fn(async () => {}),
  } as unknown as Parameters<typeof useBoardWorkspace>[0];
  const hook = renderHook(() => useBoardWorkspace(options));
  act(() => hook.result.current.actions.onParentConnect(childId, parentId));
  return assignToGroup;
}

const errors = () => getAppState().toasts.filter((toast) => toast.kind === "error").map((toast) => toast.message);

describe("board parent arrow (D101)", () => {
  beforeEach(() => {
    setLocalePref("en");
    resetAppState({
      data: {
        ...noWorkspaceData,
        nodes: [
          node("child"), node("host"), node("kid", { parent_id: "child" }),
          node("elsewhere", { space_id: "s2" }), node("tag", { node_type: "class_tag", space_id: null }),
        ],
      },
    });
  });

  it("a valid parent is written", () => {
    expect(connect("child", "host")).toHaveBeenCalledExactlyOnceWith("child", "host");
    expect(errors()).toEqual([]);
  });

  it.each([
    ["a tag", "tag", /tags and notes are kept in separate trees/],
    ["a note in another space", "elsewhere", /another space/],
    ["the note's own descendant", "kid", /own sub-notes/],
    ["a note that is not there", "gone", /no longer exists/],
  ])("refuses %s before any write, with the server's words", (_label, parentId, words) => {
    expect(connect("child", parentId)).not.toHaveBeenCalled();
    expect(errors()).toHaveLength(1);
    expect(errors()[0]).toMatch(words);
  });
});
