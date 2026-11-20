// The links between published notes, read off the published text itself.
//
// `node_edges` is a cache of the [[links]] a note's save derived (wikilinkEdges.ts);
// a note that was imported, restored or moved without a re-save can lack its
// rows, and then a published page shows no backlinks and no graph although its
// text links to others. The snapshot's edges therefore also come from the
// text a reader gets: the same rule the site opens a link by (`servedLinkTarget`),
// over the same notes. A link to an unpublished note was made inert by
// redaction before this runs, so it names nothing here and is never an edge.
import { servedLinkTarget, wikilinkBodies } from "@onden/markdown";
import { PUBLISHED_EDGE_TYPES } from "@onden/markdown";

type TextEdge = { source_node_id: string; target_node_id: string; edge_type: string };
type Page = { id: string; title: string; slug: string; markdown: string };

const TEXT_EDGE_TYPE = PUBLISHED_EDGE_TYPES[0];

/** `known` first (the stored edges, kept as they are), then one edge per
 *  (source, target) the published text links or embeds that no stored edge has.
 *  Self-links and links to a note outside `pages` are not edges. */
export function withTextEdges<E extends TextEdge>(pages: readonly Page[], known: readonly E[]): Array<E | TextEdge> {
  const seen = new Set(known.filter((e) => e.edge_type === TEXT_EDGE_TYPE).map((e) => `${e.source_node_id}>${e.target_node_id}`));
  const out: Array<E | TextEdge> = [...known];
  for (const page of pages) {
    if (typeof page.markdown !== "string" || !page.markdown.includes("[[")) continue;
    for (const body of wikilinkBodies(page.markdown)) {
      const target = servedLinkTarget(body, pages, page.id);
      if (!target || target.id === page.id) continue;
      const key = `${page.id}>${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ source_node_id: page.id, target_node_id: target.id, edge_type: TEXT_EDGE_TYPE });
    }
  }
  return out;
}
