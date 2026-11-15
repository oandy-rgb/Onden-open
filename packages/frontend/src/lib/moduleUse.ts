// What "in use" means for a built-in function (docs/architecture/module-library.md,
// 「用到才出現」): the default navigation bars a function only once it is in use.
// 「更多」 lists every function that is on, used or not; a function the person
// pinned stays pinned (hooks/shellNavigation, lib/navLayout).
//
// The answer is computed from data the client already holds (the note list and
// the tag catalog), so it is instant and works offline. Each module may say what
// "in use" is for it (FrontendModule.library.inUse: a board exists, a note is
// marked for publishing…; RSS: a feed is subscribed, counted from the reader's shared
// feed list because the feeds are a server table the note list cannot show); `moduleInUse` in modules/index.ts asks it. A module without its
// own rule is in use once its module tag is used (`tagUsed`).
import type { ContentNode, Tag } from "./api";
import { moduleTagOf, tagFunctions } from "./tagModules";
import { nodeHasTag } from "./nodeTags";

/** `subscriptions`: feeds the person can see (RSS keeps them in a server table, so
 *  the note list cannot show them); the shared reader state fills it, absent = 0. */
export type ModuleUseData = { nodes: readonly ContentNode[]; tags: readonly Tag[]; subscriptions?: number };

/** The module's tag is used: a tag extends it (a function reference it already holds), the older per-tag
 *  switch is on, or a note carries the tag directly. */
export function tagUsed(moduleId: string, { nodes, tags }: ModuleUseData): boolean {
  // A tag other than the module's own tag has the function (a reference the person added).
  if (tags.some((tag) => tag.schema_module !== moduleId && tagFunctions(tag).some((fn) => fn.id === moduleId))) return true;
  const moduleTag = moduleTagOf(tags, moduleId);
  if (!moduleTag) return false;
  // A catalog row kept from before function references (no `functions`) says it by extending the module's tag.
  return tags.some((tag) => !tag.functions && tag.schema_extends?.includes(moduleTag.id))
    || nodes.some((n) => nodeHasTag(n, moduleTag.id));
}
