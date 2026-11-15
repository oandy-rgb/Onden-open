import { useRef, useEffect, useCallback, useMemo, useState, type CSSProperties } from "react";
import { Menu, MenuItem, MenuLabel, Pressable, usePopover } from "../../components/ui";
import ForceGraph2D, {
  type ForceGraphMethods,
  type NodeObject as FGNodeObject,
  type LinkObject as FGLinkObject,
} from "react-force-graph-2d";
import type { ContentNode, NodeEdge, Tag } from "../../lib/api";
import { capGraphNodes, GRAPH_NODE_CAP } from "./graphCap";
import { ellipsize } from "@onden/markdown";
import { Maximize2, SlidersHorizontal } from "lucide-react";
import { t } from "../../lib/i18n";
import "./AllCardsGraph.css";
import { TAG_LINK_KIND, useEdgeKinds } from "../../lib/edgeKinds";
import type { GraphRole } from "../../lib/noteNeighborhood";
import { linkTuning, pinFocusNodes, roleForce, ROLE_DISTANCE } from "./graphRoleForce";
import { displayTitle } from "../../lib/noteLabel";
import { observeSize } from "../../lib/observeSize";
import { observeRootAttributes } from "../../lib/documentAccess";
import { onWindow } from "../../lib/globalEvents";
import { GRAPH_SHOW_DEFAULT, graphLines, graphView, lineCounts, type GraphShow } from "./graphVisibility";
import { createLabelPlacer, neighbourhoodOf, nodeRadius, showsLabel, tapStep } from "./graphInteraction";
import { isTag } from "@onden/markdown/contract";

/** More sub-notes than this fold into one 「子筆記 N」 point until it is clicked. */
export const CHILD_GROUP_THRESHOLD = 8;
/** The folded sub-notes' point; its node id (never a real note id). */
export const CHILD_GROUP_ID = "__children__";

type GraphNodeData = { label?: string; fill?: string; group?: boolean; tag?: boolean; lines?: number; rank?: number };
type GraphLinkData = { type?: string };
type GraphNode = FGNodeObject<GraphNodeData>;
type GraphLink = FGLinkObject<GraphNodeData, GraphLinkData>;

/** Radius of a point as drawn: by its lines (the folded sub-notes' point is larger), a little more when selected. */
const pointRadius = (node: GraphNode, selected: boolean) => node.group ? 10 : nodeRadius(node.lines ?? 0) + (selected ? 2 : 0);

/** The outline of a point: a note is a disc, a tag a diamond a little larger than the disc of the same radius. */
function tracePoint(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, tag: boolean) {
  if (tag) {
    const d = r * 1.3;
    ctx.moveTo(x, y - d); ctx.lineTo(x + d, y); ctx.lineTo(x, y + d); ctx.lineTo(x - d, y); ctx.closePath();
  } else ctx.arc(x, y, r, 0, 2 * Math.PI);
}

/** Whether the line has the point `id` at one end (react-force-graph swaps the ids for the node objects once running). */
const touches = (link: GraphLink, id: string) =>
  [link.source, link.target].some((end) => (typeof end === "object" && end !== null ? (end as { id?: unknown }).id : end) === id);

type Props = {
  nodes: ContentNode[];
  edges: NodeEdge[];
  tags?: Tag[];
  selectedNodeId: string | null;
  onNodeClick: (id: string) => void;
  /** Draw each link's direction (the info panel's small graph); the whole-workspace graph stays plain. */
  arrows?: boolean;
  /** Centre the layout on one note (the graph page's 「完整關係」): it is pinned at the origin, its
   *  parent above, notes linking to it on the left, notes it links to on the right, sub-notes below. */
  focus?: { centerId: string; roles: Record<string, GraphRole> };
};

// Roles ranked low→high for visual border weighting

export default function AllCardsGraph({ nodes, edges, tags = [], selectedNodeId, onNodeClick, arrows = false, focus }: Props) {
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(1);

  // Edge type manifest drives link colour + legend (lib/edgeKinds): plugin-
  // registered types light up automatically without touching this file.
  const edgeKinds = useEdgeKinds();

  const [size, setSize] = useState({ width: 0, height: 0 });
  const [displayOpen, setDisplayOpen] = useState(false);
  const [colors, setColors] = useState({ ink: "", muted: "", line: "", surface: "", accent: "", faint: "" });
  // Derived kinds (the tag line) name a theme colour; canvas needs the resolved value.
  const [varColors, setVarColors] = useState<Record<string, string>>({});
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    return observeSize(el, ([entry]) => {
      const width = Math.floor(entry.contentRect.width);
      const height = Math.floor(entry.contentRect.height);
      setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    });
  }, []);
  useEffect(() => {
    const update = () => {
      if (!containerRef.current) return;
      const css = getComputedStyle(containerRef.current);
      setColors({
        ink: css.getPropertyValue("--ac-ink").trim(),
        muted: css.getPropertyValue("--ac-muted").trim(),
        line: css.getPropertyValue("--ac-line").trim(),
        surface: css.getPropertyValue("--ac-bg").trim(),
        accent: css.getPropertyValue("--ac-accent").trim(),
        faint: css.getPropertyValue("--ac-faint").trim(),
      });
      setVarColors(Object.fromEntries(edgeKinds.derived.flatMap((spec) =>
        spec.colorVar ? [[spec.kind, css.getPropertyValue(spec.colorVar).trim()]] : [])));
    };
    update();
    return observeRootAttributes(["data-theme", "class", "style"], update);
  }, [edgeKinds]);

  // Tag lookup by id → color
  const tagMap = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  // Fill comes from the first class tag that has a colour; a note without one is drawn in the muted ink.
  const nodeStyle = useCallback((n: ContentNode): { fill?: string } => {
    for (const id of n.class_tag_ids ?? []) {
      const color = tagMap.get(id)?.color;
      if (color) return { fill: color };
    }
    return {};
  }, [tagMap]);

  // What is drawn (graphVisibility.ts): only notes and tags that have a line, unless 「顯示」 brings the rest back.
  // LOD/cap: react-force-graph simulates every node + link each tick, so an
  // uncapped full-instance graph freezes the main thread at scale. Cap the
  // visible nodes (always keeping the selected one) and only draw edges whose
  // both endpoints survived — a dangling edge to a dropped node would crash the
  // force engine. The "showing N of M" notice keeps the truncation honest.
  const [show, setShow] = useState<GraphShow>(GRAPH_SHOW_DEFAULT);
  const baseView = useMemo(
    () => graphView(nodes, edges, tags, show, { keepId: focus?.centerId, all: !!focus }),
    [nodes, edges, tags, show, focus],
  );
  // The note open in the app is drawn even with no line (highlighted), but only then: selecting another drawn note
  // must not rebuild the graph and restart the layout.
  const keepSelectedId = !focus && selectedNodeId && !baseView.nodes.some((n) => n.id === selectedNodeId) ? selectedNodeId : null;
  const keptView = useMemo(
    () => keepSelectedId ? graphView(nodes, edges, tags, show, { keepId: keepSelectedId }) : null,
    [keepSelectedId, nodes, edges, tags, show],
  );
  const view = keptView ?? baseView;
  const visibleNodes = view.nodes;
  // Many sub-notes are one point until it is clicked; the click is remembered
  // for this centre only.
  const [openedGroupFor, setOpenedGroupFor] = useState<string | null>(null);
  const roles = focus?.roles;
  const childIds = useMemo(
    () => roles ? visibleNodes.filter((n) => roles[n.id] === "child").map((n) => n.id) : [],
    [roles, visibleNodes],
  );
  const folded = !!focus && childIds.length > CHILD_GROUP_THRESHOLD && openedGroupFor !== focus.centerId;
  const foldedIds = useMemo(() => new Set(folded ? childIds : []), [folded, childIds]);
  // Selection normally changes only paint. Keep the force-engine objects and
  // viewport when reading another note; only an out-of-cap selection changes
  // graph membership.
  const extraSelectedId = selectedNodeId && !visibleNodes.slice(0, GRAPH_NODE_CAP).some(n => n.id === selectedNodeId)
    ? selectedNodeId : null;
  const { shown: cappedAll, total: totalNodes, capped } = useMemo(
    () => capGraphNodes(visibleNodes, GRAPH_NODE_CAP, extraSelectedId),
    [visibleNodes, extraSelectedId],
  );
  const cappedNodes = useMemo(() => foldedIds.size ? cappedAll.filter((n) => !foldedIds.has(n.id)) : cappedAll, [cappedAll, foldedIds]);
  const graphData = useMemo(() => {
    const pin = <N extends { id: string }>(n: N) => focus ? pinFocusNodes(n, focus.centerId, focus.roles) : n;
    const lines = graphLines(cappedNodes, edges, tags);
    const counts = lineCounts(lines);
    // Best-linked first: they are painted (and named) before the rest, so a crowded name goes to the lesser point.
    const ranked = [...cappedNodes].sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0));
    return {
      nodes: [
        ...ranked.map((n, rank) => pin({
          id: n.id, label: n.title, val: 1, tag: isTag(n), lines: counts.get(n.id) ?? 0, rank, ...nodeStyle(n),
        })),
        ...(folded ? [{ id: CHILD_GROUP_ID, label: t("Sub-notes {n}", { n: childIds.length }), val: 1, group: true }] : []),
      ],
      links: [
        ...(folded && focus ? [{ source: focus.centerId, target: CHILD_GROUP_ID, type: "parent" }] : []),
        ...lines,
      ],
    };
  }, [cappedNodes, edges, tags, nodeStyle, focus, folded, childIds.length]);

  // Tap once to light a note and its neighbours, again to open it (the same on a
  // phone, where a touch is not a hover). The 「完整關係」 view recentres on one
  // tap instead: that move is cheap to undo.
  const [litId, setLitId] = useState<string | null>(null);
  const lit = useMemo(
    () => litId && graphData.nodes.some((n) => n.id === litId) ? { id: litId, ids: neighbourhoodOf(litId, graphData.links) } : null,
    [litId, graphData],
  );
  const displayMenu = usePopover({ open: displayOpen, onClose: () => setDisplayOpen(false), placement: "bottom-start" });

  // The role pull needs the live simulation, so it is installed through the ref
  // once the graph has mounted and again whenever the data or the roles change.
  const ready = size.width > 0 && size.height > 0;
  useEffect(() => {
    const fg = fgRef.current;
    if (!ready || !fg) return;
    // Links would otherwise pull every neighbour in to the default 30 units; tag lines are longer and weaker.
    const link = fg.d3Force("link") as { distance?: (f: unknown) => unknown; strength?: (f: unknown) => unknown } | undefined;
    const tuning = linkTuning(graphData.links, focus ? ROLE_DISTANCE * 0.8 : undefined);
    link?.distance?.(tuning.distance);
    link?.strength?.(tuning.strength);
    if (!focus) return;
    const withGroup = folded ? { ...focus.roles, [CHILD_GROUP_ID]: "child" as const } : focus.roles;
    fg.d3Force("role", roleForce(withGroup) as never);
    fg.d3ReheatSimulation();
    return () => { fg.d3Force("role", null as never); };
  }, [ready, focus, folded, graphData]);

  // One frame's name placement (graphInteraction.ts): reset before each draw, filled as points are painted best-linked first.
  const placer = useMemo(() => createLabelPlacer(), []);
  const paintNode = useCallback((node: GraphNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const isSelected = node.id === selectedNodeId;
    const isLit = !!lit && lit.ids.has(String(node.id));
    const dimmed = !!lit && !isLit;
    const r = pointRadius(node, isSelected);
    const x = node.x ?? 0;
    const y = node.y ?? 0;
    // Canvas 2D colors must be LITERALS — fillStyle/strokeStyle silently
    // ignore CSS var() (invalid value keeps the previous style), so the theme
    // tokens are resolved once in `colors`. A note is a disc, a tag a diamond.
    const fill = isSelected ? colors.accent : node.group ? colors.ink : (node.fill ?? (node.tag ? colors.ink : colors.muted));

    ctx.globalAlpha = dimmed ? 0.15 : 1;
    ctx.beginPath();
    tracePoint(ctx, x, y, r, !!node.tag);
    ctx.fillStyle = fill;
    // The folded sub-notes are a larger, pale disc so they do not pass for a note.
    if (node.group) ctx.globalAlpha = 0.25;
    ctx.fill();
    if (isLit && lit?.id === node.id) { ctx.lineWidth = 2 / globalScale; ctx.strokeStyle = colors.accent; ctx.stroke(); }
    ctx.globalAlpha = dimmed ? 0.15 : 1;

    if (node.label !== undefined && !dimmed && (node.group || showsLabel(node.rank ?? 0, globalScale, isSelected || isLit))) {
      const text = ellipsize(`${node.tag ? "#" : ""}${displayTitle(node.label)}`, 24);
      const px = 11 / globalScale;
      ctx.font = `${px}px sans-serif`;
      ctx.textAlign = "center";
      const top = y + r + 2 / globalScale;
      const free = placer.tryPlace({ x, y: top, w: ctx.measureText(text).width + 4 / globalScale, h: px * 1.2 });
      if (free || node.group || isSelected || isLit) {
        // Halo behind the label so it stays legible over edges/other nodes.
        ctx.textBaseline = "top";
        ctx.lineWidth = 3 / globalScale;
        ctx.strokeStyle = colors.surface;
        ctx.strokeText(text, x, top);
        ctx.fillStyle = colors.ink;
        ctx.fillText(text, x, top);
      }
    }
    ctx.globalAlpha = 1;
  }, [selectedNodeId, colors, lit, placer]);

  // The tap target is the drawn size (the library's default is a fixed small disc), and at least a fingertip on a phone.
  const paintPointerArea = useCallback((node: GraphNode, color: string, ctx: CanvasRenderingContext2D, globalScale: number) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    tracePoint(ctx, node.x ?? 0, node.y ?? 0, Math.max(pointRadius(node, node.id === selectedNodeId), 12 / globalScale), !!node.tag);
    ctx.fill();
  }, [selectedNodeId]);

  const fitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fitGraph = useCallback(() => {
    const fg = fgRef.current;
    if (!fg) return;
    if (fitTimer.current) clearTimeout(fitTimer.current);
    fg.zoomToFit(300, 40);
    fitTimer.current = setTimeout(() => {
      if (fg.zoom() > 2.5) fg.zoom(2.5, 150);
    }, 350);
  }, []);
  // The early fit frames the layout while it is still spreading out; fit
  // again once the simulation settles (once per data change, so a user's own
  // zoom afterwards is left alone). Otherwise the graph ends up off-centre
  // with labels running past the edge.
  const settledFit = useRef(false);
  useEffect(() => { settledFit.current = false; }, [nodes.length, focus?.centerId, folded]);
  const fitWhenSettled = useCallback(() => {
    if (settledFit.current) return;
    settledFit.current = true;
    fitGraph();
  }, [fitGraph]);
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(fitGraph, 300);
    return () => {
      clearTimeout(timer);
      if (fitTimer.current) clearTimeout(fitTimer.current);
    };
  }, [ready, nodes.length, focus?.centerId, folded, fitGraph]);

  // Middle-mouse-button pan
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    function onDown(e: MouseEvent) {
      if (e.button !== 1) return;
      e.preventDefault();
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    }

    function onMove(e: MouseEvent) {
      if (!dragging) return;
      const fg = fgRef.current;
      if (!fg) return;
      const rect = el!.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const center = fg.screen2GraphCoords(cx, cy);
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      fg.centerAt(center.x - dx / zoomRef.current, center.y - dy / zoomRef.current, 0);
    }

    function onUp(e: MouseEvent) {
      if (e.button !== 1) return;
      dragging = false;
    }

    el.addEventListener("mousedown", onDown);
    const stopMove = onWindow("mousemove", onMove);
    const stopUp = onWindow("mouseup", onUp);
    return () => {
      el.removeEventListener("mousedown", onDown);
      stopMove();
      stopUp();
    };
  }, []);

  // Legend: types that actually appear in the current edge set, deduped and
  // looked up from the manifest. Planned-but-not-yet-emitted types are hidden
  // so the legend reflects what's on screen, not the substrate catalogue.
  const visibleTypes = useMemo(() => {
    const seen = new Set<string>();
    for (const l of graphData.links) if (l.type) seen.add(l.type);
    return [...edgeKinds.specs, ...edgeKinds.derived].filter((m) => seen.has(m.kind));
  }, [edgeKinds, graphData]);

  // The canvas is a picture to a screen reader, so the same notes are offered
  // as a list of buttons (each opens its note), with how many links it has. A
  // tag line counts as a link: it is a line on the picture, and the list should
  // match what a sighted person sees.
  const linkCounts = useMemo(() => lineCounts(graphData.links), [graphData]);
  useEffect(() => {
    containerRef.current?.querySelector("canvas")?.setAttribute("aria-hidden", "true");
  }, [ready, size]);

  return (
    <div ref={containerRef} className="all-cards-graph-wrap">
      <ul className="u-sr-only" aria-label={t("Notes in the graph")}>
        {folded && (
          <li>
            <Pressable type="button" onClick={() => setOpenedGroupFor(focus!.centerId)}>{t("Sub-notes {n}", { n: childIds.length })}</Pressable>
          </li>
        )}
        {cappedNodes.map((n) => (
          <li key={n.id}>
            <Pressable type="button" onClick={() => onNodeClick(n.id)}>
              {t("{title}, {n} links", { title: `${isTag(n) ? "#" : ""}${displayTitle(n.title)}`, n: linkCounts.get(n.id) ?? 0 })}
            </Pressable>
          </li>
        ))}
      </ul>
      <Pressable type="button" className="all-cards-graph-fit" onClick={fitGraph} aria-label={t("Fit graph")} title={t("Fit graph")}><Maximize2 size={16} /></Pressable>
      {!focus && view.isolatedNotes + view.emptyTags > 0 && (
        <div className="all-cards-graph-display" ref={displayMenu.anchor}>
          <Pressable type="button" className="all-cards-graph-display-button" aria-haspopup="menu" aria-expanded={displayOpen}
            onClick={() => setDisplayOpen((open) => !open)}>
            <SlidersHorizontal size={16} aria-hidden="true" /><span>{t("Display")}</span>
          </Pressable>
          {displayOpen && (
            <Menu popover={displayMenu} label={t("Display")}>
              <MenuLabel>{t("Also draw")}</MenuLabel>
              {view.isolatedNotes > 0 && (
                <MenuItem keepOpen checked={show.isolatedNotes} onSelect={() => setShow((s) => ({ ...s, isolatedNotes: !s.isolatedNotes }))}>
                  {t("Notes with no links ({n})", { n: view.isolatedNotes })}
                </MenuItem>
              )}
              {view.emptyTags > 0 && (
                <MenuItem keepOpen checked={show.emptyTags} onSelect={() => setShow((s) => ({ ...s, emptyTags: !s.emptyTags }))}>
                  {t("Tags with no notes ({n})", { n: view.emptyTags })}
                </MenuItem>
              )}
            </Menu>
          )}
        </div>
      )}
      {capped && (
        <div className="all-cards-graph-cap-notice">
          {t("Showing {shown} of {total} cards", { shown: cappedNodes.length, total: totalNodes })}
        </div>
      )}
      {graphData.nodes.length > 0 && (
        <div className="all-cards-graph-legend">
          <div className="all-cards-graph-legend-row">
            <span className="all-cards-graph-legend-dot" />
            <span>{t("Note")}</span>
            <span className="all-cards-graph-legend-diamond" />
            <span>{t("Tag")}</span>
          </div>
          <div className="all-cards-graph-legend-note">{t("Bigger = more links")}</div>
          {visibleTypes.map((spec) => (
            <div key={spec.kind} className="all-cards-graph-legend-row">
              <span
                className="all-cards-graph-legend-swatch"
                style={{ "--legend-color": spec.colorVar ? `var(${spec.colorVar})` : spec.color } as CSSProperties}
              />
              {/* Reader-facing relation name, never the schema identifier. */}
              <span>{edgeKinds.label(spec.kind)}</span>
            </div>
          ))}
        </div>
      )}
      {ready && <ForceGraph2D
        ref={fgRef}
        graphData={graphData}
        width={size.width}
        height={size.height}
        nodeCanvasObject={paintNode}
        nodePointerAreaPaint={paintPointerArea}
        nodeCanvasObjectMode={() => "replace"}
        linkColor={(link: GraphLink) => {
          // With a point lit, only its own lines keep their colour.
          if (lit && !touches(link, lit.id)) return colors.line;
          return (link.type && varColors[link.type]) || edgeKinds.color(link.type ?? "");
        }}
        linkWidth={(link: GraphLink) => (link.type === TAG_LINK_KIND ? 0.8 : 1.2) * (lit && touches(link, lit.id) ? 1.6 : 1)}
        linkLineDash={(link: GraphLink) => link.type === TAG_LINK_KIND ? [3, 3] : null}
        linkDirectionalArrowLength={arrows ? 4 : 0}
        linkDirectionalArrowRelPos={1}
        linkCurvature={(link: GraphLink) => link.type === "parent" ? 0.25 : 0}
        onNodeClick={(node: GraphNode) => {
          if (node.id === CHILD_GROUP_ID && focus) setOpenedGroupFor(focus.centerId);
          else if (typeof node.id !== "string") return;
          else if (focus) onNodeClick(node.id);
          else {
            const step = tapStep(lit?.id ?? null, node.id);
            setLitId(step.lit);
            if (step.open) onNodeClick(step.open);
          }
        }}
        onBackgroundClick={() => setLitId(null)}
        onRenderFramePre={() => placer.reset()}
        onZoom={({ k }: { k: number }) => { zoomRef.current = k; }}
        cooldownTicks={120}
        // Hard wall-clock bound so the simulation always pauses when it settles
        // (or after 8s for a dense graph) instead of re-running forever and
        // pinning the main thread — pairs with the node cap above.
        cooldownTime={8000}
        onEngineStop={fitWhenSettled}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.3}
        backgroundColor="transparent"
      />}
    </div>
  );
}
