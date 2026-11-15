import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/api", async original => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn() }));
// Cards and links go through the note/relation writers: record their requests.
const submitted = vi.hoisted(() => ({ calls: [] as Array<{ method: string; path: string; body: Record<string, unknown> }>, fail: null as unknown }));
vi.mock("../lib/data/writeQueue", async (original) => ({
  ...await original<typeof import("../lib/data/writeQueue")>(),
  submitWrite: async (r: { method: string; path: string; body: string | null }) => {
    const body = JSON.parse(r.body ?? "{}");
    submitted.calls.push({ method: r.method, path: r.path, body });
    if (submitted.fail && r.path === "/api/edges") throw submitted.fail;
    return { status: "synced", value: body };
  },
}));
// The board's tree setting is stored in its whiteboard tab: record the write.
const treeWrites = vi.hoisted(() => vi.fn(async (_boardId: string, _settings: unknown) => {}));
vi.mock("../hooks/useBoardTreeSettings", () => ({ writeBoardTreeSettings: treeWrites }));
vi.mock("../lib/localDb", () => ({
  upsertNode: vi.fn(async () => {}), removeNode: vi.fn(async () => {}), upsertAttribute: vi.fn(async () => {}),
  upsertEdge: vi.fn(async () => {}), removeEdge: vi.fn(async () => {}), getPendingWrites: vi.fn(async () => []),
}));
import { api, ApiError, noWorkspaceData, type Canvas } from "../lib/api";
import { fromJsonCanvas, JsonCanvasFormatError } from "../lib/jsonCanvas";
import { useCanvasActions } from "../hooks/useCanvasActions";

const card = (id = "a") => ({ id, type: "text", x: -20, y: 30, width: 260, height: 200, text: `# ${id}\n\nbody` });
const board: Canvas = { id: "board", title: "Imported", created_at: "", updated_at: "", data: { nodes: [] } };
function useImporter() {
  const create = vi.fn(async () => board), save = vi.fn(async () => {});
  const actions = useCanvasActions({
    data: noWorkspaceData, online: true, selectedId: null, activeCanvas: null,
    saveCanvasData: save, placeCanvasNode: vi.fn(async () => {}), placeExistingNote: vi.fn(async () => true), selectCanvas: vi.fn(),
    createCanvas: create, setCanvasNavStack: vi.fn(),
  });
  return { importCanvas: actions.importJsonCanvas, create, save };
}
beforeEach(() => { vi.clearAllMocks(); submitted.calls.length = 0; submitted.fail = null; });

describe("JSON Canvas validates a whole file before creating anything", () => {
  it.each([
    ["malformed node", { nodes: [card(), { id: "b", type: "text", x: "20", y: 0 }] }],
    ["duplicate node ID", { nodes: [card(), card()] }],
    ["invalid size", { nodes: [{ ...card(), width: "wide" }] }],
    ["dangling edge", { nodes: [card()], edges: [{ id: "e", fromNode: "a", toNode: "missing" }] }],
    ["invalid edge list", { nodes: [card()], edges: {} }],
    ["null edge", { nodes: [card()], edges: [null] }],
  ])("refuses %s before any write", async (_name, input) => {
    const { importCanvas, create, save } = useImporter();
    await expect(importCanvas("Imported", input)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
  });

  it("a duplicate identity cannot redirect both placements/edges to the last created note", () => {
    expect(() => fromJsonCanvas({ nodes: [card(), { ...card(), text: "other text" }] })).toThrow();
  });

  it("accepts an empty standard document (both arrays are optional)", () => {
    expect(fromJsonCanvas({})).toEqual({ cards: [], sections: [], links: [] });
  });

  it.each([
    ["unknown type", { ...card(), type: "custom" }],
    ["empty ID", { ...card(), id: "" }],
    ["null node", null],
    ["non-text body", { ...card(), text: { text: "wrong" } }],
    ["non-text color", { ...card(), color: 3 }],
    ["missing dimension", { ...card(), height: undefined }],
    ["zero dimension", { ...card(), height: 0 }],
    ["negative dimension", { ...card(), width: -1 }],
    ["fractional coordinate", { ...card(), x: 0.5 }],
    ["non-finite coordinate", { ...card(), y: Infinity }],
    ["oversized heading", { ...card(), text: `# ${"a".repeat(501)}\n\nbody` }],
  ])("rejects %s with an input path, without including the body", (_name, node) => {
    expect(() => fromJsonCanvas({ nodes: [node] })).toThrow(JsonCanvasFormatError);
    expect(() => fromJsonCanvas({ nodes: [node] })).toThrow("nodes[0]");
  });

  it("rejects duplicate edge IDs, and counts (not silently drops) connections that end on a group", () => {
    const edge = { id: "e", fromNode: "a", toNode: "b" };
    expect(() => fromJsonCanvas({ nodes: [card(), card("b")], edges: [edge, edge] })).toThrow("unique edge ID");
    const parsed = fromJsonCanvas({ nodes: [card(), { ...card("b"), type: "group" }], edges: [edge] });
    expect(parsed.links).toEqual([]);
    expect(parsed.skippedGroupLinks).toBe(1);
  });

  it("preserves four supported node types, long link/file references and their subpaths without reading external files", () => {
    const file = `../../${"p".repeat(550)}.pdf`;
    const url = `https://example.test/${"u".repeat(550)}`;
    const parsed = fromJsonCanvas({
      nodes: [card(), { ...card("link"), type: "link", url },
        { ...card("file"), type: "file", file, subpath: "#heading" },
        { ...card("group"), type: "group", label: "Research", color: "2" }],
      edges: [{ id: "edge", fromNode: "a", toNode: "file" }],
    });
    expect(parsed.cards[0]).toMatchObject({ key: "a", title: "a", markdown: "body", x: -20, width: 260 });
    expect(parsed.cards[1]).toMatchObject({ title: url.slice(0, 80), markdown: url });
    expect(parsed.cards[2]).toMatchObject({ title: file.slice(0, 80), markdown: `Imported file reference: \`${file}#heading\`` });
    expect(parsed.sections[0]).toMatchObject({ title: "Research", color: "#f97316" });
    expect(parsed.links).toEqual([{ fromKey: "a", toKey: "file" }]);
    expect(api).not.toHaveBeenCalled();
  });

  it("creates valid cards, stored geometry, groups and mapped connections in order", async () => {
    const { importCanvas, create, save } = useImporter();
    const id = await importCanvas("Imported", {
      nodes: [card(), card("b"), { ...card("group"), type: "group", label: "Research" }],
      edges: [{ id: "e", fromNode: "a", toNode: "b" }],
    });
    expect(id).toBe("board");
    expect(create).toHaveBeenCalledExactlyOnceWith("Imported");
    const [a, b, edge] = submitted.calls;
    expect([a!.path, b!.path, edge!.path]).toEqual(["/api/nodes", "/api/nodes", "/api/edges"]);
    expect(save).toHaveBeenCalledWith("board", {
      nodes: [{ nodeId: a!.body.id, x: -20, y: 30, width: 260, height: 200 }, { nodeId: b!.body.id, x: -20, y: 30, width: 260, height: 200 }],
      sections: [{ id: expect.any(String), x: -20, y: 30, width: 260, height: 200, title: "Research" }],
    });
    expect(edge!.body).toMatchObject({ source_node_id: a!.body.id, target_node_id: b!.body.id, edge_type: "knowledge_link" });
    // The file's cards are the whole board: it does not follow its note's sub-notes.
    expect(treeWrites).toHaveBeenCalledExactlyOnceWith("board", { mode: "manual" });
  });

  it("does not report success when a connection is refused", async () => {
    const { importCanvas, save } = useImporter();
    const failure = new ApiError(403, '{}');
    submitted.fail = failure;
    await expect(importCanvas("Imported", { nodes: [card(), card("b")], edges: [{ id: "e", fromNode: "a", toNode: "b" }] })).rejects.toBe(failure);
    expect(save).toHaveBeenCalledTimes(1);
    expect(submitted.calls.filter((c) => c.path === "/api/edges")).toHaveLength(1);
  });
});
