import type { ContentNode, Tag } from "../../lib/api";
import { nodeHasTag, nodeTagIds } from "../../lib/nodeTags";
import { isShownPropertyKey } from "../../lib/childFields";
import { tagFields } from "../../lib/tagFields";
import { isSettableAttributeKey } from "@onden/markdown";
import type { FieldDef } from "../TagsPanel";
import { isTag } from "@onden/markdown/contract";

/** Plain properties (no tag defines them) that notes carrying `tagId`
 *  directly hold, with how many notes and one value to infer the type from;
 *  most used first. Reserved (`_`) and unwritable names are left out. */
export function promotableProperties(
  nodes: readonly ContentNode[], tagId: string, fields: readonly FieldDef[], tagById: ReadonlyMap<string, Tag>,
): Array<{ key: string; notes: number; sample: string }> {
  const own = new Set(fields.map((field) => field.name ?? field.key));
  const found = new Map<string, { notes: number; sample: string }>();
  for (const node of nodes) {
    if (isTag(node) || node.deleted_at || !nodeHasTag(node, tagId) || !node.attrs) continue;
    // A key one of the note's tags defines is that tag's field, not a plain property.
    const claimed = new Set(nodeTagIds(node).flatMap((id) => tagFields(tagById.get(id) ?? {}).map((field) => field.name)));
    for (const [key, value] of Object.entries(node.attrs)) {
      if (!isShownPropertyKey(key) || own.has(key) || claimed.has(key) || !isSettableAttributeKey(key)) continue;
      const entry = found.get(key) ?? { notes: 0, sample: "" };
      entry.notes += 1;
      if (!entry.sample && value) entry.sample = value;
      found.set(key, entry);
    }
  }
  return [...found].map(([key, entry]) => ({ key, ...entry }))
    .sort((a, b) => b.notes - a.notes || a.key.localeCompare(b.key));
}
