import type { ContentNode, Tag } from "./api";
import { isSystemTag } from "./systemNodes";
import { isTag, isNote } from "@onden/markdown/contract";

/** Whether a canvas id is a tag's own board (a tag page), not a note's board. */
export function isTagBoard(data: { tags?: readonly Pick<Tag, "id">[] }, id: string): boolean {
  return !!data.tags?.some((tag) => tag.id === id);
}

type TagMembership = Pick<ContentNode, "class_tag_ids" | "label_tag_ids">;

/** Every tag a node carries directly: class tags (with a schema) and plain
 *  label tags such as #toread. The bootstrap keeps them in two lists; any
 *  question about "is this note tagged X" needs both. */
export function nodeTagIds(node: TagMembership): string[] {
  return [...new Set([...(node.class_tag_ids ?? []), ...(node.label_tag_ids ?? [])])];
}

// ── Hidden tags (D104): the ONE "is this tag shown" rule ──────────────────
//
// Only a tag can be hidden (the user's decision; notes no longer can). A
// hidden tag keeps working everywhere — notes keep it, its fields, functions,
// views, filters and inheritance apply, search by it works — but no list,
// chip or suggestion shows it: the Tags page lists it only in its 「已隱藏」
// section, the sidebar leaves it out, a note shows no chip for it, and `#`
// suggestions offer it only when its full name is typed. Every such surface
// asks this, never `tag.hidden` itself. The site's rule is the backend's
// (modules/website/publishing/redaction.ts siteShowsTagSql).

// A module with a note switch (FrontendModule.noteSwitch: 「當成技能」) keeps its
// module tag as an inside detail: the switch adds and removes it, and no list,
// chip, picker or search ever shows it. modules/index registers those modules.
const noteSwitchModules = new Set<string>();
export function registerNoteSwitchModule(moduleId: string): void { noteSwitchModules.add(moduleId); }

// A module may keep its tag for itself: the capture module's 收件匣 marks a
// capture still waiting to be filed, and such a note leaves the note tree, so
// putting it on a note by hand would make that note disappear. The tag stays
// shown (a chip, the tag list); only the pickers leave it out (offersTag).
const appliedByAppModules = new Set<string>();
export function registerAppliedByAppModule(moduleId: string): void { appliedByAppModules.add(moduleId); }

/** Whether only the app puts `tag` on a note (BuiltInModule.appliesOwnTag). */
export function isAppliedByAppTag(tag: { schema_module?: string | null } | null | undefined): boolean {
  return !!tag?.schema_module && appliedByAppModules.has(tag.schema_module);
}

/** Which kind of tag this is — the one answer for the tag tree, `#` completion
 *  and the tag pickers:
 *    "own"      the person's tag: a name they chose;
 *  "function"   a module's tag (#複習, #論文, #任務…): shown by the function's
 *               name and icon, never by its raw name (lib/tagFunctions);
 *    "system"   state the app keeps (the workspace config, a view layout):
 *               never offered in any 「加標籤」 list. */
export type TagKind = "own" | "function" | "system";
export function tagKind(tag: { schema_module?: string | null; reserved_key?: string | null; view_module?: boolean }): TagKind {
  return tag.reserved_key || tag.view_module ? "system" : tag.schema_module ? "function" : "own";
}

/** Whether `tag` is the inside tag of a note switch (never shown, never offered,
 *  not even by its full name). */
export function isNoteSwitchTag(tag: { schema_module?: string | null } | null | undefined): boolean {
  return !!tag?.schema_module && noteSwitchModules.has(tag.schema_module);
}

/** Whether `tag` is shown in tag lists, as a chip and as a suggestion. */
export function isTagShown(tag: { hidden?: boolean | null; schema_module?: string | null } | null | undefined): boolean {
  return !tag?.hidden && !isNoteSwitchTag(tag);
}

/** The tags of `tags` that are shown (isTagShown), in their order. */
export function shownTags<T extends { hidden?: boolean | null; schema_module?: string | null }>(tags: readonly T[]): T[] {
  return tags.filter(isTagShown);
}

/** The tags of `tags` the owner hid, in their order (the 「已隱藏」 list). A
 *  note switch's inside tag is no owner choice and is in no list. */
export function hiddenTags<T extends { hidden?: boolean | null; schema_module?: string | null }>(tags: readonly T[]): T[] {
  return tags.filter((tag) => !isTagShown(tag) && !isNoteSwitchTag(tag));
}

/** The note's tags that are listed on it (title chips, tag cards), in
 *  catalog order: not the system tag, not a hidden one. */
export function appliedNoteTags(node: TagMembership, tags: readonly Tag[]): Tag[] {
  const memberships = new Set(nodeTagIds(node));
  // TODO(#302): switch to TAG_LISTINGS.shownOnNote (shownOnNote(tag, TAG_ROLES))
  // once the tag-roles PR lands; this is the rule main uses today.
  return tags.filter((tag) => !isSystemTag(tag) && isTagShown(tag) && memberships.has(tag.id));
}

export function nodeHasTag(node: TagMembership, tagId: string): boolean {
  return (node.class_tag_ids ?? []).includes(tagId) || (node.label_tag_ids ?? []).includes(tagId);
}

/** Whether the note carries the tag X as a class tag (one with a schema). */
export function nodeHasClassTag(node: Pick<ContentNode, "class_tag_ids">, tagId: string): boolean {
  return (node.class_tag_ids ?? []).includes(tagId);
}

// ── 「標籤 X 的筆記」: one answer (T4) ─────────────────────────────────────────
//
// A note is a member of tag X when it carries X, a child tag of X (課程/演算法
// is a member of 課程) or a tag that extends X (繼承), at any depth. The
// backend answers the same way (services/tagHierarchy.ts memberTagIds — saved
// views, /api/query); test/fixtures/tagMembershipParity.json holds both ends,
// the sidebar and the tag page to it. Callers do not combine nodeTagIds with
// their own child/extends walk. A `#name` written in a note's text is not
// membership (T10, user decision 2026-10-16): only stored tags count.

type TagGraph = Pick<Tag, "id" | "parent_id" | "schema_extends"> & Partial<Pick<Tag, "view_module">>;
type MemberRow = TagMembership & Pick<ContentNode, "node_type"> &
  Partial<Pick<ContentNode, "hidden" | "deleted_at" | "source_type">>;

/** Ids whose notes count as members of `tagId`: the tag, its child tags and
 *  the tags that extend it, at any depth. */
export function memberTagIds(tags: readonly TagGraph[], tagId: string): string[] {
  // A view module tag (#月曆…): the tags extending it use a view, they are not
  // kinds of it — no members (backend tagHierarchy.memberTagIds, the same rule).
  if (tags.some((tag) => tag.id === tagId && tag.view_module)) return [tagId];
  const below = new Map<string, string[]>();
  const add = (parent: string, child: string) => below.set(parent, [...(below.get(parent) ?? []), child]);
  for (const tag of tags) {
    if (tag.parent_id) add(tag.parent_id, tag.id);
    for (const parent of tag.schema_extends ?? []) add(parent, tag.id);
  }
  const found = new Set<string>([tagId]);
  for (const queue = [tagId]; queue.length;) {
    for (const child of below.get(queue.shift()!) ?? []) {
      if (!found.has(child)) { found.add(child); queue.push(child); }
    }
  }
  return [...found];
}

/** Whether a row can be listed as a tag's member: a live, visible note or
 *  board — not a tag definition, a hidden capture or system machinery
 *  (source_type='system'). Saved views drop the same rows except that they
 *  also list a tag definition carrying a tag. */
export function listsAsTagMember(node: Partial<Pick<ContentNode, "hidden" | "deleted_at" | "source_type">> & Pick<ContentNode, "node_type">): boolean {
  return isShownNote(node) && !isTag(node) && node.source_type !== "system";
}

/** The row exists for the person: not hidden (a capture or machinery row) and
 *  not deleted. The floor of every list; graphs and relation pickers stop here. */
export function isShownNote(node: Partial<Pick<ContentNode, "hidden" | "deleted_at">>): boolean {
  return !node.hidden && !node.deleted_at;
}

/** A note a list or picker offers to choose: shown, an ordinary note (not a tag
 *  definition or the retired board kind) and not system machinery. The one rule
 *  for "which notes can I pick" — a picker that needs fewer rows says so by name
 *  (isShownNote), it does not recombine hidden / deleted / node_type / source_type. */
export function listsAsNote(node: Partial<Pick<ContentNode, "hidden" | "deleted_at" | "source_type">> & { node_type: string }): boolean {
  return isShownNote(node) && isNote(node) && node.source_type !== "system";
}

/** The rows of `nodes` that are members of `tagId`, in their given order. */
export function tagMembers<N extends MemberRow>(
  tags: readonly TagGraph[], nodes: readonly N[], tagId: string,
): N[] {
  const ids = new Set(memberTagIds(tags, tagId));
  return nodes.filter((node) => listsAsTagMember(node) && nodeTagIds(node).some((id) => ids.has(id)));
}

/** tagMembers(...).length for every tag in `tags`, in one pass over `nodes`.
 *  Tags with no member are absent. */
export function tagMemberCounts(
  tags: readonly TagGraph[], nodes: readonly MemberRow[],
): Map<string, number> {
  // Walk up instead of down: a note carrying C is a member of C's parent and
  // of every tag C extends, and so on — except a view module tag (#月曆…),
  // which has no members (memberTagIds).
  const viewModules = new Set(tags.filter((tag) => tag.view_module).map((tag) => tag.id));
  const above = new Map<string, string[]>();
  for (const tag of tags) {
    above.set(tag.id, [...(tag.parent_id ? [tag.parent_id] : []), ...(tag.schema_extends ?? [])].filter((id) => !viewModules.has(id)));
  }
  const closure = new Map<string, string[]>();
  const memberOf = (carried: string): string[] => {
    let found = closure.get(carried);
    if (found) return found;
    const seen = new Set([carried]);
    for (const queue = [carried]; queue.length;) {
      for (const next of above.get(queue.shift()!) ?? []) {
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    found = [...seen];
    closure.set(carried, found);
    return found;
  };
  const known = new Set(tags.map((tag) => tag.id));
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (!listsAsTagMember(node)) continue;
    const of = new Set(nodeTagIds(node).filter((id) => known.has(id)).flatMap(memberOf));
    for (const id of of) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** How many listed notes carry each tag DIRECTLY (no child tags, no
 *  extenders). A usage figure — "N notes are tagged #x" — not the
 *  member count; the server's usage_count (services/tagCatalog.ts) is the
 *  same direct figure. */
export function directTagUsage(nodes: readonly MemberRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (!listsAsTagMember(node)) continue;
    for (const id of nodeTagIds(node)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** EvalContext.tagMembers over the workspace's tags: every tag named `name`
 *  (case-insensitive) and their members, cached per name. */
export function tagMembersResolver(
  tags: readonly { id: string; name: string; parent_id?: string | null; schema_extends?: string[] | null; view_module?: boolean }[],
): (name: string) => ReadonlySet<string> {
  const cache = new Map<string, ReadonlySet<string>>();
  return (name) => {
    const key = name.toLowerCase();
    let members = cache.get(key);
    if (!members) {
      members = new Set(tags.filter((t) => t.name.toLowerCase() === key).flatMap((t) => memberTagIds(tags, t.id)));
      cache.set(key, members);
    }
    return members;
  };
}
