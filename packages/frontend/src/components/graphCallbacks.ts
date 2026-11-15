// What a card or section on the whiteboard calls back into the workspace for.
// KnowledgeWorkspace provides it; CardNode and SectionNode read it. It lives
// apart so the node components don't import the workspace that renders them.

import { createContext } from "react";
import type { SaveCardBody } from "../hooks/useCardDraft";
import type { CanvasBounds } from "../lib/sectionCarry";

export const GraphCallbacksContext = createContext<{
  onNodeUpdate: SaveCardBody;
  /** Keep the active editor readable; release when it closes. */
  onNodeEditStart: (nodeId: string) => (() => void) | void;
  onNodeResized: (nodeId: string, bounds: CanvasBounds) => void;
  onSectionResized: (sectionId: string, bounds: CanvasBounds) => void;
  onSectionTitleChange: (sectionId: string, title: string) => Promise<unknown> | void;
  /** 「刪除群組框」: the frame goes, its cards stay. */
  onSectionRemove: (sectionId: string) => void;
  onNodeTitleChange: (nodeId: string, title: string) => void;
  /** A [[link]] clicked on card `fromId`: it resolves from that card's note. */
  onClickWikilink: (target: string, fromId: string) => void;
  /** Fold a card to its title bar, or expand it (the card's own choice; lib/cardDisplay). */
  onSetFolded: (nodeId: string, folded: boolean) => void;
  /** A title clicked in far zoom: zoom to that card and select it. */
  onFocusCard: (nodeId: string) => void;
  /** 「開啟完整筆記」: open the card's note. */
  onOpenCard: (nodeId: string) => void;
  onOpenSubCanvas: (nodeId: string) => void;
  /** Fold or unfold the sub-notes drawn under a card of the board's tree. */
  onToggleBranch: (nodeId: string) => void;
  /** 「+N」: draw another page of this note's sub-notes. */
  onShowMoreChildren: (parentId: string) => void;
}>({
  onNodeUpdate: () => {},
  onNodeEditStart: () => {},
  onNodeResized: () => {},
  onSectionResized: () => {},
  onSectionTitleChange: () => {},
  onSectionRemove: () => {},
  onNodeTitleChange: () => {},
  onClickWikilink: () => {},
  onSetFolded: () => {},
  onFocusCard: () => {},
  onOpenCard: () => {},
  onOpenSubCanvas: () => {},
  onToggleBranch: () => {},
  onShowMoreChildren: () => {},
});
