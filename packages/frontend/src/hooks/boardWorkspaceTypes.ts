import type { Edge, Node } from "@xyflow/react";
import type React from "react";
import type { CanvasData, NodeEdge } from "../lib/api";
import type { TreeDepth } from "../lib/boardTree";
import type { TreeMode } from "../lib/boardTreeSettings";
import type { CardDisplaySettings } from "../lib/cardDisplay";
import type { CardPosition, CanvasBounds } from "../lib/sectionCarry";
import type { SaveCardBody } from "./useCardDraft";
import type { BoardClipboardOps } from "./useBoardClipboard";

// The board's two contracts: BoardView (what it shows) and BoardActions (what it does). Defined here, next to
// useBoardWorkspace which builds them, so hooks never import from components/ (KnowledgeWorkspace re-exports them).

/** What the board shows: its state and the controls that set it. One object
 *  that changes only when one of these does (useBoardWorkspace memoizes it). */
export type BoardView = {
  /** The cards as drawn: the stored ones plus the sub-note tree's (useBoardTree).
   *  Absent: the stored layout is what is drawn. */
  layout?: CanvasData;
  /** A note's board that can follow its sub-notes; absent on a tag's board. */
  tree?: {
    mode: TreeMode;
    depth: TreeDepth;
    /** Auto mode and the note has no sub-notes yet. */
    childless: boolean;
    /** Centred on another note: the way back, from the board's own note to the centre. Empty otherwise. */
    crumbs: Array<{ id: string; title: string }>;
    backTo: (index: number) => void;
    setMode: (mode: TreeMode) => void;
    setDepth: (depth: TreeDepth) => void;
  };
  /** How cards are drawn (lib/cardDisplay): folded or expanded, and titles-only in far zoom.
   *  Held above the board because the tree's row spacing follows it. */
  display: { settings: CardDisplaySettings; set: (settings: CardDisplaySettings) => void };
  /** What pasting onto the board writes (useBoardClipboard). */
  clipboardOps?: BoardClipboardOps;
  /** Ink is stored on the board's canvas node; a tag's board has none. */
  inkEnabled?: boolean;
  /** A tag's board: its cards are the tag's members, not a stored list. */
  tagBoard?: boolean;
  /** Title of the parent canvas (when the active canvas is a sub-canvas).
   *  Used to label the "← Back" affordance. */
  parentCanvasTitle?: string;
  /** Pop one level off the sub-canvas nav stack. Provided only when nav is
   *  non-empty — absence hides the back button. */
  onBackToParentCanvas?: () => void;
  graphLocalMode: boolean;
  setGraphLocalMode: React.Dispatch<React.SetStateAction<boolean>>;
  showTagEdges: boolean;
  displayGraphNodes: Node[];
  displayGraphEdges: Edge[];
  canvasSearch: string;
  setCanvasSearch: React.Dispatch<React.SetStateAction<string>>;
  parentMode: boolean;
  setParentMode: (v: boolean) => void;
};

/** Everything the board does, as handlers with ONE identity for the board's
 *  life (useBoardWorkspace wraps them once), so the memoized shell and the
 *  cards' callback context never re-render for a new closure. */
export type BoardActions = {
  /** ⑦ add-to-board entry: place an EXISTING note on the active board at the
   *  spawn position. The old path was an HTML5 drag from a dead aside — this
   *  powers the toolbar picker, so it works on touch too. */
  onAddToCanvas: (nodeId: string) => Promise<unknown>;
  /** ⑦ align/distribute — ONE batched canvas write (per-node saves race). */
  onApplyPositions: (updates: Array<{ nodeId: string; x: number; y: number }>, sections?: CardPosition[]) => Promise<unknown> | void;
  /** ⑦ JSON Canvas (.canvas, jsoncanvas.org) interchange. */
  onImportCanvas: (title: string, raw: unknown) => Promise<string | null> | void;
  /** ⑦ auto-arrange (existed palette-only): grid tidy + tree layout. */
  onTidyCanvas: () => void;
  onArrangeTree: () => void;
  /** ⑦ 群組框: frame the multi-selection with a new section. */
  onGroupSelection: (cardIds: string[]) => void;
  /** ⑨ colour the whole selection at once (the align bar's swatches). */
  onSetNodesColor: (cardIds: string[], color: string | null) => void;
  onSelectNode: (id: string | null) => void;
  // graph
  onGraphDrop: (e: React.DragEvent, flowPos: { x: number; y: number }) => void;
  /** Pictures chosen from the pen toolbar's 「插入」: become image cards at `flowPos`. */
  onInsertImages: (files: File[], flowPos: { x: number; y: number }) => Promise<void>;
  onToggleTagEdges: () => void;
  onNodeUpdate: SaveCardBody;
  onNodeResized: (nodeId: string, bounds: CanvasBounds) => void;
  onSectionResized: (sectionId: string, bounds: CanvasBounds) => void;
  onSectionTitleChange: (sectionId: string, title: string) => Promise<unknown> | void;
  /** Take group frames off the board (their cards stay). Resolves to an undo that puts them back; null when none was there. */
  onRemoveSections: (sectionIds: string[]) => Promise<(() => Promise<unknown>) | null>;
  onNodeTitleChange: (nodeId: string, title: string) => void;
  /** 重設大小: drop the cards' own size. */
  onResetCardSize: (nodeIds: readonly string[]) => void;
  onOpenSubCanvas: (nodeId: string) => void;
  onToggleBranch: (nodeId: string) => void;
  onCenterBoard: (nodeId: string) => void;
  /** Open the card's note in the editor (the selection bar's 開啟). */
  onOpenCard: (nodeId: string) => void;
  onShowMoreChildren: (parentId: string) => void;
  /** Resolves to the arrow it drew, or null when none was drawn (already there, refused). */
  onConnect: (sourceId: string, targetId: string) => Promise<NodeEdge | null>;
  onParentConnect: (childId: string, parentId: string) => void;
  /** Resolves to the hand-drawn arrow it removed (so it can be put back), else null. */
  onEdgeDeleted: (edgeId: string) => Promise<NodeEdge | null>;
  /** Delete/Backspace: take these cards off the board (never trash their
   *  notes). Resolves to an undo, or null when nothing was removed. */
  onRemoveCards: (cardIds: string[]) => Promise<(() => Promise<unknown>) | null>;
  onNodeContextMenu: (nodeId: string, x: number, y: number) => void;
  onPaneContextMenu: (x: number, y: number, flowX: number, flowY: number) => void;
  /** Right-click on an arrow → open the edge context menu (delete / change type). */
  onEdgeContextMenu: (edgeId: string, edgeType: string, x: number, y: number) => void;
  onDoubleClickCanvas: (flowX: number, flowY: number) => void;
  onCreateSection: (x: number, y: number) => void;
};
