import type { ContentNode, NodeEdge, Tag } from "./api";
import { countsAsBacklink, drawsInGraph } from "./edgeKinds";
import { appliedNoteTags, nodeHasTag } from "./nodeTags";
import { isTag } from "@onden/markdown/contract";

// One note's 1-hop neighbourhood — the relations the graph draws (drawsInGraph),
// its parent and its children. The one source for the info panel's 「關係」 tab,
// the 「完整關係」 graph and the lists under the note body (NoteRelations, via
// noteLinks). Hidden notes never show; system notes follow the same rules as
// the rest of the graph.
//
// Tags are the layer above notes (功能 → 標籤 → 筆記): a note's shown tags are
// its `tag` relations; a tag's own neighbourhood lists the notes that carry it
// as `member`s. Which tags count is appliedNoteTags (hidden, system and
// note-switch tags never do), the rule the title chips use.

/** `out`: this note links to it; `in`: it links to this note; `tag`: a tag this
 *  note carries; `member`: a note carrying this (tag) note. */
export type RelationDirection = "out" | "in" | "parent" | "child" | "tag" | "member";

export type NoteRelation = {
  direction: RelationDirection;
  /** The edge type for `out`/`in`; absent for parent and child. */
  edgeType?: string;
  /** `out`/`in` only: an active plain link (countsAsBacklink), what 「提到這篇」 and
   *  「連出去的連結」 list; a typed relation is drawn but is not a backlink. */
  plainLink?: boolean;
  node: ContentNode;
};

export type NoteNeighborhood = {
  localNodes: ContentNode[];
  localEdges: NodeEdge[];
  relations: NoteRelation[];
};

export function noteNeighborhood(node: ContentNode, nodes: readonly ContentNode[], edges: readonly NodeEdge[], tags: readonly Tag[] = []): NoteNeighborhood {
  const ids = new Set<string>([node.id]);
  const relations: NoteRelation[] = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of edges) {
    if (!drawsInGraph(e)) continue;
    const outgoing = e.source_node_id === node.id;
    const otherId = outgoing ? e.target_node_id : e.target_node_id === node.id ? e.source_node_id : null;
    if (!otherId) continue;
    ids.add(otherId);
    const other = byId.get(otherId);
    if (other && !other.hidden) relations.push({ direction: outgoing ? "out" : "in", edgeType: e.edge_type, plainLink: countsAsBacklink(e), node: other });
  }
  if (node.parent_id) {
    ids.add(node.parent_id);
    const parent = byId.get(node.parent_id);
    if (parent && !parent.hidden) relations.push({ direction: "parent", node: parent });
  }
  for (const n of nodes) {
    if (n.parent_id !== node.id) continue;
    ids.add(n.id);
    if (!n.hidden) relations.push({ direction: "child", node: n });
  }
  // A parent or sub-note that is also tagged stays one relation (the tree line).
  const inTree = new Set(relations.filter((r) => r.direction === "parent" || r.direction === "child").map((r) => r.node.id));
  if (isTag(node)) {
    for (const n of nodes) {
      if (n.id === node.id || n.hidden || inTree.has(n.id) || !nodeHasTag(n, node.id)) continue;
      ids.add(n.id);
      relations.push({ direction: "member", node: n });
    }
  } else {
    for (const tag of appliedNoteTags(node, tags)) {
      const tagNode = byId.get(tag.id);
      if (!tagNode || tagNode.hidden || inTree.has(tag.id)) continue;
      ids.add(tag.id);
      relations.push({ direction: "tag", node: tagNode });
    }
  }
  const localNodes = nodes.filter((n) => ids.has(n.id) && !n.hidden);
  const present = new Set(localNodes.map((n) => n.id));
  const localEdges = edges.filter((e) => present.has(e.source_node_id) && present.has(e.target_node_id));
  return { localNodes, localEdges, relations };
}

export type NoteLinks = {
  /** Notes with an active plain link to this one. */
  backlinks: ContentNode[];
  /** Notes this one links to by an active plain link. */
  outgoing: ContentNode[];
  children: ContentNode[];
};

/** The lists under the note body, from `noteNeighborhood(...).relations`: a note
 *  linked twice (its [[link]] and an arrow drawn by hand) is listed once. */
export function noteLinks(relations: readonly NoteRelation[]): NoteLinks {
  const distinct = (direction: RelationDirection, plainOnly: boolean): ContentNode[] => {
    const seen = new Set<string>();
    const out: ContentNode[] = [];
    for (const r of relations) {
      if (r.direction !== direction || (plainOnly && !r.plainLink) || seen.has(r.node.id)) continue;
      seen.add(r.node.id);
      out.push(r.node);
    }
    return out;
  };
  return { backlinks: distinct("in", true), outgoing: distinct("out", true), children: distinct("child", false) };
}

/** Where a neighbour sits around the centre of the 「完整關係」 graph. The notes
 *  carrying a centre tag (`member`) sit with the sub-notes: below, and folded
 *  into one point when there are many. */
export type GraphRole = Exclude<RelationDirection, "member">;

// One role per neighbour. A note that is both linked from and linked to the
// centre counts as `out`; a parent or child relation outranks a plain link.
const ROLE_RANK: Record<GraphRole, number> = { parent: 0, child: 1, out: 2, in: 3, tag: 4 };

export function graphRoles(relations: readonly NoteRelation[]): Record<string, GraphRole> {
  const roles: Record<string, GraphRole> = {};
  for (const r of relations) {
    const role: GraphRole = r.direction === "member" ? "child" : r.direction;
    const current = roles[r.node.id];
    if (!current || ROLE_RANK[role] < ROLE_RANK[current]) roles[r.node.id] = role;
  }
  return roles;
}
