import { TAG_NODE_TYPE } from "@onden/markdown/contract";
// Pure decision for the BuilderApp auto-canvas effect: given the focused node
// and current canvas state, what should the Canvas lens do? Extracted so the
// (subtle, offline-sensitive) branching is unit-testable without rendering the
// whole BuilderApp.
//
// The L6 fix lives here: when OFFLINE and the focused node changed, the lens must
// DROP the previous node's board ("clearOffline") instead of leaving it on screen
// when the note does not identify a board we can open from the local mirror.

export type CanvasViewDecision =
  | { action: "noop" }                       // no node / not the canvas lens / same node
  | { action: "keep" }                       // the node is already on the active board
  | { action: "clearOffline" }               // offline: drop the stale board, retry on reconnect
  | { action: "load"; canvasId: string };    // the node's own board, or the one it is a card on

export function decideCanvasView(opts: {
  selectedNodeId: string | null;
  selectedNodeType: "content" | "class_tag" | "canvas" | null;
  notesView: string;
  online: boolean;
  /** autoCanvasRef.current — the node we last acted on. */
  prevAutoId: string | null;
  /** Whether the focused node is on the currently-active board: a card of it,
   *  or a sub-note its tree draws. */
  nodeOnActiveBoard: boolean;
  /** The canvas id from this node's membership, if any (local data). */
  membershipCanvasId: string | null;
  /** The note holds a whiteboard of its own: a whiteboard tab, cards on its
   *  board, or the retired node kind 'canvas'. Its board is keyed by its id. */
  ownsWhiteboard?: boolean;
}): CanvasViewDecision {
  const { selectedNodeId, selectedNodeType, notesView, online, prevAutoId, nodeOnActiveBoard, membershipCanvasId, ownsWhiteboard } = opts;
  if (!selectedNodeId || notesView !== "canvas") return { action: "noop" };
  if (prevAutoId === selectedNodeId) return { action: "noop" };
  // A note with a whiteboard IS the board (the whiteboard is a view of a note,
  // migration 138). Its presence on another board does not change that
  // identity; the writer also knows how to open its local offline copy.
  if (selectedNodeType === "canvas" || ownsWhiteboard) return { action: "load", canvasId: selectedNodeId };
  // A tag's canvas lens is the tag's own board: its members laid out as cards.
  if (selectedNodeType === TAG_NODE_TYPE) return { action: "load", canvasId: selectedNodeId };
  // The user clicked a card already on the board — keep their layout.
  if (nodeOnActiveBoard) return { action: "keep" };
  // An ordinary note does not itself identify a board. Clear the previous one
  // while offline instead of showing the wrong note's board; reconnect re-decides.
  if (!online) return { action: "clearOffline" };
  if (membershipCanvasId) return { action: "load", canvasId: membershipCanvasId };
  // No board of its own yet: its own board is read (nothing is written) and
  // follows its sub-notes (docs/architecture/canvas-as-view.md).
  return { action: "load", canvasId: selectedNodeId };
}
