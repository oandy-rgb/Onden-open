// What a stored edge IS to the person looking at it (D74), and so where it
// shows and what they may do with it. Every view asks these predicates instead
// of filtering edge_type on its own: the board, the force graph, the Links
// lens and the canvas export each kept a different filter, and none knew an
// arrow's origin, so a [[link]]'s arrow could be deleted or retyped on a board
// and came back (with a new id) at the note's next save.
//
// Three roles, from the server's `origin` and `status` columns
// (backend db/schema.sql node_edges):
//   • derived    — active, origin other than "manual": the server re-derives it
//                  from content (`[[link]]` → origin "wikilink"). To change it, edit the text that makes it.
//   • manual     — active, origin "manual": an arrow a person (or the API)
//                  drew. Theirs to retype or delete.
//   • suggestion — not active: a machine suggestion still waiting
//                  ("suggested", origin "semantic") or one turned down
//                  ("rejected"). Not part of the link graph.
//
// The server enforces the derived rule (services/edgeWrites.ts deleteEdge
// answers 409 derived_edge), so a row from an older local mirror whose origin
// is still unknown (NULL; read as "manual") is refused there, not lost.
//
// Pure (its one import is @onden/markdown's shared list of published edge types): the app store and the published-site templates import it,
// and neither may pull in the data layer, React or prefs that lib/edgeKinds.ts
// (the edge vocabulary, D39) needs to fetch the manifest. edgeKinds re-exports
// all of it, so app code imports edge names, colours and roles from one place.
import { PUBLISHED_EDGE_TYPES } from "@onden/markdown";

/** The edge facts the roles read. `origin` is optional because a published
 *  snapshot carries none and local rows from before D74 hold NULL. */
export type EdgeFacts = {
  edge_type: string;
  status: string;
  origin?: string | null;
};

export type EdgeRole = "derived" | "manual" | "suggestion";

export function edgeRole(edge: EdgeFacts): EdgeRole {
  if (edge.status !== "active") return "suggestion";
  return (edge.origin ?? "manual") === "manual" ? "manual" : "derived";
}

/** Site navigation (nav_link) is drawn by the site studio, not by graphs. */
const NAVIGATION = "nav_link";

/** On a board: every relation, plus suggestions still waiting (drawn
 *  animated, so the person can see and dismiss them where they work) unless
 *  `suggestions` is false (the module that files them is not imported). */
export function drawsOnBoard(edge: EdgeFacts, { suggestions = true }: { suggestions?: boolean } = {}): boolean {
  if (edge.edge_type === NAVIGATION) return false;
  return edgeRole(edge) !== "suggestion" || (suggestions && edge.status === "suggested");
}

/** In the force graph, the Links lens, the overview neighbours and a board's
 *  JSON Canvas export: relations only — derived and manual, no suggestions. */
export function drawsInGraph(edge: EdgeFacts): boolean {
  return edge.edge_type !== NAVIGATION && edgeRole(edge) !== "suggestion";
}

/** A backlink (and, read the other way, an outgoing link): an active plain
 *  link, whether a `[[link]]` in the source's text or an arrow drawn by hand
 *  (docs/archive/interaction-design/09-inspector-panel.md: backlinks are the edges
 *  that target the note; the inspector shows a drawn arrow as "linked from
 *  this note" since it has no text to quote). Typed relations (supports,
 *  highlight source, cites …) and suggestions are not backlinks. */
export function countsAsBacklink(edge: EdgeFacts): boolean {
  return edge.edge_type === "knowledge_link" && edge.status === "active";
}

/** On the published site: active links of a published type. The server's
 *  snapshot applies the same rule (backend modules/website/publishing/snapshot.ts). */
export function publishes(edge: EdgeFacts): boolean {
  return edge.status === "active" && (PUBLISHED_EDGE_TYPES as readonly string[]).includes(edge.edge_type);
}

/** Delete it from a board (Delete key, the arrow menu). A derived edge goes
 *  when the text that makes it goes; a suggestion may be dismissed. */
export function canDelete(edge: EdgeFacts): boolean {
  return edgeRole(edge) !== "derived";
}

/** Change its type from the arrow menu (delete + create a manual arrow). */
export function canRetype(edge: EdgeFacts): boolean {
  return edgeRole(edge) !== "derived";
}

/** English source text (translate with t) for refusing to delete or retype
 *  a derived arrow; also the client wording of the server's 409 derived_edge. */
export const DERIVED_ARROW_HINT = "This arrow comes from the note's text (a [[link]]). Edit the note to change or remove it.";

type Pair = { source_node_id: string; target_node_id: string; edge_type: string; status: string };

/** The active `edgeType` edge from `sourceId` to `targetId`, any origin, if
 *  one exists. Drawing that arrow again would stack a second identical arrow
 *  on the first (the unique index keeps origins apart on purpose), so the
 *  board treats it as already drawn. */
export function existingRelation<E extends Pair>(edges: readonly E[], sourceId: string, targetId: string, edgeType: string): E | undefined {
  return edges.find((e) => e.source_node_id === sourceId && e.target_node_id === targetId
    && e.edge_type === edgeType && e.status === "active");
}
