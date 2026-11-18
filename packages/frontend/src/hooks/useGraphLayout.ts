// Graph display derivation — turns the bootstrap node/edge model into
// React Flow's expected shape (Node[] + Edge[]), accounting for:
//   - active canvas overrides (position + section grouping when on a canvas)
//   - search dim, neighbor-only mode, global mode color tints
//   - per-edge stroke palette + handle selection by direction
//   - parent edges (always drawn) + #tag edges (opt-in)
//
// Extracted from BuilderApp.tsx Day-4 hook layer (F1.4). All derivations
// stay memo'd against the same dep tuple as the inline originals — TDZ-safe
// because every input is a hook-call return or prop already declared by
// the calling component before this hook runs.

import type { MarkerType, Node, Edge } from "@xyflow/react";
import { useMemo } from "react";
import { displayTitle } from "../lib/noteLabel";
import type { Canvas, ContentNode, NodeEdge, Tag } from "../lib/api";
import { cardsInSection, canvasCardSize } from "../lib/sectionCarry";
import { classNames } from "../lib/utils";
import { nodeTagIds } from "../lib/nodeTags";
import { DEFAULT_CARD_H, DEFAULT_CARD_W } from "../lib/cardGeometry";
import { nodeIndexOf } from "../lib/nodeIndex";
import { FOLDED_CARD_H, isCardFolded, titleOnlyFarOn, titleOnlyMaxWidth, type CardDisplaySettings } from "../lib/cardDisplay";
import { canDelete, drawsOnBoard, useEdgeKinds } from "../lib/edgeKinds";
import { isRetiredBoardKind } from "../lib/whiteboardNote";

/** A stored edge; its status and origin decide whether the board draws it
 *  and whether it may be deleted (lib/edgeRoles). */
type DataEdge = Pick<NodeEdge, "id" | "source_node_id" | "target_node_id" | "edge_type" | "status" | "origin">;

/** The note whose board is open (or one still of the retired kind 'canvas'). */
const isBoardOwner = (node: ContentNode, boardOwnerId: string | null) => isRetiredBoardKind(node) || node.id === boardOwnerId;

const NO_DISPLAY: CardDisplaySettings = {};

type Params = {
  nodes: ContentNode[];
  edges: DataEdge[];
  activeCanvas: Canvas | null;
  mode: string;
  notesView: string;
  selectedNode: ContentNode | null;
  /** The sticky open board (canvas-in-Editor). Non-null = the editor pane is
   *  a board; card clicks move selectedNode WITHOUT closing it. */
  openBoardId?: string | null;
  selectedId: string | null;
  graphLocalMode: boolean;
  canvasSearch: string;
  showTagEdges: boolean;
  /** Draw related-note suggestions (default true): false while the module
   *  that files them is not imported (useLinkSuggestionsShown). */
  showSuggestions?: boolean;
  /** The tag catalog: names for the shared-tag hints. */
  tags?: readonly Pick<Tag, "id" | "name">[];
  /** How the board's cards are drawn (folded or expanded; lib/cardDisplay). */
  display?: CardDisplaySettings;
};

export function useGraphLayout({
  nodes,
  edges,
  activeCanvas,
  mode,
  notesView,
  selectedNode,
  openBoardId = null,
  selectedId,
  graphLocalMode,
  canvasSearch,
  showTagEdges,
  showSuggestions = true,
  tags,
  display = NO_DISPLAY,
}: Params): {
  displayGraphNodes: Node[];
  displayGraphEdges: Edge[];
} {
  const edgeKinds = useEdgeKinds();
  // The focused note is the board itself (its whiteboard tab is open, or it is
  // still of the retired kind 'canvas'): its cards are content, not
  // "non-neighbors" to dim.
  const boardOwnerId = activeCanvas?.id ?? null;
  const neighborIds = useMemo(() => {
    const ids = new Set<string>();
    if (!selectedNode || isBoardOwner(selectedNode, boardOwnerId)) return ids;
    edges.forEach((e) => {
      if (!drawsOnBoard(e, { suggestions: showSuggestions })) return;
      if (e.source_node_id === selectedNode.id) ids.add(e.target_node_id);
      if (e.target_node_id === selectedNode.id) ids.add(e.source_node_id);
    });
    if (selectedNode.parent_id) ids.add(selectedNode.parent_id);
    for (const node of nodes) if (node.parent_id === selectedNode.id) ids.add(node.id);
    return ids;
  }, [selectedNode, boardOwnerId, edges, nodes, showSuggestions]);

  // Cards and arrows exist only while a board is on screen; any other screen draws its own (the notes list,
  // tasks, timeline, the graph view), so none of this is computed for the whole workspace then.
  const boardActive = mode === "notes" && (notesView === "canvas" || (notesView === "editor" && !!openBoardId));
  const noteById = nodeIndexOf(nodes);

  const displayGraphNodes = useMemo<Node[]>(() => {
    // No board shown, or its data still loading: nothing. (Falling through to every workspace note flashed them
    // and left fitView at the wrong coordinates.)
    if (!boardActive || !activeCanvas) return [];
    const visible = graphLocalMode && selectedNode && !isBoardOwner(selectedNode, boardOwnerId)
      ? new Set([selectedNode.id, ...neighborIds])
      : null;

    const searchQ = canvasSearch.trim().toLowerCase();
    const makeNode = (
      node: ContentNode,
      x: number,
      y: number,
      cn?: { width?: number; height?: number; color?: string; folded?: boolean; subCanvasId?: string },
      maxTitleWidth?: number,
    ) => {
      // A focused CANVAS node is the board itself — its cards are content,
      // not "non-neighbors" to dim.
      const dimByNeighbor = selectedNode && !isBoardOwner(selectedNode, boardOwnerId) && !neighborIds.has(node.id) && node.id !== selectedId;
      const dimBySearch = searchQ
        ? !node.title.toLowerCase().includes(searchQ) && !node.markdown.toLowerCase().includes(searchQ)
        : false;
      const dimmed = !!(dimByNeighbor || dimBySearch);
      const folded = isCardFolded(display, { nodeId: node.id, folded: cn?.folded });
      return {
        id: node.id,
        type: "card",
        // Card hit targets stay above the wide invisible edge interaction paths.
        zIndex: 10,
        position: { x, y },
        data: {
          label: node.title,
          content: node.markdown,
          sourceType: node.source_type,
          nodeType: node.node_type,
          color: cn?.color,
          folded,
          titleOnlyFar: titleOnlyFarOn(display),
          maxTitleWidth,
          subCanvasId: cn?.subCanvasId,
        },
        selected: node.id === selectedId,
        className: classNames(
          "graph-card-node",
          folded && "graph-card-node--folded",
          dimmed && "graph-card-node--dimmed",
          cn?.subCanvasId && "graph-card-node--has-board",
        ),
        style: {
          width: cn?.width ?? DEFAULT_CARD_W,
          height: folded ? FOLDED_CARD_H : cn?.height,
          opacity: dimmed ? 0.12 : 1,
        },
      };
    };

    {
      // Section membership: a card belongs to a section when its centre
      // lies inside the section's rectangle. Cheap O(C×S) — fine for
      // sub-1k card counts. Drives LOD rendering at zoom-out.
      const sections = activeCanvas.data.sections ?? [];
      const containingSectionId = (cn: { nodeId?: string; x: number; y: number; width?: number; height?: number; folded?: boolean }) => {
        const { w, h } = canvasCardSize(cn, display);
        const cx = cn.x + w / 2;
        const cy = cn.y + h / 2;
        for (const s of sections) {
          if (cx >= s.x && cx <= s.x + s.width && cy >= s.y && cy <= s.y + s.height) return s.id;
        }
        return undefined;
      };
      const sectionNodes: Node[] = sections.map((s) => {
        // Overlapping frames each carry their geometric members. Count that
        // same set, even when the card's LOD placeholder belongs to the first.
        const members = cardsInSection(s, activeCanvas.data.nodes, display);
        return {
        id: `section-${s.id}`,
        type: "section",
        position: { x: s.x, y: s.y },
        style: { width: s.width, height: s.height },
        data: { title: s.title, color: s.color, sectionId: s.id, cardCount: members.length },
        zIndex: -1,
        selectable: true,
        draggable: true,
        };
      });
      // Members without stored coordinates (programmatic adds) fan out around
      // their parent's card when it's on this canvas — same golden-angle arc
      // as the global fallback, instead of stacking at the origin.
      const placed = new Map<string, { x: number; y: number }>();
      for (const cn of activeCanvas.data.nodes) {
        if (cn.x != null && cn.y != null) placed.set(cn.nodeId, { x: cn.x, y: cn.y });
      }
      const fanIndex = new Map<string, number>();
      const fallbackPos = (nodeId: string): { x: number; y: number } => {
        const parentId = noteById.get(nodeId)?.parent_id ?? null;
        const anchor = parentId ? placed.get(parentId) : undefined;
        const key = parentId ?? "__root__";
        const i = fanIndex.get(key) ?? 0;
        fanIndex.set(key, i + 1);
        const ring = Math.floor(i / 7);
        const angle = i * 2.39996 + 0.65;
        const r = 350 + ring * 300;
        const base = anchor ?? { x: 0, y: 0 };
        const p = { x: base.x + Math.cos(angle) * r * 1.2, y: base.y + Math.sin(angle) * r * 0.8 };
        placed.set(nodeId, p);
        return p;
      };
      const boardCards = activeCanvas.data.nodes;
      const cardNodes = boardCards
        .filter((cn) => !visible || visible.has(cn.nodeId))
        .map((cn) => {
          const node = noteById.get(cn.nodeId);
          if (!node) return null;
          const pos = cn.x != null && cn.y != null ? { x: cn.x, y: cn.y } : fallbackPos(cn.nodeId);
          const built = makeNode(node, pos.x, pos.y, cn, titleOnlyMaxWidth(cn, boardCards, DEFAULT_CARD_W, DEFAULT_CARD_H));
          // Loose-typed section membership pass-through — CardNode reads
          // .data.containedSectionId to hide itself at low zoom.
          const sid = containingSectionId(cn);
          if (sid) (built.data as Record<string, unknown>).containedSectionId = sid;
          return built;
        })
        .filter(Boolean) as Node[];
      return [...sectionNodes, ...cardNodes];
    }
  }, [noteById, activeCanvas, boardActive, graphLocalMode, selectedNode, selectedId, neighborIds, canvasSearch, boardOwnerId, display]);

  const displayGraphEdges = useMemo<Edge[]>(() => {
    if (!boardActive || !activeCanvas) return [];
    // Stroke and arrowhead colour per type come from the edge manifest
    // (lib/edgeKinds), so a plugin's type is coloured too; a plain wikilink
    // is drawn a little lighter than the typed relations. The manifest colours
    // hold 3:1 on both themes only near full opacity; at 0.78 and 1.25px the
    // arrows all but vanished (GAP-174).
    const edgeStyle = (kind: string): React.CSSProperties => kind === "knowledge_link"
      ? { stroke: edgeKinds.color(kind), strokeWidth: 1.6, opacity: 0.95 }
      : { stroke: edgeKinds.color(kind), strokeWidth: 1.75, opacity: 1 };
    // The enum's value, not the enum: importing MarkerType itself would put
    // @xyflow/system and d3 into the boot JS, which loads before any board.
    const edgeMarker = (kind: string) => ({ type: "arrowclosed" as MarkerType, width: 18, height: 18, color: edgeKinds.color(kind) });
    const tagEdgeStyle: React.CSSProperties = { stroke: "#94a3b8", strokeWidth: 1.15, strokeDasharray: "4 4", opacity: 0.58 };
    const parentEdgeStyle: React.CSSProperties = { stroke: edgeKinds.color("parent"), strokeWidth: 1.5, strokeDasharray: "5 3", opacity: 0.85 };

    const nodeBounds = new Map(
      displayGraphNodes
        .filter((node) => node.type === "card")
        .map((node) => {
          const width = typeof node.style?.width === "number" ? node.style.width : DEFAULT_CARD_W;
          const height = typeof node.style?.height === "number" ? node.style.height : 118;
          return [node.id, { x: node.position.x, y: node.position.y, width, height }];
        }),
    );
    const getHandles = (sourceId: string, targetId: string) => {
      const source = nodeBounds.get(sourceId);
      const target = nodeBounds.get(targetId);
      if (!source || !target) return {};
      const sx = source.x + source.width / 2;
      const sy = source.y + source.height / 2;
      const tx = target.x + target.width / 2;
      const ty = target.y + target.height / 2;
      const dx = tx - sx;
      const dy = ty - sy;

      if (Math.abs(dx) >= Math.abs(dy)) {
        return dx >= 0
          ? { sourceHandle: "r", targetHandle: "l" }
          : { sourceHandle: "l", targetHandle: "r" };
      }
      return dy >= 0
        ? { sourceHandle: "b", targetHandle: "t" }
        : { sourceHandle: "t", targetHandle: "b" };
    };
    const visible = graphLocalMode && selectedNode && !isBoardOwner(selectedNode, boardOwnerId)
      ? new Set([selectedNode.id, ...neighborIds])
      : null;
    const edgesBoardActive = mode === "notes"
      && (notesView === "canvas" || (notesView === "editor" && !!openBoardId));
    const canvasNodeIds = activeCanvas && edgesBoardActive
      ? new Set(activeCanvas.data.nodes.map((cn) => cn.nodeId))
      : null;
    // The name a screen reader says for an arrow: the two notes' titles. Without one React Flow says
    // "Edge from <id> to <id>" (English, and ids the owner's UI rule keeps out of sight).
    const edgeAriaLabel = (from: string, to: string) =>
      `${displayTitle(noteById.get(from)?.title)} → ${displayTitle(noteById.get(to)?.title)}`;
    const baseEdges = edges
      // What a board draws is lib/edgeRoles' rule (no site navigation, no
      // turned-down suggestions), shared with the other views.
      .filter((e) => drawsOnBoard(e, { suggestions: showSuggestions }))
      .filter((e) => !canvasNodeIds || (canvasNodeIds.has(e.source_node_id) && canvasNodeIds.has(e.target_node_id)))
      .filter((e) => !visible || (visible.has(e.source_node_id) && visible.has(e.target_node_id)))
      .map((e) => {
        const handles = getHandles(e.source_node_id, e.target_node_id);
        const related = selectedId ? e.source_node_id === selectedId || e.target_node_id === selectedId : true;
        const baseStyle = edgeStyle(e.edge_type);
        return {
          id: e.id,
          source: e.source_node_id,
          target: e.target_node_id,
          ...handles,
          type: "default",
          ariaLabel: edgeAriaLabel(e.source_node_id, e.target_node_id),
          animated: e.status === "suggested",
          // A [[link]]'s arrow can be selected (to see it) but not deleted:
          // it goes when the link leaves the note (lib/edgeRoles canDelete).
          deletable: canDelete(e),
          // Wide enough to tap (GAP-174).
          interactionWidth: 32,
          style: {
            ...baseStyle,
            opacity: selectedId ? (related ? 1 : 0.2) : baseStyle.opacity,
            strokeWidth: selectedId && related ? 2.2 : baseStyle.strokeWidth,
          },
          // Arrowhead matches stroke; explicit per-edge override means
          // newly drawn edges pick up the right colour as soon as
          // _connectNodes round-trips through the API.
          markerEnd: edgeMarker(e.edge_type),
          zIndex: selectedId && related ? 8 : 1,
          // Quiet by default: the relation is already expressed by stroke
          // color/marker. The HUMAN name surfaces only while a connected card
          // is selected — never the raw schema name (死板 feedback: a board
          // shouting "highlight_source" six times reads as a database).
          label: selectedId && related && e.edge_type !== "knowledge_link"
            ? edgeKinds.label(e.edge_type)
            : undefined,
          // The edge facts lib/edgeRoles reads, so the board's arrow toolbar
          // and Delete key can ask canDelete / canRetype (GAP-174).
          data: { edgeType: e.edge_type, status: e.status, origin: e.origin },
        };
      });

    const tagEdges: Edge[] = [];
    // Shared tags describe peers, not N*(N-1)/2 independent relationships.
    // Render a star around an actual selected card, bounded to visible cards.
    // Only tags the notes carry count; a #word in the text is not a tag (T10).
    if (showTagEdges && activeCanvas && selectedNode && nodeBounds.has(selectedNode.id)) {
      const tagNames = new Map((tags ?? []).map((tag) => [tag.id, tag.name]));
      const selectedTags = new Set(nodeTagIds(selectedNode));
      for (const node of nodes) {
        if (node.id === selectedNode.id || !nodeBounds.has(node.id)) continue;
        const shared = nodeTagIds(node).filter(id => selectedTags.has(id))
          .flatMap(id => tagNames.get(id) ?? []);
        if (!shared.length) continue;
        tagEdges.push({
          id: `tag-${selectedNode.id}-${node.id}`,
          source: selectedNode.id,
          target: node.id,
          ...getHandles(selectedNode.id, node.id),
          type: "default",
          ariaLabel: edgeAriaLabel(selectedNode.id, node.id),
          label: shared.map(tag => `#${tag}`).join(" · "),
          // Derived tag hints must not offer deletion of a nonexistent edge.
          selectable: false,
          focusable: false,
          interactionWidth: 0,
          style: { ...tagEdgeStyle, pointerEvents: "none" },
          zIndex: 0,
          data: { derived: true },
        });
      }
    }
    const parentEdges: Edge[] = nodes
      .filter((n) => n.parent_id && nodeBounds.has(n.id) && nodeBounds.has(n.parent_id))
      .filter((n) => !canvasNodeIds || (canvasNodeIds.has(n.id) && canvasNodeIds.has(n.parent_id!)))
      .filter((n) => !visible || (visible.has(n.id) && visible.has(n.parent_id!)))
      .map((n) => {
        const handles = getHandles(n.parent_id!, n.id);
        const related = selectedId ? n.id === selectedId || n.parent_id === selectedId : true;
        return {
          id: `parent-${n.id}`,
          source: n.parent_id!,
          target: n.id,
          ...handles,
          type: "parentEdge",
          ariaLabel: edgeAriaLabel(n.parent_id!, n.id),
          // Wide enough to tap (GAP-174).
          interactionWidth: 32,
          style: {
            ...parentEdgeStyle,
            opacity: selectedId ? (related ? 0.95 : 0.18) : parentEdgeStyle.opacity,
          },
          zIndex: selectedId && related ? 6 : 0,
        };
      });
    return [...baseEdges, ...parentEdges, ...tagEdges];
  }, [edges, nodes, mode, notesView, boardActive, graphLocalMode, selectedNode, selectedId, neighborIds, showTagEdges, showSuggestions, tags, displayGraphNodes, activeCanvas, openBoardId, edgeKinds, boardOwnerId, noteById]);

  return { displayGraphNodes, displayGraphEdges };
}
