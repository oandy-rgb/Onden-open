// The part of a state that both sides can be compared on: what the engine's World says (materialize) and what the real tables hold.
// The projection writes toward worldView(); the shadow comparison (tests, and the diagnostic in replica.ts) checks dbView() against it.
// Only what the engine carries is here: space names and members, and per note its space, kind, title, body, parent, deleted flag and tags.
// Slugs, sort order, attributes… are not replicated (doc §4.4).
import { cutToUnits } from "@onden/markdown";
import { tagClashName } from "@onden/markdown/contract";
import { db } from "../../dbKysely.js";
import type { Note, World } from "../materialize.js";
import { isGlobalTagSpace, GLOBAL_TAG_SPACE_PREFIX, type NoteId, type SpaceId } from "../types.js";
const cut = (v: unknown): string => cutToUnits(JSON.stringify(v) ?? "undefined", 80);

export type EngineNoteView = { space: SpaceId; kind: "content" | "tag"; title: string; body: string; parent: NoteId | null; deleted: boolean; tags: NoteId[] };
export type SpaceView = { name: string; members: Record<string, string> };
export type StateView = { spaces: Record<SpaceId, SpaceView>; notes: Record<NoteId, EngineNoteView> };

/** The pseudo space that holds every tag definition of a workspace (tags are global; the engine files them under a space). */
export const tagSpaceId = (workspaceId: string): SpaceId => `${GLOBAL_TAG_SPACE_PREFIX}${workspaceId}`;

/** What a tag is called on every node. The server refuses two live sibling tags with one name (tagHierarchy.assertTagNameAvailable),
 *  but two nodes can each make one while apart. A pure function of the converged world, so every node ends the same: the tag created
 *  first in the agreed order keeps the name, each later one reads "name (2)", "name (3)". Only the display changes; the op's own title stays. */
export function tagDisplayTitles(world: World): Map<NoteId, string> {
  const out = new Map<NoteId, string>();
  const taken = new Map<string, Set<string>>(); // sibling group -> names in use
  const tags = [...world.notes.values()].filter((n) => n.kind === "tag" && !n.deleted); // Map order = creation order in the agreed order
  const group = (n: Note) => `${n.space}\u0000${n.parent ?? ""}`;
  for (const n of tags) (taken.get(group(n)) ?? taken.set(group(n), new Set()).get(group(n))!).add(n.title.normalize("NFC").toLowerCase());
  const seen = new Map<string, Set<string>>();
  for (const n of tags) {
    const g = group(n), key = n.title.normalize("NFC").toLowerCase();
    const used = seen.get(g) ?? seen.set(g, new Set()).get(g)!;
    let title = n.title, i = 2;
    while (used.has(title.normalize("NFC").toLowerCase())) {
      do { title = tagClashName(n.title, i++); } while (taken.get(g)!.has(title.normalize("NFC").toLowerCase()));
    }
    used.add(title.normalize("NFC").toLowerCase());
    out.set(n.id, title);
  }
  for (const n of world.notes.values()) if (!out.has(n.id)) out.set(n.id, n.title);
  return out;
}

export function worldView(world: World): StateView {
  const titles = tagDisplayTitles(world);
  const spaces: StateView["spaces"] = {};
  for (const s of world.spaces.values()) {
    if (isGlobalTagSpace(s.id)) continue;
    spaces[s.id] = { name: s.name, members: Object.fromEntries([...s.members].sort(([a], [b]) => (a < b ? -1 : 1))) };
  }
  // Deleting does not touch the descendants in the engine (a delete and a create under that note can happen apart); the server's
  // trash is a subtree. So "deleted" here is the effective one: the note, or any ancestor, is deleted.
  const deleted = (n: Note): boolean => {
    for (let cur: Note | undefined = n, hops = 0; cur && hops < 10_000; hops++, cur = cur.parent ? world.notes.get(cur.parent) : undefined) if (cur.deleted) return true;
    return false;
  };
  const notes: StateView["notes"] = {};
  for (const n of world.notes.values()) {
    notes[n.id] = { space: n.space, kind: n.kind, title: n.kind === "tag" ? titles.get(n.id)! : n.title, body: n.body, parent: n.parent, deleted: deleted(n), tags: [...n.tags].sort() };
  }
  return { spaces, notes };
}

export async function dbView(workspaceId: string): Promise<StateView> {
  const spaceRows = await db.selectFrom("spaces").select(["id", "name"]).where("workspace_id", "=", workspaceId).where("deleted_at", "is", null).execute();
  const memberRows = await db.selectFrom("space_members").innerJoin("spaces", "spaces.id", "space_members.space_id")
    .select(["space_members.space_id", "space_members.actor_id", "space_members.permission"])
    .where("spaces.workspace_id", "=", workspaceId).where("spaces.deleted_at", "is", null).execute();
  const spaces: StateView["spaces"] = {};
  for (const s of spaceRows) spaces[s.id] = { name: s.name, members: {} };
  for (const m of memberRows) if (spaces[m.space_id]) spaces[m.space_id]!.members[m.actor_id] = m.permission;
  for (const s of Object.values(spaces)) s.members = Object.fromEntries(Object.entries(s.members).sort(([a], [b]) => (a < b ? -1 : 1)));

  const tagSpace = tagSpaceId(workspaceId);
  const noteRows = await db.selectFrom("content_nodes").select(["id", "node_type", "title", "markdown", "parent_id", "space_id", "deleted_at"])
    .where("workspace_id", "=", workspaceId).where("node_type", "in", ["content", "class_tag"]).execute();
  const tagRows = await db.selectFrom("node_tags").innerJoin("content_nodes", "content_nodes.id", "node_tags.node_id")
    .select(["node_tags.node_id", "node_tags.tag_id"]).where("content_nodes.workspace_id", "=", workspaceId).execute();
  const tagsOf = new Map<string, string[]>();
  for (const t of tagRows) (tagsOf.get(t.node_id) ?? tagsOf.set(t.node_id, []).get(t.node_id)!).push(t.tag_id);
  const notes: StateView["notes"] = {};
  for (const n of noteRows) {
    const isTag = n.node_type === "class_tag";
    if (!isTag && (!n.space_id || !spaces[n.space_id])) continue; // in a deleted space
    notes[n.id] = {
      space: isTag ? tagSpace : n.space_id!, kind: isTag ? "tag" : "content", title: n.title, body: isTag ? "" : n.markdown,
      parent: n.parent_id, deleted: n.deleted_at !== null, tags: (tagsOf.get(n.id) ?? []).sort(),
    };
  }
  return { spaces, notes };
}

/** Where the real tables and the engine's state disagree. A note the engine does not have and the tables hold only in the trash agrees:
 *  the projection cannot purge, it trashes what the agreed history never made (or no longer makes) valid. */
export function viewDifferences(world: StateView, real: StateView): string[] {
  const out: string[] = [];
  for (const id of new Set([...Object.keys(world.spaces), ...Object.keys(real.spaces)])) {
    const w = world.spaces[id], r = real.spaces[id];
    if (!w || !r) out.push(`space ${id}: ${w ? "missing in the tables" : "not in the engine"}`);
    else {
      if (w.name !== r.name) out.push(`space ${id}: name ${JSON.stringify(w.name)} vs ${JSON.stringify(r.name)}`);
      if (JSON.stringify(w.members) !== JSON.stringify(r.members)) out.push(`space ${id}: members ${JSON.stringify(w.members)} vs ${JSON.stringify(r.members)}`);
    }
  }
  for (const id of new Set([...Object.keys(world.notes), ...Object.keys(real.notes)])) {
    const w = world.notes[id], r = real.notes[id];
    if (!w) { if (!r!.deleted) out.push(`note ${id}: live in the tables, not in the engine`); continue; }
    if (!r) { out.push(`note ${id}: in the engine, missing in the tables`); continue; }
    // A deleted note's content is not kept in step: it cannot be edited in the trash, and catches up when it comes back.
    const kept = w.deleted && r.deleted ? (["space", "kind", "deleted"] as const) : (["space", "kind", "title", "body", "parent", "deleted"] as const);
    for (const k of kept) {
      if (w[k] !== r[k]) out.push(`note ${id}: ${k} ${cut(w[k])} vs ${cut(r[k])}`);
    }
    if (!(w.deleted && r.deleted) && JSON.stringify(w.tags) !== JSON.stringify(r.tags)) out.push(`note ${id}: tags ${JSON.stringify(w.tags)} vs ${JSON.stringify(r.tags)}`);
  }
  return out;
}
