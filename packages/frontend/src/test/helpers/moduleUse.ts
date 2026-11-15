import type { ContentNode, Tag } from "../../lib/api";
import { primeRssSources, type RssSource } from "../../modules/rss";

/** Nodes and tags that make the given built-in functions "in use"
 *  (lib/moduleUse; each module's library.inUse): a board, a
 *  published note, a day note, a paper, or — for the rest — a tag that adds the
 *  function. Tests that look at what the navigation lists spread this into the
 *  store. */
export function usedFixture(moduleIds: readonly string[], base: { nodes?: ContentNode[]; tags?: Tag[] } = {}): { nodes: ContentNode[]; tags: Tag[]; subscriptions: number } {
  const nodes: ContentNode[] = [...(base.nodes ?? [])];
  const tags: Tag[] = [...(base.tags ?? [])];
  let subscriptions = 0;
  primeRssSources(null);
  const node = (extra: Partial<ContentNode>): ContentNode => ({
    id: `used-${nodes.length}`, source_type: "manual", node_type: "content", title: `Used ${nodes.length}`, slug: `used-${nodes.length}`, markdown: "", ...extra,
  });
  for (const id of moduleIds) {
    if (id === "canvas") nodes.push(node({ collection_views: [{ id: "used-canvas-tab", layout: "canvas", layout_config: { opens_first: true } }] }));
    else if (id === "rss") subscriptions = followFeed(); // a feed is a table row, not a note (modules/rss/index.tsx)
    else if (id === "website") nodes.push(node({ attrs: { _published: "true" } }));
    else if (id === "daily") nodes.push(node({ title: "2026-10-18", slug: "2026-10-18" }));
    else {
      const moduleTag = tags.find((tag) => tag.schema_module === id)
        ?? (tags[tags.push({ id: `module-${id}`, name: id, color: null, schema_id: `module-${id}`, schema_module: id } as Tag) - 1]!);
      tags.push({ id: `user-${id}`, name: `user ${id}`, color: null, schema_id: null, schema_extends: [moduleTag.id] } as Tag);
    }
  }
  return { nodes, tags, subscriptions };
}

/** One followed feed in the reader's shared list (modules/rss/useRssUnread), which
 *  components read through useSubscriptionCount. Returns the count. */
function followFeed(): number {
  primeRssSources([{ id: "feed-1", title: "Feed", url: "https://example.com/feed.xml" } as RssSource]);
  return 1;
}
