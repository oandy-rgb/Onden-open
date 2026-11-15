// What a board remembers about its "follow the sub-notes" tree: the mode, how
// many levels show, and the branches the person opened or closed. It lives in
// the whiteboard tab's `layout_config.tree` (the server keeps any keys of a
// view's layout_config), so it needs no table of its own and an old board
// without the key is untouched. Dragged cards are ordinary board cards.

import { DEFAULT_TREE_DEPTH, TREE_DEPTHS, type BranchChoices, type TreeDepth } from "./boardTree";
import { peekOwnerViews } from "./ownerViews";
import { whiteboardTabIn } from "./whiteboardNote";

/** "auto": the sub-notes are laid out for the person; "manual": only the cards they placed. */
export type TreeMode = "auto" | "manual";

/** As stored: a key is absent until the person changes it. */
export type BoardTreeSettings = { mode?: TreeMode; depth?: TreeDepth; open?: readonly string[]; closed?: readonly string[] };

const KEY = "tree";

const ids = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : undefined;

/** The tree settings in a whiteboard tab's `layout_config`; anything unreadable counts as unset. */
export function readTreeSettings(layoutConfig: Record<string, unknown> | null | undefined): BoardTreeSettings {
  const raw = layoutConfig?.[KEY];
  if (!raw || typeof raw !== "object") return {};
  const { mode, depth, open, closed } = raw as Record<string, unknown>;
  return {
    ...(mode === "auto" || mode === "manual" ? { mode } : {}),
    ...(TREE_DEPTHS.includes(depth as TreeDepth) ? { depth: depth as TreeDepth } : {}),
    ...(ids(open) ? { open: ids(open) } : {}),
    ...(ids(closed) ? { closed: ids(closed) } : {}),
  };
}

/** `layoutConfig` with the tree settings replaced and every other key kept
 *  (the tab's own `opens_first` and `hidden` live there too). */
export function withTreeSettings(layoutConfig: Record<string, unknown>, settings: BoardTreeSettings): Record<string, unknown> {
  return { ...layoutConfig, [KEY]: settings };
}

/** An empty board follows its sub-notes; a board that already has cards the
 *  person placed stays as they left it, until they choose otherwise. */
export function treeModeOf(settings: BoardTreeSettings, placedCards: number): TreeMode {
  return settings.mode ?? (placedCards === 0 ? "auto" : "manual");
}

/** The settings with every default filled in, for drawing. */
export function effectiveTree(settings: BoardTreeSettings): { depth: TreeDepth; choices: BranchChoices } {
  return { depth: settings.depth ?? DEFAULT_TREE_DEPTH, choices: { open: settings.open ?? [], closed: settings.closed ?? [] } };
}

/** The settings last read for a note's whiteboard tab, without subscribing: for
 *  a decision made outside rendering (does the board show this note's sub-notes). */
export function peekTreeSettings(boardId: string): BoardTreeSettings {
  const tab = whiteboardTabIn(peekOwnerViews({ kind: "node", id: boardId }));
  return readTreeSettings(tab?.layout_config);
}
