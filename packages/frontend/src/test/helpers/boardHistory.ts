import type { BoardHistory } from "../../hooks/useBoardHistory";

/** A board history that records nothing: for tests of a board part that only needs the prop. */
export const idleBoardHistory: BoardHistory = {
  push: () => {},
  batch: (fn) => fn(),
  undo: async () => false,
  redo: async () => false,
  canUndo: false,
  canRedo: false,
};
