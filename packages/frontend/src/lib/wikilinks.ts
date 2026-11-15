import { linkNamesNote, scanWikilinks, type WikilinkMatch } from "@onden/markdown";
import type { ContentNode } from "./api";
import { nodeMatchesLink } from "./utils";
import { isTag } from "@onden/markdown/contract";

// Which note a `[[label]]` names — the app's one copy of the server's rule
// (backend services/nodes.ts syncWikilinkEdges). A link names a note by title
// (case-insensitive), slug or alias, `|alias` and `#anchor` dropped
// (nodeMatchesLink); a TITLE resolves within the linking note's space, a tag
// is global; trashed notes do not count. Before this module the renderer,
// version history, backlink snippets and openWikilink each had their own
// `nodes.find(nodeMatchesLink)`, and only openWikilink applied the space rule
// — so a same-titled note in another space could win (D43).

/** The fields a link target is read from. `space_id` undefined = unknown
 *  (a published page, an optimistic local row): such a row is not filtered. */
export type WikilinkNode = Pick<ContentNode, "id" | "title" | "slug">
  & Partial<Pick<ContentNode, "space_id" | "attrs" | "deleted_at">>
  & { node_type?: string }; // a published page's kind is not ContentNode's

/** The note a link is written in — its space scopes the lookup. Omitted where
 *  there is none (the published site renders one site's pages). */
export type WikilinkSource = Partial<Pick<ContentNode, "id" | "space_id">>;

/** Whether `[[label]]` written in `from` names `node`: the server's edge rule. */
export function wikilinkReaches(label: string, from: WikilinkSource | null | undefined, node: WikilinkNode): boolean {
  if (node.deleted_at) return false;
  if (!nodeMatchesLink(node, label)) return false;
  if (isTag(node)) return true; // tags are global
  // The server compares with IS NOT DISTINCT FROM: a note without a space is
  // reached only from a note without one. Unknown (undefined) on either side
  // is not filtered — older servers and local rows don't carry it.
  if (!from || from.space_id === undefined || node.space_id === undefined) return true;
  return (node.space_id ?? null) === (from.space_id ?? null);
}

/** The one note `[[label]]` written in `from` opens, or null when it names
 *  none. The server links EVERY match; when several are reachable this picks
 *  the first in `nodes` order, the linking note itself last (the server never
 *  links a note to itself, but `[[My own title]]` should still open it rather
 *  than create a copy). */
export function resolveWikilink<T extends WikilinkNode>(
  label: string, from: WikilinkSource | null | undefined, nodes: readonly T[] | undefined,
): T | null {
  let self: T | null = null;
  for (const node of nodes ?? []) {
    if (!wikilinkReaches(label, from, node)) continue;
    if (from?.id != null && node.id === from.id) { self ??= node; continue; }
    return node;
  }
  return self;
}

/** The first `[[…]]` in `source`'s markdown that names `target` (alias, anchor
 *  and slug forms included), or null. What a backlink snippet highlights and
 *  where clicking the backlink puts the cursor. */
export function wikilinkSpan(
  md: string, source: WikilinkSource | null | undefined, target: WikilinkNode,
): WikilinkMatch | null {
  if (!md.includes("[[")) return null;
  for (const match of scanWikilinks(md)) {
    if (wikilinkReaches(match.body, source, target)) return match;
  }
  return null;
}

/** The notes and tags a link NAME names — title, slug or alias — before the
 *  space rule (wikilinkReaches applies it), cached per name. What a base's
 *  `file.hasLink(name)` checks its links against. */
export function linkNameTargets<T extends WikilinkNode>(nodes: readonly T[]): (name: string) => readonly T[] {
  const cache = new Map<string, readonly T[]>();
  return (name) => {
    let targets = cache.get(name);
    if (!targets) {
      targets = nodes.filter((n) => nodeMatchesLink(n, name));
      cache.set(name, targets);
    }
    return targets;
  };
}

/** Whether a `[[…]]` body names `title` — a dangling link, one that reaches
 *  no note, still links by name. */
export function wikilinkNamesTitle(body: string, title: string): boolean {
  return linkNamesNote(body, { title });
}
