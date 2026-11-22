import { useEffect, useMemo, useRef } from "react";
import { nodeNeedsBody, type CanvasData, type NodeEdge } from "../lib/api";
import { addToast, getActiveCanvas, getAppState, getNode, selectCanvases, setSelectedId, useAppSelector, useOnline, useSelectedId } from "../lib/appStore";
import { canDelete, DERIVED_ARROW_HINT, edgeRole, existingRelation } from "../lib/edgeKinds";
import { dataSync, runBackgroundWrite, backgroundWrite, canvasWriter, relationWriter, tagWriter, drafts, nodeActions, nodeMutations, noteWriter, placementRefusal } from "../lib/data";
import { clampNoteTitle, NODE_TITLE_MAX } from "@onden/markdown";
import type { BoardClipboardOps } from "./useBoardClipboard";
import { useCapabilities } from "../lib/capabilities";
import { serverErrorMessage } from "../lib/serverErrors";
import { boardSpaceId, splitStoredCards, tagBoardMemberIds } from "../lib/boardLayout";
import { requestCardTitleFocus } from "../lib/cardTitleFocus";
import { t } from "../lib/i18n";
import { nodeHasTag, isTagBoard } from "../lib/nodeTags";
import type { useAppData } from "../lib/useAppData";
import type { BoardActions, BoardView } from "./boardWorkspaceTypes";
import { useBoardTree } from "./useBoardTree";
import { useCanvasActions } from "./useCanvasActions";
import type { SaveCardBody } from "./useCardDraft";
import { useGraphLayout } from "./useGraphLayout";
import type { useGraphViewState } from "./useGraphViewState";
import { useLinkSuggestionsShown } from "./useModuleFilter";
import type { useNodeSelection } from "./useNodeSelection";
import { useStableCallback, useStableHandlers } from "./useStableCallback";
import type { useUiMode } from "./useUiMode";
import type { useWorkspaceFocus } from "./useWorkspaceFocus";
import { displayTitle } from "../lib/noteLabel";
import { nodeOf } from "../lib/nodeIndex";

/** A canvas card's body is one of its note's saves (ordered, merged from the
 *  text the card started from). */
const saveCardBody: SaveCardBody = (nodeId, content, { base, keepalive }) => drafts.saveBody(nodeId, content, base, { keepalive });

type Options = {
  ui: Pick<ReturnType<typeof useUiMode>, "mode" | "notesView" | "setNotesView">;
  focus: Pick<ReturnType<typeof useWorkspaceFocus>, "selectedNode" | "openBoardId" | "selectInWorkspace" | "settleCardRemoval" | "openNote">;
  menus: Pick<ReturnType<typeof useNodeSelection>, "canvasNavStack" | "setCanvasNavStack" | "setCtxMenu">;
  createNodeRaw: ReturnType<typeof useAppData>["createNode"];
  assignToGroup: typeof nodeActions.assignToGroup;
  refresh: () => Promise<void>;
  /** The board's view switches; they live in the shell because the keyboard shortcuts read the search box. */
  graphView: ReturnType<typeof useGraphViewState>;
};

/** What the shell's commands, shortcuts and context menu ask of the board (lib/boardController). */
export type BoardWorkspace = ReturnType<typeof useBoardWorkspace>;

/**
 * Everything the board (canvas / graph) view does: its view state, layout,
 * card writes, and the handlers it calls back with.
 *
 * A tag's canvas lens is a board whose cards are the tag's members: putting a
 * note on it tags the note, taking a card off untags it. Ordinary canvases
 * keep their own card lists.
 */
export function useBoardWorkspace({ ui, focus, menus, createNodeRaw, assignToGroup, refresh, graphView }: Options) {
  const { mode, notesView, setNotesView } = ui;
  const { selectedNode, openBoardId, selectInWorkspace, settleCardRemoval, openNote } = focus;
  const { canvasNavStack, setCanvasNavStack, setCtxMenu } = menus;
  const data = useAppSelector((s) => s.data);
  const online = useOnline();
  const { canEdit } = useCapabilities(online);
  const canvases = useAppSelector(selectCanvases);
  const activeCanvas = useAppSelector((s) => s.activeCanvas);
  const selectedId = useSelectedId();
  // Related-note suggestions show only with semantic search imported.
  const linkSuggestions = useLinkSuggestionsShown();

  // A note's board follows its sub-notes (docs/architecture/canvas-as-view.md):
  // the layout, the arrows, the undo and every card action below see the stored
  // cards and the tree's as one board.
  const boardShown = mode === "notes" && (notesView === "canvas" || (notesView === "editor" && !!openBoardId));
  const tree = useBoardTree({ activeCanvas, nodes: data.nodes, tags: data.tags, shown: boardShown });
  const boardCanvas = tree.canvas;

  const isTagBoardId = (boardId: string) => isTagBoard(getAppState().data, boardId);
  const tagNewMembers = (boardId: string, nodeIds: string[]) => {
    if (!isTagBoardId(boardId)) return;
    for (const nodeId of nodeIds) {
      const node = getNode(nodeId);
      if (node && !nodeHasTag(node, boardId)) runBackgroundWrite(tagWriter.apply(nodeId, boardId));
    }
  };
  // Centred on another note the board is for looking: nothing the person did there is kept.
  const refuseWhileRecentered = () => {
    addToast(t("Go back to the board's own centre to change it."), "info");
    return Promise.resolve();
  };
  const placeBoardNode = useStableCallback((boardId: string, nodeId: string, position?: { x: number; y: number }) => {
    if (tree.recentered) return refuseWhileRecentered();
    tagNewMembers(boardId, [nodeId]);
    tree.keepAuto();
    return canvasWriter.place(boardId, nodeId, position);
  });
  // The ONE way an existing note (picker, drop) joins a board: first the reminder when some of the
  // board's people cannot see it (lib/boardCardAudience), then the placement. New notes made on the
  // board are in its space already and use placeBoardNode directly.
  // Resolves to whether the card was placed (false: the person cancelled the reminder).
  const placeExistingNote = useStableCallback(async (boardId: string, nodeId: string, position?: { x: number; y: number }): Promise<boolean> => {
    if (tree.recentered) { await refuseWhileRecentered(); return false; }
    const { chooseNotesToPlace } = await import("../lib/boardCardAudience");
    const [go] = await chooseNotesToPlace(boardId, [nodeId]);
    if (!go) return false;
    await placeBoardNode(boardId, go, position);
    return true;
  });
  // The layout the actions build on is the board as drawn: the stored cards plus
  // the tree's. Only the cards the person changed are stored (see useBoardTree).
  const saveBoardData = useStableCallback((boardId: string, layout: CanvasData) => {
    if (tree.recentered) return refuseWhileRecentered();
    const board = getAppState().activeCanvas;
    const before = new Set((board?.id === boardId ? board.data.nodes : []).map((card) => card.nodeId));
    const stored = tree.auto ? { ...layout, nodes: layout.nodes.filter((card) => before.has(card.nodeId) || !tree.untouched(card)) } : layout;
    tagNewMembers(boardId, stored.nodes.map((card) => card.nodeId).filter((id) => !before.has(id)));
    if (stored.nodes.length > 0) tree.keepAuto();
    return canvasWriter.save(boardId, stored);
  });

  // The open board is a tag's canvas lens: no canvas tabs, and it follows the
  // tag's members as notes are tagged or untagged anywhere.
  useEffect(() => {
    canvasWriter.followList(canvases.map((canvas) => canvas.id));
  }, [canvases]);

  const tagBoardOpen = mode === "notes" && notesView === "canvas" && !!activeCanvas
    && isTagBoard(data, activeCanvas.id);
  const tagBoardMembers = tagBoardOpen && activeCanvas ? tagBoardMemberIds(data.nodes, activeCanvas.id).join(",") : "";
  useEffect(() => {
    if (tagBoardMembers) canvasWriter.reconcileTagBoard();
  }, [tagBoardMembers]);

  const laidOut = useGraphLayout({
    display: tree.display,
    nodes: data.nodes,
    edges: data.edges,
    activeCanvas: boardCanvas,
    mode,
    notesView,
    selectedNode,
    openBoardId,
    selectedId,
    graphLocalMode: graphView.graphLocalMode,
    canvasSearch: graphView.canvasSearch,
    showTagEdges: graphView.showTagEdges,
    showSuggestions: linkSuggestions,
    tags: data.tags,
  });
  const { decorate } = tree;
  const { nodes: displayGraphNodes, edges: displayGraphEdges } = useMemo(
    () => decorate(laidOut.displayGraphNodes, laidOut.displayGraphEdges),
    [decorate, laidOut.displayGraphNodes, laidOut.displayGraphEdges],
  );

  // A large workspace starts slim (lib/slimMode.ts: no bodies in memory) and only the selected note is
  // hydrated (BuilderWorkspace): every other card would show its title over an empty body, and a card whose
  // body is a bare URL could not be drawn as the page. Fetch the open board's missing bodies, one at a time.
  // Only while a board is really open: in tasks / timeline / graph or while the canvas still loads,
  // displayGraphNodes is every visible note, and hydrating those would be the whole workspace.
  // At most half the resident-body cap per board, each card tried once: syncEngine evicts the oldest
  // bodies beyond HYDRATED_BODY_CAP, and an evicted card must not count as "missing" again (endless loop).
  const boardReady = boardShown && !!activeCanvas;
  const cardsWithoutBody = useMemo(() => !boardReady ? "" : displayGraphNodes
    .filter((card) => card.type === "card" && nodeNeedsBody(getNode(card.id)))
    .slice(0, Math.floor(dataSync.HYDRATED_BODY_CAP / 2))
    .map((card) => card.id).join(","), [displayGraphNodes, boardReady]);
  const triedBodies = useRef<{ boardId: string; ids: Set<string> }>({ boardId: "", ids: new Set() });
  const boardIdForBodies = activeCanvas?.id ?? "";
  useEffect(() => {
    if (!cardsWithoutBody || !online) return;
    if (triedBodies.current.boardId !== boardIdForBodies) triedBodies.current = { boardId: boardIdForBodies, ids: new Set() };
    const tried = triedBodies.current.ids;
    let cancelled = false;
    void (async () => {
      for (const id of cardsWithoutBody.split(",")) {
        if (cancelled) return;
        if (tried.has(id) || !nodeNeedsBody(getNode(id))) continue;
        tried.add(id);
        await dataSync.hydrateNode(id).catch(() => {});
      }
    })();
    return () => { cancelled = true; };
  }, [cardsWithoutBody, online, boardIdForBodies]);

  // A2: canvas / graph card-manipulation handlers live in useCanvasActions.
  // Placement itself is owned by the shared canvas writer.
  const actions = useStableHandlers(useCanvasActions({
    data,
    online,
    selectedId,
    activeCanvas: boardCanvas,
    saveCanvasData: saveBoardData,
    placeCanvasNode: placeBoardNode,
    placeExistingNote,
    selectCanvas: canvasWriter.select,
    createCanvas: canvasWriter.create,
    setCanvasNavStack,
    display: tree.display,
  }));

  const explainTreeCards = () => addToast(t("This card follows a sub-note. To take it off, turn off “Follow sub-notes” in Display."), "info");
  const removeCanvasCard = useStableCallback(async (nodeId: string) => {
    const canvasId = activeCanvas?.id;
    if (canvasId && isTagBoardId(canvasId)) {
      // The card IS the membership; its placement is kept for re-tagging.
      await tagWriter.remove(nodeId, canvasId);
      return;
    }
    // A card the sub-note tree draws is not stored on the board: removing it would save nothing and the tree
    // would draw it again, so say how it goes away instead.
    const board = getActiveCanvas();
    if (tree.auto && board && board.id === canvasId && splitStoredCards(board.data.nodes, [nodeId]).fromTree.length) {
      explainTreeCards();
      return;
    }
    await actions.handleRemoveFromCanvas(nodeId);
    if (canvasId) settleCardRemoval(canvasId, nodeId);
  });

  /** Delete/Backspace on a board: the selected cards come off it in ONE layout
   *  save (their notes stay in the library). A tag's board has no such
   *  removal: its cards are the tag's members (KnowledgeWorkspace says so).
   *  Resolves to an undo that puts the cards back where they were. */
  const removeCanvasCards = useStableCallback(async (nodeIds: string[]) => {
    const canvas = getAppState().activeCanvas;
    if (!canvas || isTagBoardId(canvas.id)) return null;
    const ids = new Set(nodeIds);
    const removed = canvas.data.nodes.filter((card) => ids.has(card.nodeId));
    if (tree.auto && splitStoredCards(canvas.data.nodes, nodeIds).fromTree.length) explainTreeCards();
    if (!removed.length) return null;
    await saveBoardData(canvas.id, { ...canvas.data, nodes: canvas.data.nodes.filter((card) => !ids.has(card.nodeId)) });
    for (const card of removed) settleCardRemoval(canvas.id, card.nodeId);
    return () => {
      const now = getAppState().activeCanvas;
      if (now?.id !== canvas.id) {
        return Promise.all(removed.map((card) => canvasWriter.place(canvas.id, card.nodeId, { x: card.x, y: card.y, width: card.width })));
      }
      const present = new Set(now.data.nodes.map((card) => card.nodeId));
      return saveBoardData(canvas.id, { ...now.data, nodes: [...now.data.nodes, ...removed.filter((card) => !present.has(card.nodeId))] });
    };
  });

  /** Delete on a group frame: the frame goes, the cards inside stay. One layout save; resolves to an undo
   *  that puts the frames back as they were (a frame another device already re-added is left alone). */
  const removeSections = useStableCallback(async (sectionIds: string[]) => {
    const canvas = getActiveCanvas();
    if (!canvas) return null;
    const ids = new Set(sectionIds);
    const all = canvas.data.sections ?? [];
    const removed = all.filter((section) => ids.has(section.id));
    if (!removed.length) return null;
    await saveBoardData(canvas.id, { ...canvas.data, sections: all.filter((section) => !ids.has(section.id)) });
    return async () => {
      const now = getActiveCanvas();
      if (now?.id !== canvas.id) return;
      const present = new Set((now.data.sections ?? []).map((section) => section.id));
      await saveBoardData(canvas.id, { ...now.data, sections: [...(now.data.sections ?? []), ...removed.filter((section) => !present.has(section.id))] });
    };
  });

  const createCardAt = useStableCallback(async (flowX: number, flowY: number) => {
    const canvasId = activeCanvas?.id;
    // The note and placement retain their existing separate acknowledgements.
    // Never build a layout from the snapshot captured before note creation.
    // The double-click also selects text under the pointer; drop it so the
    // new card's title, not a stray word, is what the user types into.
    window.getSelection()?.removeAllRanges();
    const node = await createNodeRaw(t("New note"), "markdown", getAppState().data.nodes.length, null, boardSpaceId(getAppState().data.nodes, canvasId));
    if (!node) return;
    requestCardTitleFocus(node.id);
    if (canvasId) await placeBoardNode(canvasId, node.id, { x: flowX, y: flowY });
  });

  // H4 re-render hygiene: the board shell is memoized, so every handler keeps
  // ONE identity; bodies always call the LATEST closure.
  const onSelectNode = useStableCallback((id: string | null) => {
    selectInWorkspace(id);
    setCtxMenu(null);
  });
  const onGraphDrop = useStableCallback((e: React.DragEvent, flowPos: { x: number; y: number }) => runBackgroundWrite(actions.handleGraphDrop(e, flowPos)));
  // 「插入」 in the pen mode's toolbar: the same upload-and-place as a dropped
  // picture. Returns once the cards are placed (the toolbar shows it is busy
  // until then); failures are reported as for any background write.
  const onInsertImages = useStableCallback((files: File[], flowPos: { x: number; y: number }) => {
    const done = actions.dropImagesAsCards(files, flowPos);
    runBackgroundWrite(done);
    return done.catch(() => undefined);
  });
  // Drawing an arrow that is already there (most often: A's text has [[B]],
  // so A→B is drawn already) changes nothing; a second identical arrow would
  // stack on the first. The hint says why nothing appeared.
  const onConnect = useStableCallback(async (src: string, tgt: string): Promise<NodeEdge | null> => {
    if (src === tgt) return null;
    const existing = existingRelation(getAppState().data.edges, src, tgt, "knowledge_link");
    if (existing) {
      addToast(edgeRole(existing) === "derived"
        ? t("These cards are already linked: the note's [[link]] draws this arrow.")
        : t("These cards are already connected."), "info");
      return null;
    }
    const done = relationWriter.connect(src, tgt, "knowledge_link");
    runBackgroundWrite(done);
    // Resolves to the arrow now on the board, for the board's history; a refused write has none.
    return done.then(() => existingRelation(getAppState().data.edges, src, tgt, "knowledge_link") ?? null, () => null);
  });
  // A parent arrow is a move: the same placement rule as every other surface
  // (lib/data placementRefusal, D101). A place the note may not go is refused
  // here with the server's words, before any write.
  const onParentConnect = useStableCallback((childId: string, parentId: string) => {
    const { nodes } = getAppState().data;
    const child = getNode(childId);
    if (!child) return;
    const parent = getNode(parentId);
    const refusal = parent ? placementRefusal(parent, child, { nodes, canEdit }) : "parent_not_found";
    if (refusal) {
      addToast(serverErrorMessage(refusal, undefined), "error");
      return;
    }
    void assignToGroup(childId, parentId);
  });
  const onEdgeDeleted = useStableCallback(async (edgeId: string): Promise<NodeEdge | null> => {
    if (edgeId.startsWith("parent-")) {
      const nodeId = edgeId.slice("parent-".length);
      void assignToGroup(nodeId, null);
      return null;
    }
    const edge = getAppState().data.edges.find((e) => e.id === edgeId);
    if (edge && !canDelete(edge)) {
      addToast(t(DERIVED_ARROW_HINT), "info");
      return null;
    }
    const done = relationWriter.remove(edgeId);
    runBackgroundWrite(done);
    // Only a plain hand-drawn link can be drawn again by the board's undo.
    const restorable = edge?.edge_type === "knowledge_link" ? edge : null;
    return done.then(() => restorable, () => null);
  });
  // Pasting: every step is the board's own write (lib/data). A copy sits under the board's note,
  // as a card added there; a tag's board takes no pasted cards (its cards are the tag's members).
  const moveUnder = useStableCallback((nodeId: string, parentId: string) => assignToGroup(nodeId, parentId));
  const clipboardOps = useMemo((): BoardClipboardOps => {
    const parentOf = () => { const id = getAppState().activeCanvas?.id; return id && !isTagBoardId(id) ? id : null; };
    return {
      duplicateNote: async (nodeId) => {
        const source = getNode(nodeId);
        const copy = source ? (await noteWriter.duplicate(source).catch(() => null))?.node ?? null : null;
        const parent = parentOf();
        if (copy && parent && copy.parent_id !== parent) await moveUnder(copy.id, parent);
        return copy;
      },
      createNote: async (title, markdown) => {
        const parent = parentOf();
        const result = await noteWriter.create({ title: clampNoteTitle(title, NODE_TITLE_MAX), markdown, ...(parent ? { parent_id: parent } : {}) }).catch(() => null);
        return result?.node ?? null;
      },
      placeCard: (nodeId, at) => { const id = getAppState().activeCanvas?.id; return id ? placeBoardNode(id, nodeId, at) : Promise.resolve(); },
      connect: (source, target) => onConnect(source, target),
      removeCards: (nodeIds) => removeCanvasCards(nodeIds),
      trashNote: (nodeId) => nodeActions.delete(nodeId),
      untrashNote: (nodeId) => nodeMutations.undeleteNode(nodeId),
      insertImages: (files, at) => onInsertImages(files, at),
    };
  }, [moveUnder, placeBoardNode, onConnect, removeCanvasCards, onInsertImages]);
  const onNodeContextMenu = useStableCallback((nodeId: string, x: number, y: number) => {
    setSelectedId(nodeId);
    setCtxMenu({ kind: "graph-node", nodeId, x, y });
  });
  const onPaneContextMenu = useStableCallback((x: number, y: number, flowX: number, flowY: number) => {
    setCtxMenu({ kind: "graph-canvas", x, y, flowX, flowY });
  });
  const onEdgeContextMenu = useStableCallback((edgeId: string, edgeType: string, x: number, y: number) => {
    setCtxMenu({ kind: "graph-edge", edgeId, edgeType, x, y });
  });
  const onToggleTagEdges = useStableCallback(() => graphView.setShowTagEdges((v) => !v));
  const onImportCanvas = useStableCallback(async (title: string, raw: unknown) => {
    const id = await actions.importJsonCanvas(title, raw);
    // canvas-as-node: the new board's NODE row isn't in the store until a
    // bootstrap refresh — navigate after it, or selection falls back to the
    // day note.
    if (id) { await refresh(); setSelectedId(id); setNotesView("editor"); }
    return id;
  });
  const hasParentCanvas = canvasNavStack.length > 0;
  const onBackToParentCanvas = useMemo(
    () => hasParentCanvas ? () => runBackgroundWrite(actions.goBackToParentCanvas()) : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- goBackToParentCanvas is a stable wrapper
    [hasParentCanvas],
  );
  const parentCanvasTitle = useMemo(() => {
    const id = canvasNavStack[canvasNavStack.length - 1];
    if (!id) return undefined;
    return canvases.find((c) => c.id === id)?.title;
  }, [canvasNavStack, canvases]);

  // H4 re-render hygiene: the board shell and its cards are memoized, so
  // every handler is wrapped ONCE here (bodies call the latest closure) and
  // the view object changes only when a value in it does.
  const boardActions = useStableHandlers({
    onSelectNode,
    onGraphDrop,
    onInsertImages,
    onAddToCanvas: actions.addToActiveCanvas,
    onApplyPositions: actions.applyCanvasPositions,
    onTidyCanvas: () => runBackgroundWrite(actions.tidyActiveCanvas()),
    onGroupSelection: (ids: string[]) => runBackgroundWrite(actions.groupCardsIntoSection(ids)),
    onSetNodesColor: (ids: string[], color: string | null) => runBackgroundWrite(actions.handleSetNodesColor(ids, color)),
    onArrangeTree: () => runBackgroundWrite(actions.autoArrangeCanvasAsTree()),
    onImportCanvas,
    onToggleTagEdges,
    onNodeUpdate: saveCardBody,
    onNodeResized: backgroundWrite(actions.handleNodeResized),
    onSectionResized: backgroundWrite(actions.handleSectionResized),
    onSectionTitleChange: actions.handleSectionTitleChange,
    onRemoveSections: removeSections,
    onNodeTitleChange: backgroundWrite(actions.handleNodeTitleChange),
    onResetCardSize: backgroundWrite(actions.handleCardSizeReset),
    onOpenSubCanvas: backgroundWrite(actions.handleOpenSubCanvas),
    onConnect,
    onParentConnect,
    onEdgeDeleted,
    onRemoveCards: removeCanvasCards,
    onCreateSection: backgroundWrite(actions.handleCreateSection),
    onNodeContextMenu,
    onPaneContextMenu,
    onEdgeContextMenu,
    onDoubleClickCanvas: backgroundWrite(createCardAt),
    onToggleBranch: tree.toggleBranch,
    onCenterBoard: tree.centerOn,
    onOpenCard: (nodeId: string) => openNote(nodeId, { content: true }),
    onShowMoreChildren: tree.showMore,
  }) satisfies BoardActions;
  const displayControls = useStableHandlers({ set: tree.setDisplay });
  const treeSettings = useStableHandlers({ setMode: tree.setMode, setDepth: tree.setDepth, backTo: tree.backTo });

  const { graphLocalMode, setGraphLocalMode, showTagEdges, parentMode, setParentMode, canvasSearch, setCanvasSearch } = graphView;
  const { editable: treeEditable, mode: treeMode, depth: treeDepth, childless: treeChildless, layout, path: treePath, recentered } = tree;
  const { nodes: allNodes } = data;
  const crumbs = useMemo(
    () => recentered ? treePath.map((id) => ({ id, title: displayTitle(nodeOf({ nodes: allNodes }, id)?.title) })) : [],
    [recentered, treePath, allNodes],
  );
  const board = useMemo((): BoardView => ({
    tagBoard: tagBoardOpen,
    layout,
    display: { settings: tree.display, set: displayControls.set },
    tree: treeEditable && treeMode ? { mode: treeMode, depth: treeDepth, childless: treeChildless, crumbs, ...treeSettings } : undefined,
    inkEnabled: !tagBoardOpen,
    clipboardOps,
    parentCanvasTitle,
    onBackToParentCanvas,
    graphLocalMode, setGraphLocalMode,
    showTagEdges,
    parentMode, setParentMode,
    displayGraphNodes, displayGraphEdges,
    canvasSearch, setCanvasSearch,
  }), [tagBoardOpen, clipboardOps, layout, tree.display, displayControls, treeEditable, treeMode, treeDepth, treeChildless, crumbs, treeSettings, parentCanvasTitle, onBackToParentCanvas, graphLocalMode, setGraphLocalMode,
    showTagEdges, parentMode, setParentMode, displayGraphNodes, displayGraphEdges, canvasSearch, setCanvasSearch]);

  return {
    board,
    actions: boardActions,
    /** Place a note on a board (tagging it, on a tag's board). */
    placeBoardNode,
    /** 以此為中心: the board's tree from this card down; absent where the board has no tree. */
    centerBoardOn: tree.auto ? tree.centerOn : undefined,
    removeCanvasCard,
    createCardAt,
    tidyActiveCanvas: actions.tidyActiveCanvas,
    autoArrangeCanvasAsTree: actions.autoArrangeCanvasAsTree,
    setNodeColor: actions.handleSetNodeColor,
  };
}
