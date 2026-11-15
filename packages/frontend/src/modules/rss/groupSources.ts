import { tagPath } from "../../lib/data";
import type { Tag } from "../../lib/api";
import type { RssSource } from "./useRssUnread";

// 閱讀 › RSS lists feeds grouped like folders: by the first tag of each feed's
// save default (where its articles go), labelled with the tag's path
// (#新聞/科技). Groups go alphabetically; feeds whose default has no tag go
// last, in one group without a tag (`tagId: null`). Order within a group is
// the server's (by title).

export type SourceGroup = { tagId: string | null; label: string; sources: RssSource[] };

export function groupSources(sources: readonly RssSource[], tags: readonly Pick<Tag, "id" | "name" | "parent_id">[]): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  const loose: RssSource[] = [];
  for (const source of sources) {
    const tagId = source.save_default?.tag_ids[0];
    const label = tagId ? tagPath(tags, tagId) : "";
    if (!tagId || !label) { loose.push(source); continue; }
    const group = groups.get(tagId) ?? { tagId, label, sources: [] };
    group.sources.push(source);
    groups.set(tagId, group);
  }
  const sorted = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
  return loose.length ? [...sorted, { tagId: null, label: "", sources: loose }] : sorted;
}
