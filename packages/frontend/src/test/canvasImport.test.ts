import { describe, it, expect, vi } from "vitest";
import { canvasFileTitle, importCanvasFile } from "../lib/data/canvasImport";
import { JsonCanvasFormatError } from "../lib/jsonCanvas";

const file = (name: string, text: string) => new File([text], name, { type: "application/json" });

describe("importing a .canvas file", () => {
  it("titles the board by the file name", () => {
    expect(canvasFileTitle("Research map.canvas")).toBe("Research map");
    expect(canvasFileTitle(".canvas")).toBe("Imported board");
  });

  it("imports parsed JSON and returns the new board id", async () => {
    const importBoard = vi.fn(async () => "board-1");
    const toast = vi.fn();
    expect(await importCanvasFile(file("Map.canvas", '{"nodes":[]}'), importBoard, toast)).toBe("board-1");
    expect(importBoard).toHaveBeenCalledWith("Map", { nodes: [] });
    expect(toast).not.toHaveBeenCalled();
  });

  it("says the file is not JSON, without calling the importer", async () => {
    const importBoard = vi.fn();
    const toast = vi.fn();
    expect(await importCanvasFile(file("Bad.canvas", "{nope"), importBoard, toast)).toBeNull();
    expect(importBoard).not.toHaveBeenCalled();
    expect(toast.mock.calls[0][0]).toMatch(/isn't in the right format/);
  });

  it("a format error means nothing was created; a later failure says some content may exist", async () => {
    const toast = vi.fn();
    await importCanvasFile(file("A.canvas", "{}"), async () => { throw new JsonCanvasFormatError("nodes", "expected a list"); }, toast);
    expect(toast.mock.calls[0][0]).toMatch(/isn't in the right format/);
    toast.mockClear();
    await importCanvasFile(file("B.canvas", "{}"), async () => { throw new TypeError("Failed to fetch"); }, toast);
    expect(toast.mock.calls[0][0]).toMatch(/Import stopped\. Some content may already have been created/);
  });
});
