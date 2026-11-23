// The way the shell reaches the board (whiteboard) without carrying its code.
//
// The board's hooks (layout, card actions, sub-note tree, card writes: about 12 KiB gzip) run in
// components/BoardController, which loads right after the workspace's first paint and publishes what it
// builds here. Boot code only holds this small store, so:
//   • a command, a shortcut or a card created while a board is open asks `whenReady()`: if the board
//     code has not arrived yet the call waits for it and then runs, it is not dropped;
//   • the board screen and the right-click menu read the published value (`useBoardController`).
import { use, useSyncExternalStore } from "react";
import type { BoardWorkspace } from "./useBoardWorkspace";

let current: BoardWorkspace | null = null;
let waiting: { promise: Promise<BoardWorkspace>; resolve: (board: BoardWorkspace) => void } | null = null;
const listeners = new Set<() => void>();

function notify() { for (const listener of [...listeners]) listener(); }

export const boardController = {
  /** The controller (re)built the board's state; called on every render of it. */
  publish(board: BoardWorkspace) {
    current = board;
    if (waiting) { waiting.resolve(board); waiting = null; }
    notify();
  },
  /** The controller is gone (the workspace closed): later calls wait for the next one. */
  clear() {
    current = null;
    notify();
  },
  /** The board's state once the controller is up: now, or when its code arrives. */
  whenReady(): Promise<BoardWorkspace> {
    if (current) return Promise.resolve(current);
    if (!waiting) {
      let resolve!: (board: BoardWorkspace) => void;
      waiting = { promise: new Promise<BoardWorkspace>((done) => { resolve = done; }), resolve };
    }
    return waiting.promise;
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  snapshot: () => current,
};

/** The board's state, or null while the controller's code is still loading. */
function useBoardController(): BoardWorkspace | null {
  return useSyncExternalStore(boardController.subscribe, boardController.snapshot);
}

/** Like useBoardController, but suspends (the surrounding Suspense shows its fallback) until the controller is up. */
export function useBoardControllerReady(): BoardWorkspace {
  const board = useBoardController();
  return board ?? use(boardController.whenReady());
}
