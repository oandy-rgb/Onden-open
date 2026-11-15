import type { ContentNode } from "./api";
import { linkNamesNote } from "@onden/markdown";

/** Whether a `[[label]]` names this note — @onden/markdown's linkNamesNote,
 *  the rule the server's wikilink edges use (title, slug or alias). */
export function nodeMatchesLink(node: Pick<ContentNode, "title" | "slug" | "attrs">, label: string): boolean {
  return linkNamesNote(label, { title: node.title, slug: node.slug, aliases: noteAliases(node.attrs?.aliases) });
}

/** A note's `aliases` attribute: a JSON array (frontmatter import) or one bare alias. */
export function noteAliases(value: string | undefined): string[] {
  if (!value) return [];
  if (!value.startsWith("[")) return [value];
  try {
    const list = JSON.parse(value) as unknown;
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

export function classNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** The nodes in `nodes` that are the parent of another node in `nodes`, in
 *  list order. Linear: the sidebar calls it on every render, and the old
 *  `filter(n => nodes.some(c => c.parent_id === n.id))` was quadratic
 *  (25M comparisons, ~350 ms per render at 5,000 notes). */
export function groupNodes<T extends Pick<ContentNode, "id" | "parent_id">>(nodes: readonly T[]): T[] {
  const parents = new Set<string>();
  for (const node of nodes) if (node.parent_id) parents.add(node.parent_id);
  return nodes.filter((node) => parents.has(node.id));
}

