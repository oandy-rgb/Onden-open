// Test data for the studio: a handful of notes and tags as the store holds them. A note starts kept off the site
// (「不發布」: in a space that publishes, a note with words is on it otherwise); `published` puts it on.
import type { ContentNode, Tag } from "../../../lib/api";

export const published = { _published: "true" };
export const kept = { _published: "false" };

export function node(over: Partial<ContentNode> & { id: string; title: string }): ContentNode {
  return {
    source_type: "manual", node_type: "content", slug: over.title.toLowerCase().replace(/\s+/g, "-"), markdown: `# ${over.title}\n\nBody of ${over.title}.`,
    created_at: "2026-03-01T00:00:00Z", updated_at: "2026-03-02T00:00:00Z", class_tag_ids: [], label_tag_ids: [], attrs: kept,
    ...over,
  } as ContentNode;
}

export function tag(over: Partial<Tag> & { id: string; name: string }): Tag {
  return { color: null, schema_id: over.id, ...over } as Tag;
}
