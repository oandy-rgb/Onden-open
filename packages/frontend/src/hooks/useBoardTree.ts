import { useCallback, useMemo, useRef, useState } from "react";
import { isTagBoard } from "../lib/nodeTags";
import type { Edge, Node } from "@xyflow/react";
import type { Canvas, CanvasData, CanvasNodeEntry, ContentNode, Tag } from "../lib/api";
import { boardTreePositions, computeBoardTree, pathFromRoot, TREE_CARD_BUDGET, toggleBranch, type TreeDepth, type TreeNoteEntry } from "../lib/boardTree";
import { cardLayoutHeight } from "../lib/cardDisplay";
import { effectiveTree, treeModeOf, type TreeMode } from "../lib/boardTreeSettings";
import { useMediaQuery, MOBILE_QUERY } from "./useIsMobile";
import { useBoardTreeSettings } from "./useBoardTreeSettings";
import { useBoardDisplaySettings } from "./useBoardDisplaySettings";

/** Where a parent line leaves its parent card (the right edge) and enters its
 *  child (the left edge); `step` draws it as a right-angled line. */
const TREE_EDGE = { sourceHandle: "r", targetHandle: "l" } as const;
const MORE_CARD_WIDTH = 160;
const MORE_CARD_HEIGHT = 44;

type Options = {
  activeCanvas: Canvas | null;
  nodes: readonly ContentNode[];
  tags: readonly Pick<Tag, "id">[] | undefined;
  /** The board is on screen (its lens or the editor-hosted board is open). */
  shown: boolean;
};

/**
 * The note board's "follow the sub-notes" tree (docs/architecture/canvas-as-view.md).
 *
 * In auto mode the board shows the stored cards plus the cards of the tree the
 * notes make (lib/boardTree), drawn as one board: `canvas` is that merge, so
 * the board's layout, parent lines, undo and grouping treat tree cards like
 * any other. A tree card the person dragged has a stored card and keeps that
 * place. Nothing is written until they choose something.
 */
export function useBoardTree({ activeCanvas, nodes, tags, shown }: Options) {
  const phone = useMediaQuery(MOBILE_QUERY);
  const isNoteBoard = !!activeCanvas && !isTagBoard({ tags }, activeCanvas.id) && nodes.some((node) => node.id === activeCanvas.id);
  const boardId = shown && isNoteBoard ? activeCanvas!.id : null;
  const { settings, save } = useBoardTreeSettings(boardId);
  const { depth, choices } = effectiveTree(settings);
  const { settings: display, save: saveDisplay } = useBoardDisplaySettings(activeCanvas?.id ?? null, boardId);

  // The first answer for an unset mode holds while the board is open: placing
  // a card on an empty board must not flip it to manual under the person.
  const firstMode = useRef(new Map<string, TreeMode>());
  let mode: TreeMode | null = null;
  if (boardId) {
    if (!settings.mode && !firstMode.current.has(boardId)) firstMode.current.set(boardId, treeModeOf(settings, activeCanvas!.data.nodes.length));
    mode = settings.mode ?? firstMode.current.get(boardId)!;
  }

  // 換中心: a browsing state, never stored. The path runs from the board's own
  // note to the note the tree is centred on; a note that is gone ends it there.
  const [centred, setCentred] = useState<{ boardId: string; ids: readonly string[] } | null>(null);
  const path = useMemo(() => {
    if (!boardId || centred?.boardId !== boardId) return [boardId].filter((id): id is string => id !== null);
    const live = centred.ids.findIndex((id) => !nodes.some((node) => node.id === id));
    return live < 0 ? centred.ids : centred.ids.slice(0, live);
  }, [boardId, centred, nodes]);
  const rootId = path.at(-1) ?? boardId;
  const recentered = !!boardId && rootId !== boardId;

  const [more, setMore] = useState<{ boardId: string; pages: ReadonlyMap<string, number> } | null>(null);
  const extraPages = more && more.boardId === boardId ? more.pages : undefined;

  const entries = useMemo(
    () => boardId && mode === "auto"
      ? computeBoardTree({ nodes, rootId: rootId!, depth, choices, extraPages, budget: phone ? TREE_CARD_BUDGET.phone : TREE_CARD_BUDGET.desktop })
      : [],
    // `choices` is rebuilt from the same stored arrays each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boardId, rootId, mode, nodes, depth, settings.open, settings.closed, extraPages, phone],
  );
  const noteEntries = useMemo(() => new Map(entries.flatMap((entry): Array<[string, TreeNoteEntry]> => entry.kind === "note" ? [[entry.id, entry]] : [])), [entries]);

  // Rows are spaced by what each card is drawn at: folded, expanded, or the person's own height.
  const storedCards = activeCanvas?.data.nodes;
  const heightOf = useCallback((id: string) => {
    if (!noteEntries.has(id)) return MORE_CARD_HEIGHT;
    const card = storedCards?.find((item) => item.nodeId === id);
    return cardLayoutHeight(display, { nodeId: id, height: card?.height, folded: card?.folded });
  }, [noteEntries, storedCards, display]);
  const positions = useMemo(() => boardTreePositions(entries, heightOf), [entries, heightOf]);

  const canvas = useMemo((): Canvas | null => {
    if (!activeCanvas || entries.length === 0) return activeCanvas;
    // Centred elsewhere, the board shows only that tree, in the tree's own places.
    if (recentered) {
      const cards: CanvasNodeEntry[] = entries.flatMap((entry) => entry.kind === "note" && positions.has(entry.id) ? [{ nodeId: entry.id, ...positions.get(entry.id)! }] : []);
      return { ...activeCanvas, data: { nodes: cards } };
    }
    const stored = new Set(activeCanvas.data.nodes.map((card) => card.nodeId));
    const added: CanvasNodeEntry[] = [];
    for (const entry of entries) {
      const at = positions.get(entry.id);
      if (entry.kind === "note" && at && !stored.has(entry.id)) added.push({ nodeId: entry.id, ...at });
    }
    return { ...activeCanvas, data: { ...activeCanvas.data, nodes: [...activeCanvas.data.nodes, ...added] } };
  }, [activeCanvas, entries, positions, recentered]);

  /** The board's cards and arrows with the tree's own parts added: each
   *  branch's fold control, the "+N" cards and their arrows. */
  const decorate = useCallback((displayNodes: Node[], displayEdges: Edge[]): { nodes: Node[]; edges: Edge[] } => {
    if (entries.length === 0) return { nodes: displayNodes, edges: displayEdges };
    const nodesOut = displayNodes.map((node) => {
      const entry = noteEntries.get(node.id);
      if (!entry) return node;
      const root = entry.level === 0;
      if (entry.childCount === 0) return { ...(recentered ? { ...node, draggable: false } : node), data: { ...node.data, treeRoot: root } };
      return { ...node, ...(recentered ? { draggable: false } : {}), data: { ...node.data, treeRoot: root, branch: { expanded: entry.expanded, below: entry.below } } };
    });
    // The tree grows to the right: a parent line leaves the note's right edge and
    // enters the sub-note's left edge at right angles; siblings share one trunk.
    const edgesOut = displayEdges.map((edge) => noteEntries.get(edge.target)?.parentId === edge.source && edge.id.startsWith("parent-")
      ? { ...edge, ...TREE_EDGE, data: { ...edge.data, step: true } }
      : edge);
    for (const entry of entries) {
      const at = positions.get(entry.id);
      if (entry.kind !== "more" || !at) continue;
      nodesOut.push({
        // Centred on the row a note card would take, so its arrow runs level.
        id: entry.id, type: "treeMore", position: { x: at.x, y: at.y }, draggable: false, selectable: false, zIndex: 10,
        data: { parentId: entry.parentId, remaining: entry.remaining }, style: { width: MORE_CARD_WIDTH },
      });
      edgesOut.push({
        id: `tree-${entry.id}`, source: entry.parentId, target: entry.id, ...TREE_EDGE, type: "smoothstep",
        selectable: false, focusable: false, interactionWidth: 0, data: { derived: true },
        style: { stroke: "var(--ac-line)", strokeWidth: 1.5, strokeDasharray: "5 3", pointerEvents: "none" },
      });
    }
    return { nodes: nodesOut, edges: edgesOut };
  }, [entries, positions, noteEntries, recentered]);

  const layout: CanvasData | undefined = canvas?.data;

  return {
    /** How cards are drawn on this board (folded or expanded), and the way to change it. */
    display,
    setDisplay: saveDisplay,
    /** The board shows its tree. */
    auto: mode === "auto",
    /** Auto mode and the note has no sub-notes: only the root card shows. */
    childless: mode === "auto" && entries.length === 1 && (entries[0] as TreeNoteEntry).childCount === 0,
    /** The settings can be changed: a note's board that is on screen. */
    editable: boardId !== null,
    mode,
    depth,
    /** Centred on a note other than the board's own: the tree is shown to look at, not to edit. */
    recentered,
    /** From the board's own note to the centre, for the way back. */
    path,
    canvas,
    layout,
    /** The card is a tree card exactly where and as the tree draws it: nothing
     *  of it needs storing, so a layout save leaves it out. */
    untouched: (card: CanvasNodeEntry) => {
      const at = positions.get(card.nodeId);
      return noteEntries.has(card.nodeId) && !!at && card.x === at.x && card.y === at.y
        && card.width == null && card.height == null && card.color == null && !card.folded && !card.subCanvasId;
    },
    decorate,
    /** 以此為中心: the tree is drawn from this note (one of the cards of the tree) down. */
    centerOn: (nodeId: string) => {
      if (!boardId || mode !== "auto" || !noteEntries.has(nodeId)) return;
      setCentred({ boardId, ids: pathFromRoot(nodes, boardId, nodeId) });
    },
    /** Back to the note at `index` of the path (0: the board's own). */
    backTo: (index: number) => { if (boardId) setCentred({ boardId, ids: path.slice(0, index + 1) }); },
    setDepth: (next: TreeDepth) => save({ ...settings, depth: next }),
    setMode: (next: TreeMode) => save({ ...settings, mode: next }),
    toggleBranch: (nodeId: string) => {
      const entry = noteEntries.get(nodeId);
      if (!entry) return;
      const { open, closed } = toggleBranch(choices, entry, depth);
      const { open: _open, closed: _closed, ...rest } = settings;
      save({ ...rest, ...(open.length ? { open } : {}), ...(closed.length ? { closed } : {}) });
    },
    showMore: (parentId: string) => {
      if (!boardId) return;
      const pages = new Map(extraPages);
      pages.set(parentId, (pages.get(parentId) ?? 0) + 1);
      setMore({ boardId, pages });
    },
    /** The first write that makes an empty board's tree the person's choice: an
     *  unset auto mode is stored, so a board with placed cards does not turn manual. */
    keepAuto: () => { if (mode === "auto" && !settings.mode) save({ ...settings, mode: "auto" }); },
  };
}
