import { describe, it, expect } from "vitest";
import { decideCanvasView } from "../lib/canvasViewDecision";

const base = {
  selectedNodeId: "n2" as string | null,
  selectedNodeType: "content" as "content" | "class_tag" | "canvas",
  notesView: "canvas",
  online: true,
  prevAutoId: "n1" as string | null,
  nodeOnActiveBoard: false,
  membershipCanvasId: null as string | null,
};

describe("decideCanvasView", () => {
  it("offline node-switch clears the previous board instead of leaving it (L6)", () => {
    expect(decideCanvasView({ ...base, online: false })).toEqual({ action: "clearOffline" });
  });

  it("does nothing when off the canvas lens, has no node, or the node is unchanged", () => {
    expect(decideCanvasView({ ...base, notesView: "editor" })).toEqual({ action: "noop" });
    expect(decideCanvasView({ ...base, selectedNodeId: null })).toEqual({ action: "noop" });
    expect(decideCanvasView({ ...base, prevAutoId: "n2" })).toEqual({ action: "noop" }); // same node
  });

  it("keeps the layout when the node is already on the active board", () => {
    expect(decideCanvasView({ ...base, nodeOnActiveBoard: true })).toEqual({ action: "keep" });
    // even offline, a card on the current board is the right board — keep it.
    expect(decideCanvasView({ ...base, online: false, nodeOnActiveBoard: true })).toEqual({ action: "keep" });
  });

  it("online: reuses an existing membership board, else reads the note's own board (nothing is built or written)", () => {
    expect(decideCanvasView({ ...base, membershipCanvasId: "c9" })).toEqual({ action: "load", canvasId: "c9" });
    expect(decideCanvasView({ ...base })).toEqual({ action: "load", canvasId: "n2" });
  });

  it("opens a canvas node's own board instead of offering to build another", () => {
    const board = { ...base, selectedNodeId: "board", selectedNodeType: "canvas" as const };
    expect(decideCanvasView(board)).toEqual({ action: "load", canvasId: "board" });
  });

  it("does not confuse a canvas node with its placement on a parent board", () => {
    const board = { ...base, selectedNodeId: "board", selectedNodeType: "canvas" as const,
      nodeOnActiveBoard: true, membershipCanvasId: "parent-board" };
    expect(decideCanvasView(board)).toEqual({ action: "load", canvasId: "board" });
  });
  it("a plain note with a whiteboard opens its own board — over its placement on another board, as a canvas node always did", () => {
    const owner = { ...base, selectedNodeId: "inbox", ownsWhiteboard: true };
    expect(decideCanvasView(owner)).toEqual({ action: "load", canvasId: "inbox" });
    expect(decideCanvasView({ ...owner, nodeOnActiveBoard: true, membershipCanvasId: "parent-board" })).toEqual({ action: "load", canvasId: "inbox" });
    // Offline too: the note names its board and the writer has its local copy.
    expect(decideCanvasView({ ...owner, online: false })).toEqual({ action: "load", canvasId: "inbox" });
    // A note without one is a card on someone's board, as before.
    expect(decideCanvasView({ ...base, ownsWhiteboard: false, membershipCanvasId: "c9" })).toEqual({ action: "load", canvasId: "c9" });
  });
  it("a tag opens its own board: its members laid out as cards", () => {
    expect(decideCanvasView({ ...base, selectedNodeType: "class_tag" })).toEqual({ action: "load", canvasId: "n2" });
    // Offline too: the tag names its board, and the writer has its local copy.
    expect(decideCanvasView({ ...base, selectedNodeType: "class_tag", online: false })).toEqual({ action: "load", canvasId: "n2" });
  });
});
