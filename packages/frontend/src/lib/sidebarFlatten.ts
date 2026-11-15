// ④ list virtualization: flatten the sidebar tree (honoring expansion) into
// the row sequence the windowed renderer slices. Pure — the traversal order
// must exactly mirror the recursive renderer's DOM order (node, then its
// children, then its pinned-pointer rows), so the two paths are visually
// interchangeable.

import type { ContentNode, NotePointer } from "./api";

export type FlatRow =
  | { kind: "node"; item: ContentNode; depth: number }
  | { kind: "pointer"; pointer: NotePointer; depth: number }
  // A space heading above that space's top-level notes (spaces on).
  | { kind: "space"; spaceId: string; label: string; depth: 0 };

/** Top-level notes grouped under their space, in the given space order
 *  (notes whose space is not listed go last, under `otherLabel`). */
export type SpaceGroup = { spaceId: string; label: string; roots: ContentNode[] };
export function groupRootsBySpace(
  roots: ContentNode[], spaces: Array<{ id: string; label: string }>, otherLabel: string,
): SpaceGroup[] {
  const known = new Set(spaces.map((s) => s.id));
  const groups: SpaceGroup[] = spaces.map((s) => ({ spaceId: s.id, label: s.label, roots: roots.filter((r) => r.space_id === s.id) }));
  const rest = roots.filter((r) => !r.space_id || !known.has(r.space_id));
  if (rest.length) groups.push({ spaceId: "", label: otherLabel, roots: rest });
  return groups.filter((g) => g.roots.length > 0);
}

export function flattenSidebarTree(
  roots: ContentNode[],
  childrenByParent: Map<string, ContentNode[]>,
  pointersByParent: Map<string, NotePointer[]>,
  expandedGroups: Set<string>,
  spaceGroups: SpaceGroup[] | null = null,
): FlatRow[] {
  const out: FlatRow[] = [];
  const visit = (item: ContentNode, depth: number, visited: Set<string>) => {
    if (visited.has(item.id)) return;
    visited.add(item.id);
    out.push({ kind: "node", item, depth });
    const children = childrenByParent.get(item.id) ?? [];
    const pointers = pointersByParent.get(item.id) ?? [];
    const isGroup = children.length > 0 || pointers.length > 0;
    if (!isGroup || !expandedGroups.has(item.id)) return;
    for (const child of children) visit(child, depth + 1, visited);
    for (const p of pointers) out.push({ kind: "pointer", pointer: p, depth: depth + 1 });
  };
  const seen = new Set<string>();
  if (spaceGroups) {
    for (const g of spaceGroups) {
      out.push({ kind: "space", spaceId: g.spaceId, label: g.label, depth: 0 });
      for (const root of g.roots) visit(root, 0, seen);
    }
    return out;
  }
  for (const root of roots) visit(root, 0, seen);
  return out;
}

/** The slice of `rowCount` flat rows to render, with `overscan` extra rows on
 *  each side. `offsetTop` is how far the list's top edge has scrolled past the
 *  top of the visible area (0 while the list starts below it) and `viewport`
 *  the visible height, both in px; `rowPitch` is one row's height plus gap.
 *  The windowed renderer pads the rows before `start` and after `end` with
 *  spacers, so the list keeps its full height. */
export function sidebarWindow(
  rowCount: number, offsetTop: number, viewport: number, rowPitch: number, overscan: number,
): { start: number; end: number } {
  const pitch = rowPitch > 0 ? rowPitch : 1;
  const start = Math.min(rowCount, Math.max(0, Math.floor(Math.max(0, offsetTop) / pitch) - overscan));
  const end = Math.min(rowCount, start + Math.ceil(Math.max(0, viewport) / pitch) + 2 * overscan);
  return { start, end };
}
