import {
  ReactFlow,
  Background,
  BackgroundVariant,
  MiniMap,
  NodeToolbar,
  Position,
  ConnectionMode,
  BaseEdge,
  getBezierPath,
  getSmoothStepPath,
  MarkerType,
  type Node,
  type NodeChange,
  type EdgeChange,
  type FitViewOptions,
  type Edge,
  type EdgeProps,
  type NodeMouseHandler,
  type OnNodeDrag,
  type OnConnect,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./KnowledgeWorkspace.css";
import "./CanvasMode.css";
import "./OverviewEditor.css";
import {
  FilePlus2,
  AlignStartVertical, AlignCenterVertical, AlignEndVertical,
  AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal, Columns3, Rows3,
  Group, X, ChevronDown, ChevronRight,
} from "lucide-react";
import BoardToolbar from "./BoardToolbar";
import BoardSelectionBar from "./BoardSelectionBar";
import BoardViewMenu from "./BoardViewMenu";
import BoardCornerControls from "./BoardCornerControls";
import CardColorSwatches from "./CardColorSwatches";
import { useBoardFullscreen } from "../hooks/useBoardFullscreen";
import { useBoardPhoneNav } from "./BoardPhoneNav";
import { INK_COLORS } from "./InkToolbar";
import { INK_SIZES } from "../lib/inkSizes";
import { useInkPen } from "../hooks/useInkPen";
import { t, tn } from "../lib/i18n";
import { useCanvasTools } from "../hooks/useCanvasTools";
import { memo, useState, useMemo, useEffect, useCallback, useRef, Suspense } from "react";
import { lazyWithReload } from "../lib/lazyWithReload";
import { addToast, useAppSelector, useSelectedId, useAllNodes } from "../lib/appStore";
import { useCanvasUndo } from "../hooks/useCanvasUndo";
import { useBoardClipboard } from "../hooks/useBoardClipboard";
import { useBoardTouchGestures } from "../hooks/useBoardTouchGestures";
import { useCanvasExport } from "../hooks/useCanvasExport";
import { runBackgroundWrite, importCanvasFile, writeErrors } from "../lib/data";
import { captureCanvasPositions, type CanvasPositions } from "../lib/sectionCarry";
import { heldMoves, holdCardsAt, releaseCards } from "../lib/cardLift";
import { pressedOnScreen } from "../lib/ink";
import { useBoardCamera } from "../hooks/useBoardCamera";
import { alignCanvasCards, type CanvasAlignment } from "../lib/canvasAlignment";
import { layoutSectionHeadings } from "../lib/sectionHeadings";
import { GraphCallbacksContext } from "./graphCallbacks";
import { CardNode } from "./CardNode";
import { SectionNode } from "./SectionNode";
import { TreeMoreNode } from "./TreeMoreNode";
import { showsTitleOnly, withCardsFolded } from "../lib/cardDisplay";
import type { CanvasInkHandle } from "./CanvasInkLayer";
import CanvasNotePicker from "./CanvasNotePicker";
import { classNames } from "../lib/utils";
import { PREFS, usePersistedFlag } from "../lib/prefs";
import { minimapNodeColor, minimapNodeStroke } from "../lib/canvasMinimap";
import { isImeComposing } from "../lib/keys";
import { canDelete, canRetype, DERIVED_ARROW_HINT, FALLBACK_EDGE_COLOR } from "../lib/edgeKinds";
import { COARSE_POINTER_QUERY, isMobileLayout, useIsMobile, useMediaQuery } from "../hooks/useIsMobile";
import { useStableCallback } from "../hooks/useStableCallback";
import { Button, Pressable, FileInput, SearchField } from "./ui";
import { isBody } from "../lib/documentAccess";
import { onWindow } from "../lib/globalEvents";

// Ink-over-canvas: lazy so the React Flow board never pays for the ink engine
// until a named canvas is open.
const CanvasInkLayer = lazyWithReload(() => import("./CanvasInkLayer"));

/** A key press that belongs to text entry (a field, a card's CodeMirror, an
 *  IME candidate), not to the board's selection. */
function typingKey(e: KeyboardEvent): boolean {
  const el = e.target instanceof HTMLElement ? e.target : null;
  return isImeComposing(e) || !!el && (el.isContentEditable || !!el.closest("input, textarea, select, .cm-editor"));
}

/** What a selected arrow allows here. A parent line unparents and has no
 *  type; a stored edge follows its role (lib/edgeRoles, D74: an arrow derived
 *  from a [[link]] lives in the note's text, and the server
 *  refuses to delete it with 409 derived_edge); a tag hint is never
 *  selectable, so it allows nothing. */
/** Applies React Flow "select" changes to a controlled id list; returns the same array when nothing changed. */
function applySelectChanges(previous: string[], changes: { id: string; selected: boolean }[]): string[] {
  const next = new Set(previous);
  for (const change of changes) {
    if (change.selected) next.add(change.id);
    else next.delete(change.id);
  }
  return next.size === previous.length && previous.every(id => next.has(id)) ? previous : [...next];
}

function arrowRules(edge: Edge): { delete: boolean; retype: boolean } {
  if (edge.type === "parentEdge") return { delete: true, retype: false };
  const data = edge.data as { derived?: boolean; edgeType?: string; status?: string; origin?: string | null } | undefined;
  if (data?.derived) return { delete: false, retype: false };
  const facts = { edge_type: data?.edgeType ?? "knowledge_link", status: data?.status ?? "active", origin: data?.origin };
  return { delete: canDelete(facts), retype: canRetype(facts) };
}

/** How long a phone shows the "no sub-notes yet" hint (the stylesheet fades it out over its last 0.4s). */
const CHILDLESS_NOTE_MS = 5000;

/** Fitting the board leaves room for what floats over it — the buttons across
 *  the top, the tool bar along the bottom (and the minimap in the corner; a phone has none) — so
 *  no card starts out hidden underneath. */
function fitPadding(minimap: boolean): NonNullable<FitViewOptions["padding"]> {
  const phone = isMobileLayout();
  return phone
    ? { top: "64px", x: "16px", bottom: "96px" }
    : { top: "64px", x: "24px", bottom: minimap ? "184px" : "96px" };
}

export type { BoardView, BoardActions } from "../hooks/boardWorkspaceTypes";
import type { BoardView, BoardActions } from "../hooks/boardWorkspaceTypes";
import type { NodeEdge } from "../lib/api";

export type KnowledgeWorkspaceProps = {
  board: BoardView;
  actions: BoardActions;
  mobileView: string;
  /** The board is the screen being shown (a phone's Info screen or note list hides it). */
  onScreen?: boolean;
  onClickWikilink: (target: string, fromId: string) => void;
};

function ParentEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, data }: EdgeProps) {
  // The sub-note tree draws its parent lines at right angles (useBoardTree sets `step`).
  if ((data as { step?: boolean } | undefined)?.step) {
    const [stepPath] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 8 });
    // eslint-disable-next-line onden/restrict-inline-style -- React Flow edge `style` prop pass-through
    return <BaseEdge id={id} path={stepPath} style={style} />;
  }
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const OFFSET = 7;
  const ox = (-dy / len) * OFFSET;
  const oy = (dx / len) * OFFSET;
  const [path] = getBezierPath({
    sourceX: sourceX + ox, sourceY: sourceY + oy, sourcePosition,
    targetX: targetX + ox, targetY: targetY + oy, targetPosition,
  });
  // eslint-disable-next-line onden/restrict-inline-style -- React Flow edge `style` prop pass-through
  return <BaseEdge id={id} path={path} style={style} />;
}

/** The board's grid (px) when “snap to grid” is on. */
const SNAP_GRID = 20;
const NODE_TYPES = { card: CardNode, section: SectionNode, treeMore: TreeMoreNode };
const EDGE_TYPES = { parentEdge: ParentEdge };

function KnowledgeWorkspace({
  board, actions,
  mobileView, onScreen = true,
  onClickWikilink,
}: KnowledgeWorkspaceProps) {
  const {
    inkEnabled = true, tagBoard = false, tree, display, clipboardOps,
    parentCanvasTitle, onBackToParentCanvas,
    graphLocalMode, setGraphLocalMode, showTagEdges, parentMode, setParentMode,
    displayGraphNodes, displayGraphEdges,
    canvasSearch, setCanvasSearch,
  } = board;
  const {
    onAddToCanvas, onApplyPositions, onImportCanvas,
    onTidyCanvas, onArrangeTree, onGroupSelection, onSetNodesColor, onSelectNode,
    onGraphDrop, onInsertImages, onToggleTagEdges,
    onNodeUpdate, onNodeResized, onSectionResized, onSectionTitleChange, onRemoveSections, onNodeTitleChange,
    onResetCardSize, onOpenSubCanvas, onToggleBranch, onShowMoreChildren, onCenterBoard, onOpenCard,
    onConnect, onParentConnect, onEdgeDeleted, onRemoveCards,
    onNodeContextMenu, onPaneContextMenu, onEdgeContextMenu,
    onDoubleClickCanvas, onCreateSection,
  } = actions;
  // H4: data/selection/canvas-list state comes from the app store — the
  // ~50-prop interface shrank to handlers + local UI state.
  const nodes = useAllNodes();
  const selectedNodeId = useSelectedId();
  const activeCanvasId = useAppSelector((st) => st.activeCanvas?.id ?? null);
  const storedData = useAppSelector((st) => st.activeCanvas?.data);
  const canvasData = board.layout ?? storedData;
  const { exportBoard, isExporting } = useCanvasExport();
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance | null>(null);
  // The pen in hand (tool, colour, thickness) is the shared one every ink host keeps.
  const pen = useInkPen({ color: INK_COLORS[0].value, sizeId: INK_SIZES[1].id });
  const { tool: canvasMode, setTool: setCanvasMode, startPen, spaceHeld } = useCanvasTools({ boardId: activeCanvasId, inkEnabled, onPenTool: pen.setTool });
  const phone = useIsMobile();
  // A finger is the main input: the board moves with one finger and zooms with two, so it has no − / + buttons.
  const touchPrimary = useMediaQuery(COARSE_POINTER_QUERY);
  // A phone's board is full screen for good — when the notes home gave it the ‹ and title sheet to leave by (BoardPhoneNav).
  const phoneNav = useBoardPhoneNav();
  const alwaysFullscreen = phone && !!phoneNav;
  const { fullscreen, toggle: toggleFullscreen } = useBoardFullscreen({ toolIsSelect: canvasMode === "select", onScreen: (!phone || onScreen) && !!activeCanvasId, always: alwaysFullscreen });
  // Soft cap: a board past ~150 cards gets heavy (profiled: load grows with
  // card count; the real remedy is splitting into sub-canvases, which is free
  // here since each sub-canvas is its own independently-loaded board). Passive,
  // dismissible nudge — never blocks.
  const [capDismissed, setCapDismissed] = useState(false);
  const CARD_SOFT_CAP = 150;
  const [snapToGrid, setSnapToGrid] = useState(false);
  // Bird's-eye MiniMap toggle — the cheap navigation aid for sprawling boards
  // ([[canvas-scale]]). Persisted across reloads.
  const [minimapPref, setMinimapShown] = usePersistedFlag(PREFS.canvasMinimap, false);
  // The minimap is for a wide board: a phone has no room for it (the 「顯示」 sheet leaves its switch out).
  const minimapShown = minimapPref && !phone;
  // Add-existing-note picker (toolbar) — query over workspace notes minus
  // what's already on the board.
  const [addCanvasId, setAddCanvasId] = useState<string | null>(null);
  const addOpen = !!activeCanvasId && addCanvasId === activeCanvasId;
  const addButtonRef = useRef<HTMLButtonElement>(null);
  function closeAddPicker() { setAddCanvasId(null); addButtonRef.current?.focus(); }
  useEffect(() => { setAddCanvasId(null); }, [activeCanvasId]);
  // React Flow selection includes group frames; card-only actions exclude them.
  const [selectionIds, setSelectionIds] = useState<string[]>([]);
  // The selection as it was when the pointer went down on the board (handleNodeClick).
  const selectionAtPress = useRef<string[] | null>(null);
  const multiSel = useMemo(() => selectionIds.filter(id => displayGraphNodes.some(n => n.id === id && n.type === "card")), [selectionIds, displayGraphNodes]);
  useEffect(() => { setSelectionIds([]); setHeldPositions(new Map()); }, [activeCanvasId]);
  // Controlled nodes must retain React Flow's DOM measurements. Otherwise
  // its MiniMap sees dimensionless user nodes, even though the cards render.
  // Measurements are local display state; only the resize/drag callbacks save
  // canvas geometry (zoom and fold state never do).
  const [measurements, setMeasurements] = useState<{
    canvasId: string | null;
    sizes: Map<string, { width: number; height: number }>;
  }>({ canvasId: activeCanvasId, sizes: new Map() });
  // Where the held cards are right now. The nodes are controlled (their positions come from the saved layout),
  // so React Flow only reports a moving card and leaves drawing it to us; the layout is written once, on drop
  // (handleNodeDragStop), and these display positions go away when that write has settled.
  const [heldPositions, setHeldPositions] = useState<ReadonlyMap<string, { x: number; y: number }>>(new Map());
  const handleNodeChanges = useCallback((changes: NodeChange[]) => {
    const moves = heldMoves(changes);
    if (moves.length) setHeldPositions(previous => {
      const next = new Map(previous);
      for (const move of moves) next.set(move.id, move.position!);
      return next;
    });
    // Controlled selection must accept deselection as well as selection.
    // Observing onSelectionChange alone reads the old controlled flags back.
    const selection = changes.filter(change => change.type === "select");
    if (selection.length) setSelectionIds(previous => applySelectChanges(previous, selection));
    const dimensions = changes.filter(change => change.type === "dimensions" && change.dimensions);
    if (!dimensions.length) return;
    setMeasurements(previous => {
      const sizes = previous.canvasId === activeCanvasId ? previous.sizes : new Map();
      let next = sizes;
      for (const change of dimensions) {
        if (change.type !== "dimensions" || !change.dimensions) continue;
        const old = sizes.get(change.id);
        if (old?.width === change.dimensions.width && old?.height === change.dimensions.height) continue;
        if (next === sizes) next = new Map(sizes);
        next.set(change.id, change.dimensions);
      }
      return next === previous.sizes ? previous : { canvasId: activeCanvasId, sizes: next };
    });
  }, [activeCanvasId]);
  // Reading focus can highlight one card; React Flow owns the explicit
  // selection changes, including groups and cancelling a box selection.
  const [headingZoom, setHeadingZoom] = useState(1);
  const sectionHeadings = useMemo(() => layoutSectionHeadings(displayGraphNodes
    .filter(n => n.type === "section")
    .map(n => ({ id: n.id, x: n.position.x, y: n.position.y, width: typeof n.style?.width === "number" ? n.style.width : 400 })), headingZoom),
  [displayGraphNodes, headingZoom]);
  // The hand tool only moves the board: a card (or frame) under it stays put, whatever
  // the card says about itself (a per-node `draggable` beats the flow's `nodesDraggable`).
  const handTool = canvasMode === "hand";
  const settledNodes = useMemo(
    () => displayGraphNodes.map(n => handTool ? { ...n, draggable: false } : n).map(n => {
      const selected = !!n.selected || selectionIds.includes(n.id);
      const measured = measurements.canvasId === activeCanvasId ? measurements.sizes.get(n.id) : undefined;
      if (n.type !== "card") return { ...n, selected, measured,
        data: n.type === "section" ? { ...n.data, heading: sectionHeadings.get(n.id) } : n.data };
      // A card with no saved height grows with its note up to the body limit
      // (CardNode.css); a height the user resized to is kept as it is. A
      // folded card has the title bar's height (set where the node is built).
      const autoHeight = !n.data.folded && typeof n.style?.height !== "number";
      return { ...n, measured, selected, data: { ...n.data, autoHeight },
        className: classNames(n.className, autoHeight && "graph-card-node--auto-height") };
    }),
    [displayGraphNodes, selectionIds, measurements, activeCanvasId, sectionHeadings, handTool],
  );
  // Only the cards being held get a new object per move; every other node keeps its identity.
  const flowNodes = useMemo(
    () => heldPositions.size ? settledNodes.map(n => heldPositions.has(n.id) ? { ...n, position: heldPositions.get(n.id)! } : n) : settledNodes,
    [settledNodes, heldPositions],
  );
  const focusedCardId = displayGraphNodes.some(n => n.type === "card" && n.id === selectedNodeId)
    ? selectedNodeId : null;
  const focusedBranch = focusedCardId
    ? (displayGraphNodes.find(n => n.id === focusedCardId)?.data.branch as { expanded: boolean } | undefined)
    : undefined;
  // GAP-174: arrows are selectable. The edges are controlled, so React Flow's
  // select changes are kept here (without onEdgesChange a click selected
  // nothing and Delete never had an arrow to delete). Selected arrows draw
  // thicker, with a halo (KnowledgeWorkspace.css).
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);
  useEffect(() => { setSelectedEdgeIds([]); }, [activeCanvasId]);
  const handleEdgeChanges = useCallback((changes: EdgeChange[]) => {
    const selection = changes.filter(change => change.type === "select");
    if (!selection.length) return;
    setSelectedEdgeIds(previous => applySelectChanges(previous, selection));
  }, []);
  const flowEdges = useMemo(() => {
    const shown = displayGraphEdges;
    if (!selectedEdgeIds.length) return shown;
    return shown.map(e => selectedEdgeIds.includes(e.id) && e.selectable !== false
      ? { ...e, selected: true, zIndex: 10, style: { ...e.style, strokeWidth: 3, opacity: 1 } }
      : e);
  }, [displayGraphEdges, selectedEdgeIds]);
  /** The selected arrows that are on the board now (a deleted one drops out). */
  const selectedEdges = useMemo(() => flowEdges.filter(e => e.selected), [flowEdges]);
  /** An arrow is the subject (its toolbar shows, Delete deletes it) unless
   *  cards are selected too. */
  const edgeFocus = selectedEdges.length > 0 && multiSel.length === 0;

  const canvasSearchRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const [canvasWrapEl, setCanvasWrapEl] = useState<HTMLDivElement | null>(null);
  const setCanvasWrap = useCallback((el: HTMLDivElement | null) => { canvasWrapRef.current = el; setCanvasWrapEl(el); }, []);
  const dropCount = useRef(0);
  const dragRef = useRef<{ canvasId: string | null; origin: { x: number; y: number }; before: CanvasPositions } | null>(null);

  const camera = useBoardCamera({
    rfInstance, boardId: activeCanvasId, selectedNodeId,
    displayNodes: displayGraphNodes, wrapRef: canvasWrapRef,
    fitOptions: { padding: fitPadding(minimapShown) },
  });
  const { onNodeEditStart } = camera;

  // Fold state is the board's display settings (lib/cardDisplay); a card the
  // person never chose for follows the board default.
  const boardCards = canvasData?.nodes;
  /** The cards, as drawn now, are all folded (the node's data carries the resolved state). */
  const allFolded = (ids: readonly string[]) => ids.length > 0 && ids.every((id) => !!displayGraphNodes.find((n) => n.id === id)?.data.folded);
  const cardsByIds = (ids: readonly string[]) => (boardCards ?? []).filter((card) => ids.includes(card.nodeId));
  const setCardsFolded = useStableCallback((ids: readonly string[], folded: boolean) => display.set(withCardsFolded(display.settings, ids, folded)));
  const onSetFolded = useStableCallback((nodeId: string, folded: boolean) => setCardsFolded([nodeId], folded));
  /** Some of these cards have a size of their own (the bar then offers 「重設大小」). */
  const hasOwnSize = (ids: readonly string[]) => cardsByIds(ids).some((card) => card.width != null || card.height != null);
  const farTitles = showsTitleOnly(headingZoom, display.settings);

  // Delete on a group frame, or its own 「刪除群組框」 button (the only way on a phone): the frame goes and its
  // cards stay, as one step of the board's history; the toast's Undo and ⌘Z share one state.
  const removeSections = useStableCallback(async (sectionIds: string[]) => {
    try {
      let undo = await onRemoveSections(sectionIds);
      if (!undo) return;
      setSelectionIds((ids) => ids.filter((id) => !sectionIds.some((sectionId) => id === `section-${sectionId}`)));
      let removed = true;
      history.push({
        undo: async () => { if (!removed) return false; await undo!(); removed = false; return true; },
        redo: async () => {
          if (removed) return false;
          const again = await onRemoveSections(sectionIds);
          if (!again) return false;
          undo = again; removed = true;
          return true;
        },
      });
      addToast(t("Removed the group frame. The cards stay on the board."), "info",
        { label: t("Undo"), onClick: () => runBackgroundWrite((async () => { if (!removed) return; await undo!(); removed = false; })()) });
    } catch (error) {
      writeErrors.report(error, addToast);
    }
  });
  const onSectionRemove = useStableCallback((sectionId: string) => { void removeSections([sectionId]); });

  const callbacks = useMemo(
    () => ({
      onNodeUpdate,
      onNodeEditStart,
      onNodeResized,
      onSectionResized,
      onSectionTitleChange,
      onSectionRemove,
      onNodeTitleChange,
      onClickWikilink,
      onSetFolded,
      onFocusCard: camera.focusCard,
      onOpenCard,
      onOpenSubCanvas,
      onToggleBranch,
      onShowMoreChildren,
    }),
    [
      onToggleBranch,
      onShowMoreChildren,
      onNodeEditStart,
      onNodeUpdate,
      onNodeResized,
      onSectionResized,
      onSectionTitleChange,
      onSectionRemove,
      onNodeTitleChange,
      onClickWikilink,
      onSetFolded,
      camera.focusCard,
      onOpenCard,
      onOpenSubCanvas,
    ],
  );

  // Drawing or deleting a plain link is a step of the board's history: undo takes
  // it back (or draws it again), redo repeats it. The arrow gets a new id when drawn again.
  const arrowStep = (edge: NodeEdge, first: "draw" | "remove") => {
    let current = edge;
    const draw = async () => { const drawn = await onConnect(current.source_node_id, current.target_node_id); if (drawn) current = drawn; return !!drawn; };
    const remove = async () => !!(await onEdgeDeleted(current.id));
    history.push(first === "draw" ? { undo: remove, redo: draw } : { undo: draw, redo: remove });
  };
  const handleConnect: OnConnect = ({ source, target }) => {
    if (!source || !target || source === target) return;
    if (parentMode) onParentConnect(target, source); // target becomes child of source
    else void Promise.resolve(onConnect(source, target)).then((edge) => { if (edge) arrowStep(edge, "draw"); });
  };

  const handleNodeClick: NodeMouseHandler = (event, node) => {
    if (node.type === "section") return;
    // Opening a card means the pending “add card/frame” tool was not what the tap was for; it must not
    // wait for the next tap on the board to add something.
    if (canvasMode === "card" || canvasMode === "section") setCanvasMode("select");
    if (!inkCards.current.has(node.id)) inkRef.current?.clearSelection();
    const extending = event.metaKey || event.ctrlKey || event.shiftKey;
    // A plain click replaces selection. Persisting the old multi-selection
    // here made ordinary browsing accumulate cards and expose the align bar.
    // ⌘/Ctrl/Shift-click adds the card or takes it out, from the selection as
    // it was before this click: React Flow only multi-selects once it has
    // seen the key go down (and on Linux not for Ctrl), so a quick ⌘-click
    // used to drop the cards already picked. "Before" is the selection at
    // pointer-down: on a card's body (not its nodrag title) React Flow selects
    // the card at mousedown and the board re-renders before the click, so the
    // current selection already holds it and toggling took it straight out.
    const before = selectionAtPress.current ?? selectionIds;
    selectionAtPress.current = null;
    if (!extending) setSelectionIds([node.id]);
    else setSelectionIds(before.includes(node.id)
      ? before.filter((id) => id !== node.id)
      : [...before, node.id]);
    // The card was clicked where it is, so the camera stays (see useBoardCamera).
    camera.cardClicked(node);
    onSelectNode(node.id);
  };

  // Capture each gesture for local move undo. A section and its original
  // members restore in one accepted layout write, independently of event history.
  const canvasUndo = useCanvasUndo({
    canvasId: activeCanvasId,
    layout: canvasData,
    onRestorePositions: onApplyPositions,
    onSkipped: (count) => addToast(t("{count} item(s) were moved again since, so undo left them where they are.", { count }), "info"),
  });

  const handleNodeDragStart: OnNodeDrag = (event, node, dragged) => {
    camera.stopGlide();
    const cards = dragged.filter(n => n.type === "card");
    holdCardsAt(canvasWrapRef.current, event, cards.map(n => n.id));
    const sections = dragged.filter(n => n.type === "section");
    dragRef.current = {
      canvasId: activeCanvasId,
      origin: { ...node.position },
      before: captureCanvasPositions(canvasData ?? {
        nodes: cards.map(n => ({ nodeId: n.id, ...n.position })),
      }, cards.map(n => n.id), sections.map(n => n.data.sectionId as string), display.settings),
    };
  };

  const history = canvasUndo.history;
  // The ink on the board, selected together with the cards by one drag-select.
  const inkRef = useRef<CanvasInkHandle>(null);
  const [inkSelected, setInkSelected] = useState(false);
  const selectionDrag = useRef<{ x: number; y: number } | null>(null);
  // The cards that were selected with the ink: only dragging one of them takes the ink along.
  const inkCards = useRef<Set<string>>(new Set());
  const multiSelRef = useRef(multiSel);
  multiSelRef.current = multiSel;
  const handleSelectionStart = (e: React.MouseEvent) => { selectionDrag.current = { x: e.clientX, y: e.clientY }; };
  const handleSelectionEnd = (e: React.MouseEvent) => {
    const from = selectionDrag.current;
    selectionDrag.current = null;
    if (!from || !rfInstance) return;
    // A click that dragged nowhere selects nothing.
    if (Math.abs(e.clientX - from.x) < 3 && Math.abs(e.clientY - from.y) < 3) { inkRef.current?.clearSelection(); return; }
    const a = rfInstance.screenToFlowPosition(from);
    const b = rfInstance.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    inkCards.current = new Set(multiSelRef.current);
    inkRef.current?.selectIn({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  };

  // A finger on the bare pane: drag moves the board, two fingers zoom, press-and-hold then drag draws the box.
  // A second finger cancelling an open box gives back the selection (and ink selection) it had before.
  const selectionBeforeBox = useRef<string[]>([]);
  const touchGestures = useBoardTouchGestures({
    container: canvasWrapEl,
    enabled: touchPrimary && canvasMode !== "pen" && !handTool,
    onSelectionCancelled: () => {
      inkRef.current?.clearSelection();
      inkCards.current = new Set();
      setSelectionIds(selectionBeforeBox.current);
    },
  });
  // Until the hold arms the box, this is simply the current selection.
  if (!touchGestures.armed) selectionBeforeBox.current = selectionIds;

  // On a phone the "no sub-notes yet" hint sits at the top and leaves after a few seconds, so it never covers the board for long.
  const [noteGoneFor, setNoteGoneFor] = useState<string | null>(null);
  const noteShown = !!tree?.childless;
  useEffect(() => {
    if (!phone || !noteShown) return;
    const timer = setTimeout(() => setNoteGoneFor(activeCanvasId), CHILDLESS_NOTE_MS);
    return () => clearTimeout(timer);
  }, [phone, noteShown, activeCanvasId]);

  const fitBoard = () => { void rfInstance?.fitView({ padding: fitPadding(minimapShown), duration: 300 }); };

  const handleNodeDragStop: OnNodeDrag = (_, node) => {
    releaseCards(canvasWrapRef.current);
    const gesture = dragRef.current;
    dragRef.current = null;
    // A drop still being written must not clear the positions of a drag begun since.
    const drop = ++dropCount.current;
    const putDown = () => { if (drop === dropCount.current && !dragRef.current) setHeldPositions(new Map()); };
    if (!gesture || gesture.canvasId !== activeCanvasId) { putDown(); return; }
    // The grid only decides where the card lands: while it is held it follows the finger exactly.
    const land = (v: number) => snapToGrid ? Math.round(v / SNAP_GRID) * SNAP_GRID : Math.round(v);
    const dx = land(node.position.x) - Math.round(gesture.origin.x);
    const dy = land(node.position.y) - Math.round(gesture.origin.y);
    if (!dx && !dy) { putDown(); return; }
    const { nodes, sections } = gesture.before;
    const after = {
      nodes: nodes.map(p => ({ ...p, x: p.x + dx, y: p.y + dy })),
      sections: sections.map(p => ({ ...p, x: p.x + dx, y: p.y + dy })),
    };
    // Selected ink goes with the selected cards, as one step in the history.
    const withInk = inkSelected && inkCards.current.has(node.id);
    history.batch(() => {
      canvasUndo.recordPositions(nodes, sections, after);
      if (withInk) inkRef.current?.moveSelection(dx, dy);
    });
    // The card stays where it was dropped (grid-snapped when that is on) until the layout has taken the move.
    setHeldPositions(new Map<string, { x: number; y: number }>([
      ...after.nodes.map((p): [string, { x: number; y: number }] => [p.nodeId, { x: p.x, y: p.y }]),
      ...after.sections.map((p): [string, { x: number; y: number }] => [`section-${p.id}`, { x: p.x, y: p.y }]),
    ]));
    runBackgroundWrite(Promise.resolve(onApplyPositions(after.nodes, after.sections)).finally(putDown));
  };

  const handleNodeContextMenu: NodeMouseHandler = (event, node) => {
    event.preventDefault();
    if (node.type === "section") return;
    onNodeContextMenu(node.id, event.clientX, event.clientY);
  };

  const handlePaneContextMenu = (event: React.MouseEvent | MouseEvent) => {
    event.preventDefault();
    const pos = rfInstance?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: 0, y: 0 };
    onPaneContextMenu(event.clientX, event.clientY, pos.x, pos.y);
  };

  const handlePaneClick = useCallback((e: React.MouseEvent) => {
    if (canvasMode === "card") {
      const pos = rfInstance?.screenToFlowPosition({ x: e.clientX, y: e.clientY }) ?? { x: 0, y: 0 };
      onDoubleClickCanvas(pos.x, pos.y);
      setCanvasMode("select");
    } else if (canvasMode === "section") {
      const pos = rfInstance?.screenToFlowPosition({ x: e.clientX, y: e.clientY }) ?? { x: 0, y: 0 };
      onCreateSection(pos.x, pos.y);
      setCanvasMode("select");
    } else {
      inkRef.current?.clearSelection();
      onSelectNode(null);
    }
  }, [canvasMode, setCanvasMode, rfInstance, onDoubleClickCanvas, onCreateSection, onSelectNode]);

  // Whether the last press on the board was a finger or a pen. A double tap on the touch screen never adds a
  // card: a tap that missed a card by a few pixels, or landed while the camera was still moving to it, used to.
  // Adding goes through the “add card” tool (and the long-press menu); a mouse still double-clicks.
  const pressedByFingerRef = useRef(false);
  const handleDoubleClickCanvas = (e: React.MouseEvent) => {
    if (canvasMode !== "select" || pressedByFingerRef.current) return;
    if ((e.target as HTMLElement).closest(".react-flow__node")) return;
    const pos = rfInstance?.screenToFlowPosition({ x: e.clientX, y: e.clientY }) ?? { x: 0, y: 0 };
    onDoubleClickCanvas(pos.x, pos.y);
  };

  // Delete/Backspace on the board: the selected cards come off this board —
  // the context menu's "Remove from canvas", their notes stay in the library.
  // It never trashes a note (it used to, via the global delete shortcut).
  // Only while focus is on the board or nowhere in particular, so a key
  // meant for the sidebar or a field never reaches the selection.
  const panelRef = useRef<HTMLElement>(null);
  const removeSelectedCards = useStableCallback(async (ids: string[]) => {
    if (tagBoard) {
      // A tag's cards are its members: taking one off untags the note, a
      // change to the note itself. Too much for a stray key; say how instead.
      addToast(t("Cards on a tag board come from the tag. To take a card off, use Card actions → Remove from canvas (this removes the tag)."), "info");
      return;
    }
    try {
      let undoRemoval = await onRemoveCards(ids);
      if (!undoRemoval) return;
      setSelectionIds([]);
      // Taking them off is one step in the board's history, with the selected ink if any.
      // The toast's Undo and ⌘Z share one state, so only one of them puts the cards back.
      let removed = true;
      history.batch(() => {
        history.push({
          undo: async () => { if (!removed) return false; await undoRemoval!(); removed = false; return true; },
          redo: async () => {
            if (removed) return false;
            const again = await onRemoveCards(ids);
            if (!again) return false;
            undoRemoval = again; removed = true;
            return true;
          },
        });
        inkRef.current?.removeSelection();
      });
      addToast(t("Removed {count} card(s) from the board. The notes stay in your library.", { count: ids.length }), "info",
        { label: t("Undo"), onClick: () => runBackgroundWrite((async () => { if (!removed) return; await undoRemoval!(); removed = false; })()) });
    } catch (error) {
      writeErrors.report(error, addToast);
    }
  });
  const boardKeyDown = useStableCallback((e: KeyboardEvent) => {
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typingKey(e)) return;
    if (canvasMode === "pen") return;
    const target = e.target instanceof Node ? e.target : null;
    if (target && !isBody(target) && !panelRef.current?.contains(target)) return;
    // Selected cards win over arrows: a box selection also selects the
    // arrows between its cards, and those relations must not go with them.
    // A clicked arrow is the subject even while its card stays highlighted.
    const ids = multiSel.length ? multiSel : selectedEdges.length ? [] : focusedCardId ? [focusedCardId] : [];
    if (ids.length) {
      e.preventDefault();
      void removeSelectedCards(ids);
      return;
    }
    // Only group frames are selected (cards went above): the frames go, the cards inside stay.
    const sectionIds = selectionIds.filter((id) => id.startsWith("section-")).map((id) => id.slice("section-".length));
    if (sectionIds.length && !selectedEdges.length && !inkSelected) {
      e.preventDefault();
      void removeSections(sectionIds);
      return;
    }
    // Only ink is selected: it goes, as one step of the board's history.
    if (inkSelected) {
      e.preventDefault();
      inkRef.current?.removeSelection();
      return;
    }
    // An arrow the note's text draws is skipped; the toolbar says why.
    const arrows = selectedEdges.filter(edge => arrowRules(edge).delete);
    if (!arrows.length) return;
    e.preventDefault();
    deleteArrows(arrows);
  });
  // The context menu's "Delete arrow" path (a parent arrow unparents).
  function deleteArrows(arrows: Edge[]) {
    setSelectedEdgeIds([]);
    void Promise.all(arrows.map((edge) => Promise.resolve(onEdgeDeleted(edge.id)))).then((gone) => {
      // Several arrows deleted together come back together.
      history.batch(() => { for (const edge of gone) if (edge) arrowStep(edge, "remove"); });
    });
  }
  useEffect(() => {
    return onWindow("keydown", boardKeyDown);
  }, [boardKeyDown]);

  // ⌘C / ⌘V / ⌘D and the selection bar's 複製一份: cards (as new notes), their arrows and the selected ink.
  const allEdges = useAppSelector((st) => st.data.edges);
  useBoardClipboard({
    enabled: !!clipboardOps && !!activeCanvasId && onScreen && !tagBoard && !(tree && tree.crumbs.length > 0) && canvasMode !== "pen",
    boardId: activeCanvasId, panelRef, rfInstance, history, inkRef, ops: clipboardOps!,
    layout: () => canvasData, notes: () => nodes, edges: () => allEdges,
    selectedCardIds: () => multiSelRef.current.length ? multiSelRef.current : focusedCardId ? [focusedCardId] : [],
    onPasted: (ids) => { inkCards.current = new Set(ids); setSelectionIds(ids); },
  });

  function alignSelected(mode: CanvasAlignment) {
    const rendered = rfInstance?.getNodes() ?? flowNodes;
    const changed = alignCanvasCards(rendered, multiSel, mode);
    if (changed.length === 0) return;
    canvasUndo.recordPositions(changed.map(u => {
      const before = rendered.find(n => n.id === u.nodeId)!;
      return { nodeId: u.nodeId, ...before.position };
    }), [], { nodes: changed, sections: [] });
    runBackgroundWrite(onApplyPositions(changed));
  }

  // A whole arrangement is one move, using the same batch restore as selection.
  function runArrange(fn?: () => void) {
    if (!fn || !activeCanvasId) return;
    // Arrangement touches the whole stored board, even while focus/search
    // hides some cards. The inverse must own that same complete set.
    canvasUndo.recordPositions((canvasData?.nodes ?? []).map(n => ({ nodeId: n.nodeId, x: n.x, y: n.y })));
    fn();
  }

  function handleImportFile(file: File) {
    if (onImportCanvas) void importCanvasFile(file, onImportCanvas, addToast);
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const pos = rfInstance?.screenToFlowPosition({ x: e.clientX, y: e.clientY }) ?? { x: 0, y: 0 };
    onGraphDrop(e, pos);
  };

  const cursorClass =
    canvasMode === "card" ? "graph-panel--card-mode"
    : canvasMode === "section" ? "graph-panel--section-mode"
    : canvasMode === "hand" ? "graph-panel--hand-mode"
    : canvasMode === "pen" ? "graph-panel--pen-mode"
    : "";

  return (
    <>
      <GraphCallbacksContext.Provider value={callbacks}>
      <section
        ref={panelRef}
        className={classNames("graph-panel", cursorClass, mobileView !== "graph" && "mobile-hidden")}
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
      >
        {/* Boards are notes (opened from the note's 白板 view); the only strip
            left is the way back out of a sub-canvas. */}
        {onBackToParentCanvas && (
        <div className="canvas-tabbar">
          <Pressable
            className="canvas-back-pill"
            onClick={onBackToParentCanvas}
            title={parentCanvasTitle ? t("Back to {title}", { title: parentCanvasTitle }) : t("Back to parent canvas")}
          >
            ← {parentCanvasTitle ?? t("Parent")}
          </Pressable>
        </div>
        )}

        {/* Soft-cap nudge — passive, dismissible; points at the free remedy
            (sub-canvas split). Counts real cards, not sections. */}
        {activeCanvasId && !capDismissed && (() => {
          const cardCount = displayGraphNodes.filter((n) => n.type !== "section").length;
          if (cardCount <= CARD_SOFT_CAP) return null;
          return (
            <div className="canvas-cap-banner" role="status">
              <span>
                {t("This canvas has {count} cards — large boards get heavy. Consider splitting part of it into a sub-canvas (open a card → “Create sub-canvas”); each sub-canvas loads independently.", { count: cardCount })}
              </span>
              <Pressable className="canvas-cap-dismiss" onClick={() => setCapDismissed(true)} aria-label={t("Dismiss")}>
                <X size={13} />
              </Pressable>
            </div>
          );
        })()}

        {/* A selected arrow gets its menu's actions here (touch has no right-click). */}
        {activeCanvasId && edgeFocus && (
          <div className="canvas-edge-bar">
            {(() => {
              const deletable = selectedEdges.filter(edge => arrowRules(edge).delete);
              const locked = deletable.length < selectedEdges.length;
              const parentOnly = selectedEdges.every(edge => edge.type === "parentEdge");
              const count = deletable.length || selectedEdges.length;
              return <>
                {locked && <span className="canvas-edge-locked" role="status">{t(DERIVED_ARROW_HINT)}</span>}
                {selectedEdges.length === 1 && !parentOnly && <Button type="button" aria-haspopup="dialog" disabled={!arrowRules(selectedEdges[0]).retype}
                  onClick={(event) => {
                    const edge = selectedEdges[0];
                    const rect = event.currentTarget.getBoundingClientRect();
                    const edgeType = (edge.data as { edgeType?: string } | undefined)?.edgeType ?? "knowledge_link";
                    onEdgeContextMenu(edge.id, edgeType, rect.left, rect.bottom + 6);
                  }}
                >{t("Arrow type")}</Button>}
                <Button type="button" disabled={!deletable.length} onClick={() => deleteArrows(deletable)}>
                  {parentOnly ? t("Remove from parent")
                    : tn("Delete arrow", "Delete {count} arrows", count)}
                </Button>
              </>;
            })()}
          </div>
        )}

        {activeCanvasId && (
          <BoardViewMenu
            tree={tree}
            display={display.settings}
            onDisplay={display.set}
            minimap={minimapShown}
            onMinimap={setMinimapShown}
            fullscreen={fullscreen}
            onFullscreen={alwaysFullscreen ? undefined : toggleFullscreen}
          />
        )}

        <BoardToolbar
          tool={canvasMode}
          onTool={(next) => { if (next === "pen") startPen(); else setCanvasMode(next); }}
          penAvailable={inkEnabled}
          boardOpen={!!activeCanvasId}
          addNote={{ open: addOpen, buttonRef: addButtonRef, onToggle: () => { if (activeCanvasId) setAddCanvasId(addOpen ? null : activeCanvasId); } }}
          more={{
            snapToGrid, onSnapToGrid: () => setSnapToGrid((v) => !v),
            graphLocalMode, onGraphLocalMode: () => setGraphLocalMode((v) => !v),
            showTagEdges, onShowTagEdges: onToggleTagEdges,
            parentMode, onParentMode: () => setParentMode(!parentMode),
            onTidy: () => runArrange(onTidyCanvas),
            onArrangeTree: () => runArrange(onArrangeTree),
            onFit: phone ? fitBoard : undefined,
            exporting: isExporting,
            onExport: () => void exportBoard(),
            onImport: () => importInputRef.current?.click(),
          }}
        />
        <FileInput
          ref={importInputRef}
          accept=".canvas,application/json"
          className="canvas-import-input"
          aria-label={t("Import .canvas file")}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImportFile(f); e.target.value = ""; }}
        />

        <BoardCornerControls
          phone={phone} zoomButtons={!(phone && touchPrimary)}
          canUndo={canvasUndo.canUndo} canRedo={canvasUndo.canRedo}
          onUndo={() => runBackgroundWrite(canvasUndo.undo())} onRedo={() => runBackgroundWrite(canvasUndo.redo())}
          zoom={headingZoom}
          onZoomIn={() => void rfInstance?.zoomIn({ duration: 200 })} onZoomOut={() => void rfInstance?.zoomOut({ duration: 200 })}
          onFit={fitBoard}
        />

        {addOpen && activeCanvasId && onAddToCanvas && (
          <CanvasNotePicker key={activeCanvasId} canvasId={activeCanvasId} onAdd={onAddToCanvas}
            onClose={closeAddPicker}
            onAdded={(id) => { closeAddPicker(); setCanvasSearch(""); onSelectNode(id); }} />
        )}

        {multiSel.length >= 2 && (
          <div className="canvas-align-bar">
            <span className="canvas-align-count">{t("{n} cards selected", { n: multiSel.length })}</span>
            <Button variant="ghost" size="sm" onClick={() => setCardsFolded(multiSel, !allFolded(multiSel))}>
              {allFolded(multiSel) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              {allFolded(multiSel) ? t("Expand card") : t("Fold card")}
            </Button>
            {hasOwnSize(multiSel) && <Button variant="ghost" size="sm" onClick={() => onResetCardSize(multiSel)}>{t("Reset size")}</Button>}
            <span className="canvas-align-sep" />
            <Button variant="icon" size="sm" onClick={() => alignSelected("left")} aria-label={t("Align left")} title={t("Align left")}><AlignStartVertical size={14} /></Button>
            <Button variant="icon" size="sm" onClick={() => alignSelected("centerX")} aria-label={t("Align horizontal centers")} title={t("Align horizontal centers")}><AlignCenterVertical size={14} /></Button>
            <Button variant="icon" size="sm" onClick={() => alignSelected("right")} aria-label={t("Align right")} title={t("Align right")}><AlignEndVertical size={14} /></Button>
            <span className="canvas-align-sep" />
            <Button variant="icon" size="sm" onClick={() => alignSelected("top")} aria-label={t("Align top")} title={t("Align top")}><AlignStartHorizontal size={14} /></Button>
            <Button variant="icon" size="sm" onClick={() => alignSelected("middleY")} aria-label={t("Align vertical centers")} title={t("Align vertical centers")}><AlignCenterHorizontal size={14} /></Button>
            <Button variant="icon" size="sm" onClick={() => alignSelected("bottom")} aria-label={t("Align bottom")} title={t("Align bottom")}><AlignEndHorizontal size={14} /></Button>
            {multiSel.length >= 3 && (
              <>
                <span className="canvas-align-sep" />
                <Button variant="icon" size="sm" onClick={() => alignSelected("distH")} aria-label={t("Distribute horizontally")} title={t("Distribute horizontally")}><Columns3 size={14} /></Button>
                <Button variant="icon" size="sm" onClick={() => alignSelected("distV")} aria-label={t("Distribute vertically")} title={t("Distribute vertically")}><Rows3 size={14} /></Button>
              </>
            )}
            {onGroupSelection && (
              <>
                <span className="canvas-align-sep" />
                <Button variant="icon" size="sm" onClick={() => onGroupSelection(multiSel)} aria-label={t("Group selection")} title={t("Group selection")}><Group size={14} /></Button>
              </>
            )}
            {onSetNodesColor && (
              <>
                <span className="canvas-align-sep" />
                <CardColorSwatches onPick={(color) => onSetNodesColor(multiSel, color)} />
              </>
            )}
          </div>
        )}

        {canvasSearch !== "" && (
          <div className="canvas-search-bar">
            <SearchField ref={canvasSearchRef} label={t("Search cards…")} value={canvasSearch} onValueChange={setCanvasSearch} autoFocus
              onKeyDown={(e) => e.stopPropagation()} onEscape={() => setCanvasSearch("")} />
          </div>
        )}

        {!activeCanvasId ? (
          // No board open (the global graph moved to Places → Graph): point
          // at the tab strip instead of rendering a surface that isn't a
          // canvas. The day canvas usually auto-opens, so this is rare.
          <div className="kw-canvas-empty">
            <p>{t("Pick a canvas above, or create one with the + tab.")}</p>
          </div>
        ) : (
          <div className={classNames("kw-canvas-wrap", touchGestures.armed && "kw-canvas-wrap--armed", farTitles && "kw-canvas-wrap--far")} ref={setCanvasWrap} onDoubleClick={handleDoubleClickCanvas}
            onPointerDownCapture={(e) => { pressedByFingerRef.current = pressedOnScreen(e); selectionAtPress.current = selectionIds; camera.stopGlide(); }}
            onWheelCapture={camera.stopGlide}>
            <ReactFlow
              ariaLabelConfig={{
                "controls.ariaLabel": t("Canvas controls"),
                "controls.zoomIn.ariaLabel": t("Zoom in"),
                "controls.zoomOut.ariaLabel": t("Zoom out"),
                "controls.fitView.ariaLabel": t("Fit view"),
                "controls.interactive.ariaLabel": t("Lock or unlock the board"),
                "minimap.ariaLabel": t("Minimap"),
              }}
              nodes={flowNodes}
              onNodesChange={handleNodeChanges}
              edges={flowEdges}
              onEdgesChange={handleEdgeChanges}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
              onInit={setRfInstance}
              onNodeClick={handleNodeClick}
              onPaneClick={handlePaneClick}
              onNodeDragStart={handleNodeDragStart}
              onNodeDragStop={handleNodeDragStop}
              onMoveStart={camera.onMoveStart}
              onMove={camera.onMove}
              onMoveEnd={camera.onMoveEnd}
              onViewportChange={viewport => setHeadingZoom(viewport.zoom)}
              onNodeContextMenu={handleNodeContextMenu}
              onPaneContextMenu={handlePaneContextMenu}
              onEdgeContextMenu={(event, edge) => {
                event.preventDefault();
                // Tag hints and parent lines are not stored edges: no arrow menu.
                if (edge.data?.derived || edge.type === "parentEdge") return;
                const edgeType = (edge.data as { edgeType?: string } | undefined)?.edgeType ?? "knowledge_link";
                onEdgeContextMenu(edge.id, edgeType, event.clientX, event.clientY);
              }}
              onConnect={handleConnect}
              onSelectionStart={handleSelectionStart}
              onSelectionEnd={handleSelectionEnd}
              connectionMode={ConnectionMode.Loose}
              connectionRadius={30}
              connectOnClick={false}
              // Double-click on empty canvas CREATES A CARD (handleDoubleClickCanvas
              // on .kw-canvas-wrap). React Flow's default dblclick-zoom swallows the
              // event before it bubbles there, so the gesture never fired.
              zoomOnDoubleClick={false}
              minZoom={0.1}
              // Pen mode: the ink layer captures pointers, so left-drag never
              // reaches the pane — EXCEPT while space is held, when the layer
              // goes transparent and left-drag must pan (spacebar-pan).
              // The hand tool pans with a plain drag, and does not box-select.
              panOnDrag={canvasMode === "hand" || (canvasMode === "pen" && spaceHeld) ? [0, 1, 2] : [1, 2]}
              selectionOnDrag={canvasMode !== "pen" && !handTool}
              nodesDraggable={!handTool}
              // 0: a pressed card is under the finger from the first pixel. React Flow's default (1) starts the
              // drag where the pointer has got to, so the card trails the finger by that much for the whole drag.
              nodeDragThreshold={0}
              nodesConnectable={!handTool}
              // React Flow's credit line would sit over the bottom corner.
              proOptions={{ hideAttribution: true }}
              // React Flow snaps while dragging; here the grid applies on drop (handleNodeDragStop), so a held
              // card follows the finger and does not jump from grid line to grid line.
              snapToGrid={false}
              // P0-5 縮放定位: auto-fit ONLY on a cold open (no saved viewport).
              // When a stash exists the restore effect drives the camera, so
              // the prop's onInit-fit must be off or it races the restore.
              fitView={camera.fitOnOpen}
              fitViewOptions={{ padding: fitPadding(minimapShown) }}
              // NB: onlyRenderVisibleElements was tried and reverted — these
              // cards don't carry a measured height (style.height is usually
              // undefined), so ReactFlow's culling mis-computed intersections
              // and mounted only ~4 of 300 cards, leaving the board near-empty.
              // Profiling also showed drag was already smooth (0 long tasks),
              // so the real large-board remedy is splitting into sub-canvases
              // (the soft-cap banner nudges this), not render tricks here.
              deleteKeyCode={null}
              selectionKeyCode="Shift"
              multiSelectionKeyCode="Meta"
              defaultEdgeOptions={{
                type: "default",
                interactionWidth: 32,
                style: { strokeWidth: 1.6, opacity: 0.95 },
                // Default arrowhead in the unknown-type colour. Per-edge
                // overrides in displayGraphEdges replace this with the edge_type
                // colour (lib/edgeKinds) so the arrow matches its line.
                markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: FALLBACK_EDGE_COLOR },
              }}
            >
              <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--ac-line)" />
              {/* Bird's-eye navigator for sprawling boards ([[canvas-scale]]).
                  Node colour reflects the card's own swatch / section tone via
                  minimapNodeColor; click-drag the viewport rectangle to pan.
                  Palette-token chrome (no new colours). */}
              {minimapShown && (
                <MiniMap
                  pannable
                  zoomable
                  nodeColor={minimapNodeColor}
                  nodeStrokeColor={minimapNodeStroke}
                  nodeStrokeWidth={3}
                  maskColor="color-mix(in srgb, var(--ac-bg) 70%, transparent)"
                  bgColor="var(--ac-surface)"
                  className="kw-canvas-minimap"
                  ariaLabel={t("Canvas minimap")}
                />
              )}
              {/* The selected card's own bar follows it as the board pans and zooms. */}
              {focusedCardId && !edgeFocus && multiSel.length < 2 && canvasMode !== "pen" && (
                <NodeToolbar nodeId={focusedCardId} position={Position.Top} offset={12} isVisible>
                  <BoardSelectionBar
                    onOpen={() => onOpenCard(focusedCardId)}
                    onColor={(color) => onSetNodesColor([focusedCardId], color)}
                    onCenter={tree?.mode === "auto" ? () => onCenterBoard(focusedCardId) : undefined}
                    branch={focusedBranch ? { expanded: focusedBranch.expanded, onToggle: () => onToggleBranch(focusedCardId) } : undefined}
                    fold={{ folded: allFolded([focusedCardId]), onToggle: () => setCardsFolded([focusedCardId], !allFolded([focusedCardId])) }}
                    onResetSize={hasOwnSize([focusedCardId]) ? () => onResetCardSize([focusedCardId]) : undefined}
                    onMore={({ x, y }) => onNodeContextMenu(focusedCardId, x, y)}
                  />
                </NodeToolbar>
              )}
              {/* Ink layer — child of ReactFlow so useViewport keeps the ink
                  camera on the store. keyed per canvas: each named
                  canvas carries its own board_ink doc. */}
              {inkEnabled && <Suspense fallback={null}>
                <CanvasInkLayer
                  ref={inkRef}
                  boardHistory={history}
                  onSelectionChange={setInkSelected}
                  key={activeCanvasId}
                  canvasId={activeCanvasId}
                  penActive={canvasMode === "pen"}
                  spaceHeld={spaceHeld}
                  pen={pen}
                  onInsertImages={onInsertImages}
                />
              </Suspense>}
            </ReactFlow>
          </div>
        )}

        {tree && tree.crumbs.length > 1 && (
          <nav className="canvas-tree-path" aria-label={t("Board centre")}>
            {tree.crumbs.map((crumb, index) => {
              const last = index === tree.crumbs.length - 1;
              return (
                <span key={crumb.id} className="canvas-tree-crumb">
                  {index > 0 && <span aria-hidden="true">›</span>}
                  <Button type="button" aria-current={last ? "location" : undefined} disabled={last} onClick={() => tree.backTo(index)}>{crumb.title}</Button>
                </span>
              );
            })}
          </nav>
        )}

        {tree?.childless && !(phone && noteGoneFor === activeCanvasId) && (
          <div className={classNames("canvas-tree-note", phone && "canvas-tree-note--fading")} role="status">{t("This note has no sub-notes yet. Add one inside the note and it appears here.")}</div>
        )}

        {activeCanvasId && displayGraphNodes.filter((n) => n.type !== "section").length === 0 && (
          <div className="canvas-empty-hint">
            <span>{t("Double-click the board (or press C then click) to add a card")}</span>
            <Pressable
              className="canvas-empty-add"
              onClick={() => setAddCanvasId(activeCanvasId)}
            >
              <FilePlus2 size={14} /> {t("Add a note from your library")}
            </Pressable>
          </div>
        )}

      </section>
      </GraphCallbacksContext.Provider>
    </>
  );
}

// H4 re-render hygiene: handlers from BuilderApp are identity-stable
// (useStableHandlers/useStableCallback), so the canvas shell skips renders
// for unrelated BuilderApp state.
export default memo(KnowledgeWorkspace);
