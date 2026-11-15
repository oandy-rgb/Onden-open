// A published note as the site snapshot carries it (shared by the published pages and the feed).
import type { FrozenQueryBlock } from "@onden/markdown";

export type PublishedNode = {
  id: string;
  node_type: "content" | "page";
  title: string;
  slug: string;
  markdown: string;
  updated_at?: string;
  /** Sibling order (lib/childOrder). Snapshots from before D64 carry neither
   *  and are listed by title. */
  sort_order?: number;
  created_at?: string;
  /** Hierarchy for explorer-tree / breadcrumb components. The backend nulls
   *  it when the parent is not itself in the published set (D9). */
  parent_id?: string | null;
  /** The note's label tags (node_tags), built by the backend when the site
   *  is published. A `#word` in the text is not a tag (T10). Optional:
   *  snapshots predating it list none. */
  tags?: string[];
  /** Its onden-query / onden-base blocks' results, frozen when it was
   *  published (D113): what the site shows for them. */
  query_blocks?: FrozenQueryBlock[];
  /** Bodies of the `![[…]]` embeds of other published notes that the server
   *  turned into `[[…]]` links (drawingEmbeds.ts serveDrawingEmbeds). */
  embeds?: string[];
  /** The paragraphs of this page that published links or embeds (`[[A#^id]]`) point to: anchor id and where it is in
   *  `markdown` (the published text, which carries no `^id`). A page without them cannot show such a paragraph. */
  part_anchors?: Array<{ id: string; from: number; to: number }>;
};

/** The page as `servedBlockPage` (@onden/markdown) reads it: `block_ids` are the ids of the paragraphs it holds. */
export const withBlockIds = <N extends PublishedNode>(n: N): N & { block_ids: string[] } => ({ ...n, block_ids: (n.part_anchors ?? []).map((a) => a.id) });
