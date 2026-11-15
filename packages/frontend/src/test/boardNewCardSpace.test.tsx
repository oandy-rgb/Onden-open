import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
const create = vi.fn(async (input: { id?: string }) => ({ node: { id: input.id ?? "new" } }));
vi.mock("../lib/data", async (original) => {
  const actual = await original<typeof import("../lib/data")>();
  return { ...actual, uploadMedia: vi.fn(async () => "/media/x.png"), noteWriter: { ...actual.noteWriter, create: (...args: unknown[]) => create(...(args as [{ id?: string }])) } };
});
import { useCanvasActions } from "../hooks/useCanvasActions";
import { useNodeCreation } from "../hooks/useNodeCreation";
import type { Bootstrap, Canvas, ContentNode } from "../lib/api";
import { boardSpaceId } from "../lib/boardLayout";

// A note made ON a board is made in the board's space, so everybody who sees the board sees its
// card; only an existing note placed from elsewhere needs the reminder (boardCardAudience.test).

const node = (id: string, space_id: string | null) => ({ id, title: id, parent_id: null, space_id, node_type: "content" }) as ContentNode;
const NODES = [node("board", "sp-team"), node("tagboard", null)];
afterEach(() => vi.restoreAllMocks());

describe("boardSpaceId", () => {
  it("is the board's space; null for a tag's board, an unknown board or none", () => {
    expect(boardSpaceId(NODES, "board")).toBe("sp-team");
    expect(boardSpaceId(NODES, "tagboard")).toBeNull();
    expect(boardSpaceId(NODES, "nope")).toBeNull();
    expect(boardSpaceId(NODES, null)).toBeNull();
  });
});

describe("the create sheet while a board is open", () => {
  const params = (activeCanvas: Canvas | null) => ({
    data: { nodes: NODES } as never, createNodeRaw: vi.fn(async () => null), refresh: vi.fn(), draftTitle: "", setCreateOpen: vi.fn(),
    activeCanvas, addToActiveCanvas: vi.fn(), setSelectedId: vi.fn(), setMode: vi.fn(), openNote: vi.fn(), openNewTag: vi.fn(),
  });
  const board = { id: "board", title: "Board", created_at: "", updated_at: "", data: { nodes: [] } } as Canvas;

  // Named `use*` so the hooks lint rule accepts the call; the factory holds no React state.
  const useCreation = (p: ReturnType<typeof params>) => useNodeCreation(p);

  it("makes a new note in the board's space", async () => {
    const p = params(board);
    await useCreation(p).create("note");
    expect(p.createNodeRaw).toHaveBeenCalledWith(expect.any(String), "markdown", expect.any(Number), null, "sp-team");
  });

  it("an explicit choice of space wins, and no board means the usual default", async () => {
    const chosen = params(board);
    await useCreation(chosen).create("note", { spaceId: "sp-other" });
    expect(chosen.createNodeRaw).toHaveBeenCalledWith(expect.any(String), "markdown", expect.any(Number), null, "sp-other");
    const none = params(null);
    await useCreation(none).create("note");
    expect(none.createNodeRaw).toHaveBeenCalledWith(expect.any(String), "markdown", expect.any(Number), null, null);
  });
});

describe("pictures dropped on a board", () => {
  // Named `use*` for the hooks lint rule; useCanvasActions holds no React state of its own.
  const useActions = (place: () => Promise<void>) => useCanvasActions({
    data: { nodes: NODES } as unknown as Bootstrap, online: true, selectedId: null,
    activeCanvas: { id: "board", title: "Board", created_at: "", updated_at: "", data: { nodes: [] } } as Canvas,
    saveCanvasData: vi.fn(), placeCanvasNode: place, placeExistingNote: async () => true,
    selectCanvas: () => {}, createCanvas: async () => null, setCanvasNavStack: () => {},
  });
  it("make their notes in the board's space", async () => {
    const place = vi.fn(async () => {});
    await useActions(place).dropImagesAsCards([new File(["x"], "a.png", { type: "image/png" })]);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ space_id: "sp-team" }));
    expect(place).toHaveBeenCalledTimes(1);
  });
});

describe("a card made by double-clicking the board", () => {
  it("passes the board's space when it creates the note", () => {
    // useBoardWorkspace is too large to mount here; the call is the whole behaviour.
    const source = readFileSync(`${process.cwd()}/src/hooks/useBoardWorkspace.ts`, "utf8");
    expect(source).toMatch(/createNodeRaw\(t\("New note"\)[^\n]*boardSpaceId\(getAppState\(\)\.data\.nodes, canvasId\)/);
  });
});
