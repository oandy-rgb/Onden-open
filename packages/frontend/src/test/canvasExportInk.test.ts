// A board's handwriting leaves with it: as one SVG picture, the last node of
// the .canvas (JSON Canvas stacks later nodes on top, and Onden draws strokes
// above the cards), both in one zip. A board without ink stays one .canvas file.

import { beforeEach, expect, it, vi } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { encodeInk, inkToSvg, type InkDocument } from "@onden/markdown/ink";
import type { Canvas, ContentNode } from "../lib/api";

const stored = vi.hoisted(() => ({ board: null as string | null, handwriting: null as string | null }));
vi.mock("../lib/data", async (original) => {
  const data = await original<typeof import("../lib/data")>();
  return { ...data, reads: { ...data.reads, notes: { ...data.reads.notes, attributeValues: vi.fn(async (_id: string, names: string[]) => Object.fromEntries(names.map((n) => [n, n === "board_ink" ? stored.board : n === "ink_data" ? stored.handwriting : null]))) } } };
});
import { prepareCanvasExport } from "../lib/canvasExport";
import { canvasArchive } from "../lib/canvasArchive";
import type { JsonCanvas } from "../lib/jsonCanvas";

const note = (id: string): ContentNode => ({ id, title: id, markdown: `body ${id}`, source_type: "manual", node_type: "content", slug: id });
const board: Canvas = { id: "board", title: "Ink 白板", created_at: "", updated_at: "", data: { nodes: [{ nodeId: "a", x: 0, y: 0 }], sections: [] } };
const drawing: InkDocument = {
  version: 1, erased: {}, page: { width: 1000 },
  strokes: [{ id: "s1", color: "#d33", size: 4, toolId: "pen", points: [[-200, -100], [-120, -40], [-40, -90], [60, 20]] }],
};

/** The JSON Canvas 1.0 node/edge types, written out from the spec (jsoncanvas.org),
 *  so a malformed file fails here instead of in someone's Obsidian. */
function assertJsonCanvas(value: unknown, files: ReadonlySet<string>) {
  const canvas = value as JsonCanvas;
  const ids = new Set<string>();
  for (const node of canvas.nodes) {
    expect(typeof node.id).toBe("string");
    expect(ids.has(node.id)).toBe(false);
    ids.add(node.id);
    for (const key of ["x", "y", "width", "height"] as const) expect(Number.isInteger(node[key]), `${node.id}.${key}`).toBe(true);
    expect(node.width).toBeGreaterThan(0);
    expect(node.height).toBeGreaterThan(0);
    if (node.type === "file") {
      expect(typeof node.file).toBe("string");
      expect(files.has(node.file!), `${node.file} is in the zip`).toBe(true);
    } else if (node.type === "text") expect(typeof node.text).toBe("string");
    else if (node.type === "link") expect(typeof node.url).toBe("string");
    else expect(node.type).toBe("group");
  }
  for (const edge of canvas.edges) {
    expect(ids.has(edge.fromNode) && ids.has(edge.toNode)).toBe(true);
  }
}

beforeEach(() => { stored.board = null; });

it("a board without handwriting has no picture: one .canvas file as before", async () => {
  const prepared = await prepareCanvasExport(board, [note("a")], []);
  expect(prepared.ink).toBeNull();
  expect(prepared.canvas.nodes.some((n) => n.type === "file")).toBe(false);
});

it("a board with handwriting gets a file node over the cards, framed on the strokes, drawn by inkToSvg", async () => {
  stored.board = encodeInk(drawing);
  const prepared = await prepareCanvasExport(board, [note("a")], []);
  const nodes = prepared.canvas.nodes;
  const last = nodes[nodes.length - 1]!;
  expect(nodes.map((n) => n.type)).toEqual(["text", "file"]);
  expect(last).toMatchObject({ type: "file", file: "Ink-白板-ink.svg" });
  // The frame is the SVG's own viewBox, in whole board units.
  const svg = prepared.ink!.svg;
  expect(svg).toBe(inkToSvg(drawing));
  const [x, y, w, h] = /viewBox="([^"]+)"/.exec(svg)![1]!.split(" ").map(Number) as [number, number, number, number];
  expect(last).toMatchObject({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
  // It covers every stroke point (outlines grow a little past them).
  expect(last.x).toBeLessThanOrEqual(-200);
  expect(last.y).toBeLessThanOrEqual(-100);
  expect(last.x + last.width).toBeGreaterThanOrEqual(60);
  expect(last.y + last.height).toBeGreaterThanOrEqual(20);
});

it("the zip holds the .canvas and the picture it names, and the canvas is valid JSON Canvas", async () => {
  stored.board = encodeInk(drawing);
  const prepared = await prepareCanvasExport(board, [note("a")], []);
  const blob = await canvasArchive({ ...prepared, ink: prepared.ink! });
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  expect(Object.keys(files).sort()).toEqual(["Ink-白板-ink.svg", "Ink-白板.canvas"]);
  assertJsonCanvas(JSON.parse(strFromU8(files["Ink-白板.canvas"]!)), new Set(Object.keys(files)));
  expect(strFromU8(files["Ink-白板-ink.svg"]!)).toBe(inkToSvg(drawing));
  expect(prepared.archiveName).toBe("Ink-白板.zip");
});

it("a PDF's envelope or fully erased strokes are not board ink", async () => {
  stored.board = JSON.stringify({ version: 1, pages: {}, annotations: [] });
  expect((await prepareCanvasExport(board, [note("a")], [])).ink).toBeNull();
  stored.board = encodeInk({ ...drawing, erased: { s1: [[0, 3]] } });
  expect((await prepareCanvasExport(board, [note("a")], [])).ink).toBeNull();
});

it("a note with only ink_data (its own handwriting page) exports no board ink", async () => {
  stored.handwriting = encodeInk(drawing);
  expect((await prepareCanvasExport(board, [note("a")], [])).ink).toBeNull();
});
