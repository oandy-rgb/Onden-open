// Edge type manifest.
//
// node_edges.edge_type is open-ended at the DB layer (CHECK was dropped in
// migration 024). Without a manifest, every consumer that wants to behave
// differently per type — graph view colours, sidebar icons, sync filters —
// has to hardcode a string list. The manifest centralises:
//
//   • What types exist on this instance (built-in + plugin-registered)
//   • Each type's metadata (describe, reader-facing label, colour, arrow
//     direction, whether a person may pick it for an arrow)
//   • Whether the type is in use today or reserved for a planned feature
//
// The dispatcher's handler manifest established the pattern; this one is
// identical at the seams (registerEdgeType / listEdgeTypeManifest /
// GET /api/edges/manifest) so a future visual rule editor / plugin manager
// only has to learn one shape.

import { isHexColor } from "@onden/markdown";
export type EdgeArrowMode = "source-to-target" | "bidirectional" | "none";

export type EdgeTypeSpec = {
  kind: string;
  /** For developers: what the relation is and where it comes from. */
  describe: string;
  /**
   * For readers: what the relation MEANS, as a phrase that reads before the
   * other note ("linked to" Foo, "excerpt of" Bar) — never the schema name.
   * English source text; the frontend translates it through its i18n
   * dictionary (a plugin's label without a translation shows as written).
   */
  label: string;
  /**
   * Graph line, arrowhead and legend/menu swatch colour, `#rrggbb`. It is
   * drawn only as a line or swatch next to a text label, never as text, so it
   * must reach 3:1 (WCAG 1.4.11, non-text) against the page and surface
   * backgrounds of BOTH themes — one colour serves light and dark
   * (frontend lib/edgeKinds.test.ts checks the built-ins).
   */
  color: string;
  /** Affects graph rendering: directed vs undirected. */
  arrow: EdgeArrowMode;
  /**
   * `false` (default) — the type is in active use; consumers should render it.
   * `true` — registered for substrate planning so the slot is reserved but
   * the feature isn't shipped yet; consumers can hide these.
   */
  planned?: boolean;
  /** A person may switch a graph arrow to this type (the arrow's context
   *  menu lists these, in registration order). */
  pickable?: boolean;
};

const registry = new Map<string, EdgeTypeSpec>();

export function registerEdgeType(spec: EdgeTypeSpec): void {
  if (registry.has(spec.kind)) {
    throw new Error(`[edges] edge_type already registered: ${spec.kind}`);
  }
  if (!spec.label.trim()) throw new Error(`[edges] edge_type ${spec.kind} needs a label`);
  // The graph draws it on canvas and in CSS custom properties: a literal hex,
  // never a var() or a name.
  if (!isHexColor(spec.color)) {
    throw new Error(`[edges] edge_type ${spec.kind} colour must be #rrggbb, got ${spec.color}`);
  }
  registry.set(spec.kind, spec);
}

export function listEdgeTypeManifest(): EdgeTypeSpec[] {
  return Array.from(registry.values());
}

/** True iff the type was registered. Used by POST /api/edges to log a warn
 *  when a plugin / agent / human pushes an unknown type — we still accept
 *  it so unknown-future-plugins don't break, but the log makes drift
 *  visible during dogfooding. */
export function isRegisteredEdgeType(kind: string): boolean {
  return registry.has(kind);
}

// ── Built-in registrations ──────────────────────────────────────────────────

registerEdgeType({
  kind: "knowledge_link",
  describe: "Wikilink between two content nodes ([[...]] in markdown)",
  label: "linked to",
  color: "#7a8796",  // slate
  arrow: "source-to-target",
  pickable: true,
});

registerEdgeType({
  kind: "suggested_link",
  describe: "AI / pgroonga-suggested link, awaits user confirm",
  label: "suggested link",
  color: "#ad7816",  // amber
  arrow: "source-to-target",
  pickable: true,
});

registerEdgeType({
  kind: "nav_link",
  describe: "Navigation breadcrumb (rare)",
  label: "navigates to",
  color: "#3d9468",  // green
  arrow: "source-to-target",
  pickable: true,
});

registerEdgeType({
  kind: "highlight_source",
  describe: "Child highlight node points at its source PDF/note",
  label: "excerpt of",
  color: "#4c7fd6",  // blue
  arrow: "source-to-target",
});

// ── Planned (not in use) — reserved slots so future migrations don't have
// to fight name collisions and so the manifest documents intent.

registerEdgeType({
  kind: "parent",
  describe: "Tree placement. Currently lives in content_nodes.parent_id; "
          + "will migrate here when Trilium-style clone (multi-row per node) ships.",
  // Graph views already draw parent_id as a "parent" link.
  label: "inside",
  color: "#8c6fcf",  // violet
  arrow: "source-to-target",
  planned: true,
});

registerEdgeType({
  kind: "canvas_member",
  describe: "Node placed on a canvas. Currently a node_positions row whose "
          + "surface is a canvas node id (migration 057); will migrate here "
          + "when canvas-as-edge ships.",
  label: "on board",
  color: "#a855f7",  // purple
  arrow: "none",
  planned: true,
});

registerEdgeType({
  kind: "embed",
  describe: "Note embedded inside another note's body. Planned.",
  label: "embedded in",
  color: "#2b9470",  // emerald
  arrow: "source-to-target",
  planned: true,
});
