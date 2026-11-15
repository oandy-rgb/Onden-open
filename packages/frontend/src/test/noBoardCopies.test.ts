// "Give a note a board" never makes another note (migration 139 folded the copies the
// old paths left behind). The path that remains gives the note's own whiteboard tab:
//  - opening a card as a sub-board on a board (useCanvasActions.handleOpenSubCanvas).
// (The former 「從子筆記建立白板」 is gone: a note's board follows its sub-notes by itself.)
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { noWorkspaceData, type Bootstrap, type Canvas } from "../lib/api";
import { bindAccountStorage } from "../lib/accountStorage";
import { resetAppState } from "../lib/appStore";
import { resetOwnerViews } from "../lib/ownerViews";

const mocks = vi.hoisted(() => ({
  create: vi.fn(async () => ({ id: "view-1" })),
  update: vi.fn(async () => ({})),
  list: vi.fn(async () => ({ views: [] as unknown[] })),
  createNote: vi.fn(),
}));
vi.mock("../lib/localDb", async (original) => ({ ...await original<typeof import("../lib/localDb")>(), getPendingWrites: vi.fn(async () => []) }));
vi.mock("../lib/data", async (original) => {
  const real = await original<typeof import("../lib/data")>();
  return {
    ...real,
    viewWriter: { ...real.viewWriter, create: mocks.create, update: mocks.update },
    reads: { ...real.reads, views: { ...real.reads.views, list: mocks.list } },
    noteWriter: { ...real.noteWriter, create: mocks.createNote },
  };
});
import { useCanvasActions } from "../hooks/useCanvasActions";

const board: Canvas = {
  id: "board", title: "Board", created_at: "2026-10-27T00:00:00Z", updated_at: "2026-10-27T00:00:00Z",
  data: { nodes: [{ nodeId: "card", x: 0, y: 0 }, { nodeId: "linked", x: 50, y: 0, subCanvasId: "old-sub" }], sections: [] },
};

function setup() {
  const createCanvas = vi.fn(async () => null);
  const selectCanvas = vi.fn();
  const setCanvasNavStack = vi.fn();
  const { result } = renderHook(() => useCanvasActions({
    data: { nodes: [{ id: "card", title: "Card" }, { id: "linked", title: "Linked" }] } as unknown as Bootstrap,
    online: true, selectedId: null, activeCanvas: board,
    saveCanvasData: vi.fn(), placeCanvasNode: vi.fn(async () => {}), placeExistingNote: vi.fn(async () => true), selectCanvas, createCanvas, setCanvasNavStack,
  }));
  return { actions: result.current, createCanvas, selectCanvas, setCanvasNavStack };
}

beforeEach(() => {
  localStorage.clear();
  bindAccountStorage("no-board-copies-test", "");
  resetOwnerViews();
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({ views: [] });
  resetAppState({ online: true, data: { ...noWorkspaceData, nodes: [], tags: [] } });
});

describe("opening a card as a sub-board", () => {
  it("opens the card note's own board: adds its whiteboard tab, makes no note, links nothing", async () => {
    const { actions, createCanvas, selectCanvas } = setup();
    await actions.handleOpenSubCanvas("card");
    expect(mocks.create).toHaveBeenCalledWith({ kind: "node", id: "card" }, expect.objectContaining({ layout: "canvas" }));
    expect(selectCanvas).toHaveBeenCalledWith("card");
    expect(createCanvas).not.toHaveBeenCalled();
    expect(mocks.createNote).not.toHaveBeenCalled();
  });

  it("does not add a second tab when the note already has one, and shows a hidden one", async () => {
    mocks.list.mockResolvedValue({ views: [{ id: "v", layout: "canvas", name: "Canvas", layout_config: { hidden: true, opens_first: true } }] });
    const { actions, selectCanvas } = setup();
    await actions.handleOpenSubCanvas("card");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith({ kind: "node", id: "card" }, "v", { layout_config_patch: { hidden: null } });
    expect(selectCanvas).toHaveBeenCalledWith("card");
  });

  it("an old sub-board link still opens that board", async () => {
    const { actions, createCanvas, selectCanvas } = setup();
    await actions.handleOpenSubCanvas("linked");
    expect(selectCanvas).toHaveBeenCalledWith("old-sub");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(createCanvas).not.toHaveBeenCalled();
  });
});
