import { readTreeSettings, withTreeSettings, type BoardTreeSettings } from "../lib/boardTreeSettings";
import { useBoardTabSetting, writeBoardTabSetting, type BoardTabSetting } from "./useBoardTabSetting";

const TREE: BoardTabSetting<BoardTreeSettings> = { read: readTreeSettings, write: withTreeSettings };

/** Store a board's tree settings in its whiteboard tab (writeBoardTabSetting). */
export function writeBoardTreeSettings(boardId: string, settings: BoardTreeSettings): Promise<void> {
  return writeBoardTabSetting(boardId, TREE, settings);
}

/** The tree settings of a note's board, as stored in its whiteboard tab (see useBoardTabSetting). */
export function useBoardTreeSettings(boardId: string | null) {
  return useBoardTabSetting(boardId, TREE);
}
