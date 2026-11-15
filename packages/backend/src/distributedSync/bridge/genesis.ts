// Genesis (doc §9): the workspace as it is now, turned into ops, so a database that already holds notes can become a node.
//
// The ops are a function of the rows alone: ids are positions in a fixed order, the clock is the fixed minimum, the author is the
// space's owner. Two copies of one server (a backup restored on a laptop, a second VPS) therefore derive the SAME ops and never see
// each other's notes as new. Order is the dependency order: spaces, tags, notes (parents first), tag links, deletions, and last the
// owner's own access (an owner who manages a shared space without being a member has to be able to create in it first).
import { db } from "../../dbKysely.js";
import { GENESIS_HLC, GENESIS_ORIGIN, type ActorId, type Op, type OpBody, type Role } from "../types.js";
import { tagSpaceId } from "./view.js";

export type GenesisPlan = {
  ops: Op[];
  /** Every actor of the workspace: the people a node of this server vouches for. */
  actors: ActorId[];
  /** Rows the engine cannot carry yet, by what they are (left out, counted). */
  skipped: Record<string, number>;
};

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const roleOf = (permission: string | undefined): Role => (permission === "edit" ? "edit" : permission === "suggest" ? "suggest" : permission === "view" ? "view" : "none");

export async function planGenesis(workspaceId: string): Promise<GenesisPlan> {
  const actors = (await db.selectFrom("actors").select("id").where("workspace_id", "=", workspaceId).execute()).map((a) => a.id).sort();
  const workspace = await db.selectFrom("workspaces").select("owner_actor_id").where("id", "=", workspaceId).executeTakeFirstOrThrow();
  const workspaceOwner = workspace.owner_actor_id ?? actors[0];
  if (!workspaceOwner) throw new Error("a workspace without any actor cannot become a node");

  const spaces = (await db.selectFrom("spaces").select(["id", "name", "kind", "owner_actor_id"]).where("workspace_id", "=", workspaceId).where("deleted_at", "is", null).execute()).sort(byId);
  const members = await db.selectFrom("space_members").innerJoin("spaces", "spaces.id", "space_members.space_id")
    .select(["space_members.space_id", "space_members.actor_id", "space_members.permission"]).where("spaces.workspace_id", "=", workspaceId).where("spaces.deleted_at", "is", null).execute();
  const permissionIn = new Map(members.map((m) => [`${m.space_id}\u0000${m.actor_id}`, m.permission] as const));
  const rows = await db.selectFrom("content_nodes").select(["id", "node_type", "title", "markdown", "parent_id", "space_id", "deleted_at"]).where("workspace_id", "=", workspaceId).execute();
  const skipped: Record<string, number> = {};
  const skip = (what: string) => { skipped[what] = (skipped[what] ?? 0) + 1; };

  const ops: Op[] = [];
  const add = (author: ActorId, space: string, body: OpBody) => {
    const seq = ops.length + 1;
    ops.push({ id: `${GENESIS_ORIGIN}:${seq}`, origin: GENESIS_ORIGIN, seq, hlc: GENESIS_HLC, author, space, body });
  };

  const authorOf = new Map<string, ActorId>();
  const tagSpace = tagSpaceId(workspaceId);
  add(workspaceOwner, tagSpace, { kind: "space.create", space: tagSpace, name: "tags" });
  authorOf.set(tagSpace, workspaceOwner);
  for (const s of spaces) {
    const author = s.kind === "personal" && s.owner_actor_id ? s.owner_actor_id : workspaceOwner;
    authorOf.set(s.id, author);
    add(author, s.id, { kind: "space.create", space: s.id, name: s.name }); // the owner starts as an editor; the real role comes last
  }

  const live = new Map(rows.map((r) => [r.id, r] as const));
  const depth = (id: string): number => { let d = 0; for (let cur = live.get(id)?.parent_id; cur && live.has(cur) && d < 10_000; cur = live.get(cur)!.parent_id) d++; return d; };
  const spaceIds = new Set(spaces.map((s) => s.id));
  const included = new Set<string>();
  const noteRows = rows.filter((r) => {
    if (r.node_type === "class_tag") return true;
    if (r.node_type !== "content") { skip(`node_type=${r.node_type}`); return false; }
    if (!r.space_id || !spaceIds.has(r.space_id)) { skip("content in a deleted space"); return false; }
    return true;
  }).sort((a, b) => depth(a.id) - depth(b.id) || byId(a, b));
  for (const r of noteRows) included.add(r.id);

  // tags before notes: a note can carry any of them
  for (const r of noteRows.filter((n) => n.node_type === "class_tag")) {
    const parent = r.parent_id && included.has(r.parent_id) ? r.parent_id : null;
    add(workspaceOwner, tagSpace, { kind: "note.create", note: r.id, noteKind: "tag", title: r.title, body: "", parent });
  }
  for (const r of noteRows.filter((n) => n.node_type === "content")) {
    const parent = r.parent_id && included.has(r.parent_id) ? r.parent_id : null;
    add(authorOf.get(r.space_id!)!, r.space_id!, { kind: "note.create", note: r.id, noteKind: "content", title: r.title, body: r.markdown, parent });
  }
  const links = await db.selectFrom("node_tags").innerJoin("content_nodes", "content_nodes.id", "node_tags.node_id")
    .select(["node_tags.node_id", "node_tags.tag_id"]).where("content_nodes.workspace_id", "=", workspaceId).execute();
  links.sort((a, b) => (a.node_id + a.tag_id < b.node_id + b.tag_id ? -1 : 1));
  for (const l of links) {
    const note = live.get(l.node_id);
    if (note && note.node_type === "content" && included.has(l.node_id) && included.has(l.tag_id)) add(authorOf.get(note.space_id!)!, note.space_id!, { kind: "note.tag", note: l.node_id, tag: l.tag_id, on: true });
    else skip("tag link on a note the engine does not carry");
  }
  for (const r of noteRows.filter((n) => n.deleted_at !== null)) {
    if (r.node_type === "class_tag") add(workspaceOwner, tagSpace, { kind: "note.delete", note: r.id });
    else add(authorOf.get(r.space_id!)!, r.space_id!, { kind: "note.delete", note: r.id });
  }

  // members last; for the owner this is the real access (none, view…) once every create above has happened
  for (const s of spaces) {
    const author = authorOf.get(s.id)!;
    const ownRole = roleOf(permissionIn.get(`${s.id}\u0000${author}`));
    if (ownRole !== "edit") add(author, s.id, { kind: "member.set", space: s.id, actor: author, role: ownRole });
    for (const m of members.filter((x) => x.space_id === s.id && x.actor_id !== author).sort((a, b) => (a.actor_id < b.actor_id ? -1 : 1))) {
      add(author, s.id, { kind: "member.set", space: s.id, actor: m.actor_id, role: roleOf(m.permission) });
    }
  }
  return { ops, actors, skipped };
}
