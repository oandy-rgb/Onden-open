// The places a note, a new note or a new tag may go, grouped by space — what
// components/PlacePicker lists. The rule for one note under another is
// lib/data placementCandidates (D101); this adds the space layer:
//   • a move offers the note's own space, plus every other space the person
//     may move it into (capabilities canMoveOut of the old, canMoveInto of the
//     new), and only while online (a move between spaces is online-only);
//   • a new note offers every writable space (lib/newNoteTarget);
//   • a tag has one group with no space (tags are global).
// Which space a pick lands in is the group's, so a pick is `{ spaceId, parentId }`.
import type { ContentNode } from "./api";
import type { Capabilities } from "./capabilities";
import { placementCandidates } from "./data";
import { canHoldNewNotes, writableSpaces } from "./newNoteTarget";
import type { Space } from "./spaces";
import { displayTitle } from "./noteLabel";
import { TAG_NODE_TYPE } from "@onden/markdown/contract";

/** A note (or tag) a pick may go under, with where it stands in its group's tree. */
export type PlaceEntry = {
  /** The id picked as the new parent. */
  parentId: string;
  title: string;
  /** Steps below the group's top, as drawn when not searching. */
  depth: number;
  /** The title of its own parent, when it has one in the list. */
  parentTitle?: string;
};
/** `space` null: no space to name (a tag, or spaces not loaded yet). */
export type PlaceGroup = { space: Space | null; entries: PlaceEntry[] };
/** `parentId` null: the group's top level. */
export type PlaceChoice = { spaceId: string | null; parentId: string | null };

type Treelike = Pick<ContentNode, "id" | "parent_id">;

/** `items` in tree order (each parent before its children, siblings as given)
 *  with their depth. An item whose parent is not in `items` starts a branch. */
function inTreeOrder<N extends Treelike>(items: readonly N[]): Array<{ item: N; depth: number }> {
  const ids = new Set(items.map((n) => n.id));
  const kids = new Map<string | null, N[]>();
  for (const n of items) {
    const key = n.parent_id && ids.has(n.parent_id) ? n.parent_id : null;
    const list = kids.get(key);
    if (list) list.push(n); else kids.set(key, [n]);
  }
  const out: Array<{ item: N; depth: number }> = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const n of kids.get(parent) ?? []) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      out.push({ item: n, depth });
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function entriesOf(items: readonly ContentNode[], title: (n: ContentNode) => string): PlaceEntry[] {
  const titles = new Map(items.map((n) => [n.id, title(n)]));
  return inTreeOrder(items).map(({ item, depth }) => ({
    parentId: item.id, title: title(item), depth,
    parentTitle: item.parent_id ? titles.get(item.parent_id) : undefined,
  }));
}

const noteTitle = (n: ContentNode) => displayTitle(n.title);
const personalFirst = (spaces: readonly Space[]) => [...spaces].sort((a, b) => Number(b.kind === "personal") - Number(a.kind === "personal"));

/** Where `node` may be moved. Only its own space when it may not leave it (or
 *  offline); one group with no space while the spaces are not known. */
export function movePlaceGroups(node: ContentNode, nodes: readonly ContentNode[], spaces: readonly Space[], caps: Capabilities, online: boolean): PlaceGroup[] {
  // Without a space of its own, the placement rule would refuse every other space.
  const child = { id: node.id, node_type: node.node_type };
  const candidates = placementCandidates(child, nodes, { canEdit: caps.canEdit });
  const origin = spaces.find((s) => s.id === node.space_id);
  if (!origin) return [{ space: null, entries: entriesOf(candidates, noteTitle) }];
  const mayLeave = online && caps.canEdit(node) && caps.canMoveOut(origin);
  const offered = personalFirst(spaces).filter((s) => s.id === origin.id || (mayLeave && s.kind !== "system" && caps.canMoveInto(s)));
  return offered.map((space) => ({ space, entries: entriesOf(candidates.filter((n) => n.space_id === space.id), noteTitle) }));
}

/** Where a new note may go: one group per writable space (a single group, with
 *  no space named, when there is no choice of space). */
export function newNotePlaceGroups(nodes: readonly ContentNode[], spaces: readonly Space[], caps: Capabilities): PlaceGroup[] {
  const writable = writableSpaces(spaces);
  const holders = placementCandidates(undefined, nodes, { canEdit: caps.canEdit }).filter((n) => canHoldNewNotes(n) && !n.hidden);
  if (writable.length < 2) return [{ space: null, entries: entriesOf(holders, noteTitle) }];
  return writable.map((space) => ({ space, entries: entriesOf(holders.filter((n) => n.space_id === space.id), noteTitle) }));
}

/** Where a new tag may go: under another tag, one group (tags have no space). */
export function tagPlaceGroup(tags: ReadonlyArray<{ id: string; name: string; parent_id?: string | null }>, canEdit: Capabilities["canEdit"]): PlaceGroup[] {
  const rows = tags.map((tag) => ({ id: tag.id, node_type: TAG_NODE_TYPE, parent_id: tag.parent_id ?? null, name: tag.name }));
  const names = new Map(tags.map((tag) => [tag.id, tag.name]));
  const places = placementCandidates({ isTag: true }, rows, { canEdit });
  const entries = inTreeOrder(places).map(({ item, depth }): PlaceEntry => ({
    parentId: item.id, title: item.name, depth, parentTitle: item.parent_id ? names.get(item.parent_id) : undefined,
  }));
  return [{ space: null, entries }];
}
