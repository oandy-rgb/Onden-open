// Which notes and tags the whole-workspace graph draws, and the lines between
// them. The one place for it: the graph page and the 「完整關係」 view both go
// through AllCardsGraph, which calls this, so they never keep two rules.
//
// Default: only what has a relationship. A note with no line, and a tag with no
// note (and no tag under it), are left out — 300 unlinked notes are noise, not
// a picture. System machinery and module tags (#task, #page, …) are never
// drawn: they are the app's own, not the person's (decisions-modules.md).
// 「顯示」 can bring the two leftovers back.

import type { ContentNode, NodeEdge, Tag } from "../../lib/api";
import { drawsInGraph, TAG_LINK_KIND } from "../../lib/edgeKinds";
import { appliedNoteTags, isShownNote, isTagShown, tagKind } from "../../lib/nodeTags";
import { ancestorsOf, indexById } from "../../lib/treeWalk";
import { isSystemNode, tagsById } from "../../lib/systemNodes";
import { isTag } from "@onden/markdown/contract";

export type GraphShow = { isolatedNotes: boolean; emptyTags: boolean };
export const GRAPH_SHOW_DEFAULT: GraphShow = { isolatedNotes: false, emptyTags: false };

export type GraphLine = { source: string; target: string; type: string };

/** Whether a tag is the person's own, listed tag: not a module's tag, not a reserved or view tag, not hidden. */
const isOwnShownTag = (tag: Tag) => tagKind(tag) === "own" && isTagShown(tag);

/** Every line among `nodes`: relations, tree (parent) lines, and note → tag lines. A line needs both ends drawn. */
export function graphLines(nodes: readonly ContentNode[], edges: readonly NodeEdge[], tags: readonly Tag[]): GraphLine[] {
  const ids = new Set(nodes.map((n) => n.id));
  return [
    ...edges.filter((e) => drawsInGraph(e) && ids.has(e.source_node_id) && ids.has(e.target_node_id))
      .map((e) => ({ source: e.source_node_id, target: e.target_node_id, type: e.edge_type })),
    ...nodes.filter((n) => n.parent_id && ids.has(n.parent_id))
      .map((n) => ({ source: n.parent_id!, target: n.id, type: "parent" })),
    // A tag that is the note's parent already has its tree line.
    ...nodes.flatMap((n) => appliedNoteTags(n, tags)
      .filter((tag) => tag.id !== n.id && tag.id !== n.parent_id && ids.has(tag.id))
      .map((tag) => ({ source: n.id, target: tag.id, type: TAG_LINK_KIND }))),
  ];
}

/** Lines per node id (a tag line counts: it is a line on the picture). */
export function lineCounts(lines: readonly { source: unknown; target: unknown }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const l of lines) {
    for (const end of [l.source, l.target]) {
      const id = typeof end === "object" && end !== null ? (end as { id?: unknown }).id : end;
      if (typeof id === "string") counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

export type GraphView = {
  nodes: ContentNode[];
  lines: GraphLine[];
  /** How many notes have no line, and tags no note: left out by default, what 「顯示」 adds back. */
  isolatedNotes: number;
  emptyTags: number;
};

/**
 * The nodes and lines to draw. `keepId` (the 「完整關係」 centre, or the note open in the app) is not left out for
 * having no line; it is still a note that must be shown (never system machinery).
 * With `all`, nothing is dropped for being unlinked (the neighbourhood view: everything in it is linked to the centre).
 */
export function graphView(
  nodes: readonly ContentNode[], edges: readonly NodeEdge[], tags: readonly Tag[],
  show: GraphShow, options: { keepId?: string; all?: boolean } = {},
): GraphView {
  const tagIndex = tagsById(tags);
  const tagOf = new Map(tags.map((tag) => [tag.id, tag]));
  // Shown rows only, and never the app's own: system rows, module / reserved / hidden tags.
  const candidates = nodes.filter((n) => {
    if (!isShownNote(n) || isSystemNode(n, tagIndex)) return false;
    if (!isTag(n)) return true;
    const tag = tagOf.get(n.id);
    return !tag || isOwnShownTag(tag);
  });
  if (options.all) return { nodes: candidates, lines: graphLines(candidates, edges, tags), isolatedNotes: 0, emptyTags: 0 };

  // A tag is empty when no note carries it and no tag drawn under it has notes.
  const first = graphLines(candidates, edges, tags);
  const withNotes = new Set(first.filter((l) => l.type === TAG_LINK_KIND).map((l) => l.target));
  const tagNodes: ContentNode[] = candidates.filter((n) => isTag(n));
  const tagById = indexById(tagNodes);
  const nonEmpty = new Set(withNotes);
  for (const n of tagNodes) if (withNotes.has(n.id)) for (const up of ancestorsOf(tagById, n)) nonEmpty.add(up.id);
  const emptyTags = new Set(tagNodes.filter((n) => !nonEmpty.has(n.id) && n.id !== options.keepId));
  const withoutEmpty = show.emptyTags ? candidates : candidates.filter((n) => !emptyTags.has(n));

  const lines = graphLines(withoutEmpty, edges, tags);
  const counts = lineCounts(lines);
  const isolated = new Set(withoutEmpty.filter((n) => !isTag(n) && !counts.get(n.id) && n.id !== options.keepId));
  const shownNodes = show.isolatedNotes ? withoutEmpty : withoutEmpty.filter((n) => !isolated.has(n));
  return {
    nodes: shownNodes,
    lines,
    isolatedNotes: isolated.size,
    emptyTags: emptyTags.size,
  };
}
