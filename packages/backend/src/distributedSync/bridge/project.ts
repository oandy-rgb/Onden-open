// Projection: make the real tables say what the engine's state says, THROUGH THE NORMAL WRITE PATH (doc §3.1, §4.4).
//
//   projectChange(before, after)   `before` and `after` are the engine's states around one ingest. Every note, space member and space the
//   two differ on is reconciled toward `after`: compare the row with the state, write only what differs. Reconciling toward a state
//   (not replaying each op) is what makes the result independent of arrival order: an op that lands earlier in the agreed order than
//   ones already applied changes the state, and the diff carries exactly that change.
//
// Every write is a service call (createNote, updateNode, applyTagToNode, trashNode, setMember…): authority, event lock, event + state in
// one transaction, membership epoch all run as for any write. Two things differ: the actor is the op's author and, for that one op, the
// ENGINE's verdict stands in for today's membership (spine/replicatedOp.ts); and the events carry `tx_meta.ds_op_id`, which capture
// reads as "came from elsewhere". A step that fails is rolled back alone (savepoint), recorded in ds_projection_failures, and the rest goes on.
import { cutToUnits } from "@onden/markdown";
import { withSavepoint } from "../../db.js";
import { db } from "../../dbKysely.js";
import { withReplicatedOp } from "../../spine/replicatedOp.js";
import type { ActorCtx } from "../../types.js";
import { createNote } from "../../services/noteCreate.js";
import { updateNode } from "../../services/nodeUpdate.js";
import { createTag } from "../../services/tagHierarchy.js";
import { applyTagToNode, removeTagFromNode } from "../../services/tagMembershipWrites.js";
import { trashNode, undeleteNode } from "../../services/nodeTrash.js";
import { createSharedSpace, setMember } from "../../services/spaces.js";
import type { StoredSpacePermission } from "../../spine/spaceAccess.js";
import type { Note, World } from "../materialize.js";
import { isGlobalTagSpace, type NoteId, type Op, type OpId } from "../types.js";
import { worldView, type EngineNoteView } from "./view.js";

export type ProjectionReport = {
  spacesCreated: number;
  membersChanged: number;
  notesCreated: number;
  notesUpdated: number;
  notesTrashed: number;
  notesRestored: number;
  tagLinksChanged: number;
  failures: Array<{ step: string; op: OpId | null; note: NoteId | null; reason: string }>;
};

type DbNote = { id: string; node_type: string; title: string; markdown: string; parent_id: string | null; space_id: string | null; deleted_at: unknown };

export async function projectChange(args: { workspaceId: string; before: World; after: World; ops: Op[] }): Promise<ProjectionReport> {
  const { workspaceId, before, after } = args;
  const report: ProjectionReport = { spacesCreated: 0, membersChanged: 0, notesCreated: 0, notesUpdated: 0, notesTrashed: 0, notesRestored: 0, tagLinksChanged: 0, failures: [] };
  const w0 = worldView(before), w1 = worldView(after);
  const actors = new Map<string, ActorCtx>();
  const actorCtx = async (id: string): Promise<ActorCtx> => {
    let a = actors.get(id);
    if (!a) {
      const row = await db.selectFrom("actors").select(["id", "name", "type"]).where("id", "=", id).where("workspace_id", "=", workspaceId).executeTakeFirst();
      if (!row) throw new Error("the author is not an actor of this workspace");
      a = { id: row.id, name: row.name, type: row.type as ActorCtx["type"] };
      actors.set(id, a);
    }
    return a;
  };
  const lastOp = (note: Note | undefined, wanted: (b: Op["body"]) => boolean): Op | undefined => {
    if (!note) return undefined;
    const byId = opIndex(args.ops);
    for (let i = note.history.length - 1; i >= 0; i--) { const op = byId.get(note.history[i]!); if (op && wanted(op.body)) return op; }
    return undefined;
  };

  /** One write as `authorId`, replaying `opId`; rolled back alone if it fails. */
  const step = async (name: string, who: { author: string; op: OpId }, note: NoteId | null, fn: (actor: ActorCtx) => Promise<unknown>): Promise<boolean> => {
    try {
      const actor = await actorCtx(who.author);
      await withSavepoint(() => withReplicatedOp({ opId: who.op, authorId: who.author }, () => fn(actor)));
      return true;
    } catch (e) {
      const reason = cutToUnits(e instanceof Error ? `${e.name}: ${e.message}` : String(e), 300);
      report.failures.push({ step: name, op: who.op, note, reason });
      await db.insertInto("ds_projection_failures").values({ op_id: who.op, note_id: note, step: name, reason }).execute();
      return false;
    }
  };
  const authorOf = (op: Op | undefined, fallback: Note | undefined) => ({ author: op?.author ?? fallback?.createdBy ?? "", op: op?.id ?? fallback?.history[0] ?? "" });

  // ── spaces ─────────────────────────────────────────────────────────
  const dbSpaces = new Map((await db.selectFrom("spaces").select(["id", "kind"]).where("workspace_id", "=", workspaceId).where("deleted_at", "is", null).execute()).map((s) => [s.id, s.kind] as const));
  for (const space of after.spaces.values()) {
    if (isGlobalTagSpace(space.id) || dbSpaces.has(space.id) || w0.spaces[space.id]) continue;
    const created = args.ops.find((o) => o.body.kind === "space.create" && o.space === space.id);
    const ok = await step("space.create", { author: space.owner, op: created?.id ?? "" }, null, (a) => createSharedSpace(a, workspaceId, space.name, { id: space.id }));
    if (ok) { report.spacesCreated += 1; dbSpaces.set(space.id, "shared"); }
  }
  const memberOp = (space: string, actor: string) => [...args.ops].reverse().find((o) => o.space === space && o.body.kind === "member.set" && o.body.actor === actor);
  const dbMembers = new Map<string, Map<string, string>>();
  for (const m of await db.selectFrom("space_members").innerJoin("spaces", "spaces.id", "space_members.space_id").select(["space_members.space_id", "space_members.actor_id", "space_members.permission"])
    .where("spaces.workspace_id", "=", workspaceId).execute()) {
    (dbMembers.get(m.space_id) ?? dbMembers.set(m.space_id, new Map()).get(m.space_id)!).set(m.actor_id, m.permission);
  }
  const memberChanges: Array<{ space: string; actor: string; role: string | null; owner: string }> = [];
  for (const [spaceId, view] of Object.entries(w1.spaces)) {
    if (dbSpaces.get(spaceId) !== "shared") continue; // a personal space has only its owner; the engine's copy of it comes from genesis
    const have = dbMembers.get(spaceId) ?? new Map<string, string>();
    const owner = after.spaces.get(spaceId)!.owner;
    for (const [actor, role] of Object.entries(view.members)) if (have.get(actor) !== role) memberChanges.push({ space: spaceId, actor, role, owner });
    for (const actor of have.keys()) if (!(actor in view.members)) memberChanges.push({ space: spaceId, actor, role: null, owner });
  }
  const applyMembers = async (removals: boolean) => {
    for (const c of memberChanges.filter((m) => (m.role === null) === removals)) {
      const op = memberOp(c.space, c.actor);
      if (await step("member.set", { author: op?.author ?? c.owner, op: op?.id ?? "" }, null, (a) => setMember(a, workspaceId, c.space, c.actor, c.role as StoredSpacePermission | null))) report.membersChanged += 1;
    }
  };
  await applyMembers(false);

  // ── notes ──────────────────────────────────────────────────────────
  const changed = new Set<NoteId>();
  for (const id of new Set([...Object.keys(w0.notes), ...Object.keys(w1.notes)])) if (JSON.stringify(w0.notes[id]) !== JSON.stringify(w1.notes[id])) changed.add(id);
  const ids = [...changed];
  const rows = new Map<string, DbNote>();
  const tagRows = new Map<string, Set<string>>();
  if (ids.length) {
    for (const r of await db.selectFrom("content_nodes").select(["id", "node_type", "title", "markdown", "parent_id", "space_id", "deleted_at"]).where("workspace_id", "=", workspaceId).where("id", "in", ids).execute()) rows.set(r.id, r as DbNote);
    for (const t of await db.selectFrom("node_tags").select(["node_id", "tag_id"]).where("node_id", "in", ids).execute()) (tagRows.get(t.node_id) ?? tagRows.set(t.node_id, new Set()).get(t.node_id)!).add(t.tag_id);
  }
  const depth = (id: string): number => { let d = 0; for (let cur = w1.notes[id]?.parent; cur && d < 10_000; cur = w1.notes[cur]?.parent ?? null) d++; return d; };
  const want = (id: string): EngineNoteView | undefined => w1.notes[id];
  const freshRow = async (id: string) => db.selectFrom("content_nodes").select(["title", "markdown", "parent_id", "deleted_at"]).where("id", "=", id).executeTakeFirst();
  const trashedNow = async (id: string) => (await db.selectFrom("content_nodes").select("deleted_at").where("id", "=", id).executeTakeFirst())?.deleted_at != null;
  /** A note can only be put under (or created in) a live note. If the parent is in the trash here, bring back the topmost trashed
   *  note of its chain for the moment; the final pass puts back into the trash whatever the engine's state deletes. */
  const makeRoom = async (parent: string | null, who: { author: string; op: OpId }) => {
    const chain: string[] = [];
    for (let cur = parent, hops = 0; cur && hops < 1000; hops++) {
      const row = await db.selectFrom("content_nodes").select(["parent_id", "deleted_at"]).where("id", "=", cur).executeTakeFirst();
      if (!row) break;
      if (row.deleted_at !== null) chain.push(cur);
      cur = row.parent_id;
    }
    const top = chain.at(-1);
    if (top) await step("note.restore", who, top, (a) => undeleteNode(a, workspaceId, top, { uiContext: "sync.project" }));
  };

  // Fields that differ (title, body, parent) on notes that are in the tables and not in the trash (a trashed note is not edited; it
  // catches up when it comes back). A rename can wait for another tag to give its name up, a move for another note to move out of the
  // way (a swap needs two passes), so failures are retried while progress is made; what still fails is recorded.
  type Field = "title" | "body" | "parent";
  const fieldPass = async (only: (id: string, field: Field) => boolean) => {
    const pending = new Map<string, Field[]>();
    for (const id of ids) {
      const n = want(id), r = await freshRow(id);
      if (!n || !r || n.deleted || r.deleted_at !== null) continue;
      const fields: Field[] = [];
      if (r.title !== n.title) fields.push("title");
      if (n.kind === "content" && r.markdown !== n.body) fields.push("body");
      if ((r.parent_id ?? null) !== n.parent) fields.push("parent");
      const kept = fields.filter((f) => only(id, f));
      if (kept.length) pending.set(id, kept);
    }
    let loud = false;
    for (let pass = 0; pass < 8 && pending.size; pass++) {
      let progress = false;
      for (const [id, fields] of [...pending]) {
        const n = want(id)!, note = after.notes.get(id)!;
        for (const field of [...fields]) {
          const wanted = field === "title" ? (x: Op["body"]) => x.kind === "note.title" || x.kind === "note.create"
            : field === "body" ? (x: Op["body"]) => x.kind === "note.body" || x.kind === "note.create"
            : (x: Op["body"]) => x.kind === "note.move" || x.kind === "note.create";
          const who = authorOf(lastOp(note, wanted), note);
          const input = field === "title" ? { title: n.title } : field === "body" ? { markdown: n.body } : { parent_id: n.parent };
          const write = async (a: ActorCtx) => updateNode(workspaceId, id, input, { actor: a, event: { uiContext: "sync.project", cascadeLabel: "sync.project.cascade", backupPrefix: "NODE_UPDATED" } });
          let ok = false;
          if (field === "parent" && n.parent) await makeRoom(n.parent, who);
          if (loud) ok = await step(`note.${field}`, who, id, write);
          else {
            try { await withSavepoint(async () => withReplicatedOp({ opId: who.op, authorId: who.author }, async () => write(await actorCtx(who.author)))); ok = true; } catch { ok = false; }
          }
          if (ok) {
            fields.splice(fields.indexOf(field), 1); progress = true; report.notesUpdated += 1;
          }
        }
        if (!fields.length) pending.delete(id);
      }
      if (!progress) { if (loud) break; loud = true; }
    }
  };

  // 1. tags that must give their name up to a tag that sorts before them, before that one is created
  await fieldPass((id, field) => field === "title" && want(id)?.kind === "tag");
  // 2. notes the tables lack (tags first, parents before children)
  const toCreate = ids.filter((id) => want(id) && !rows.has(id)).sort((a, b) => (want(a)!.kind === want(b)!.kind ? 0 : want(a)!.kind === "tag" ? -1 : 1) || depth(a) - depth(b) || (a < b ? -1 : 1));
  for (const id of toCreate) {
    const n = want(id)!, note = after.notes.get(id);
    const who = authorOf(lastOp(note, (b) => b.kind === "note.create"), note);
    if (n.parent) await makeRoom(n.parent, who);
    const created = n.kind === "tag"
      ? await step("tag.create", who, id, (a) => createTag({ actor: a, workspaceId, id, name: n.title, parentId: n.parent }))
      : await step("note.create", who, id, (a) => createNote({
        actor: a, workspaceId, id, title: n.title, markdown: n.body, parentId: n.parent, spaceId: n.parent ? undefined : n.space, event: { uiContext: "sync.project" }, siteDefault: false,
      }));
    if (created) { report.notesCreated += 1; rows.set(id, { id, node_type: n.kind === "tag" ? "class_tag" : "content", title: n.title, markdown: n.body, parent_id: n.parent, space_id: n.space, deleted_at: null }); }
  }
  // 3. back from the trash first: a trashed note cannot be edited
  for (const id of ids) {
    const n = want(id), r = rows.get(id);
    if (!n || !r || n.deleted || !(await trashedNow(id))) continue;
    const who = authorOf(lastOp(after.notes.get(id), (b) => b.kind === "note.restore"), after.notes.get(id));
    if (await step("note.restore", who, id, (a) => undeleteNode(a, workspaceId, id, { uiContext: "sync.project" }))) { report.notesRestored += 1; r.deleted_at = null; }
  }
  await fieldPass(() => true);
  // 4. tag links
  for (const id of ids) {
    const n = want(id), r = rows.get(id);
    if (!n || !r || n.deleted || n.kind !== "content") continue;
    const have = tagRows.get(id) ?? new Set<string>();
    const note = after.notes.get(id);
    for (const tag of n.tags.filter((t) => !have.has(t))) {
      const op = lastOp(note, (b) => b.kind === "note.tag" && b.tag === tag);
      if (await step("note.tag", authorOf(op, note), id, (a) => applyTagToNode({ workspaceId, actor: a, nodeId: id, tagId: tag }))) report.tagLinksChanged += 1;
    }
    for (const tag of [...have].filter((t) => !n.tags.includes(t))) {
      const op = lastOp(note, (b) => b.kind === "note.tag" && b.tag === tag);
      if (await step("note.untag", authorOf(op, note), id, (a) => removeTagFromNode({ workspaceId, actor: a, nodeId: id, tagId: tag }))) report.tagLinksChanged += 1;
    }
  }
  // 5. into the trash: notes the state deletes, and notes it no longer has at all (an op that became invalid after a late revocation)
  for (const id of ids) {
    const n = want(id), r = rows.get(id);
    if (!r || (n && !n.deleted) || await trashedNow(id)) continue;
    const prev = before.notes.get(id) ?? after.notes.get(id);
    const owner = after.spaces.get(n?.space ?? w0.notes[id]?.space ?? "")?.owner ?? prev?.createdBy ?? "";
    const who = n ? authorOf(lastOp(after.notes.get(id), (b) => b.kind === "note.delete"), after.notes.get(id)) : { author: owner, op: prev?.history[0] ?? "" };
    if (await step("note.delete", who, id, (a) => trashNode(a, workspaceId, id, { uiContext: "sync.project" }))) report.notesTrashed += 1;
  }
  // 6. a restore can carry side effects the engine has no op for (bringing a note back under a parent still in the trash puts it at the
  // top): look once more and write what is still off.
  await fieldPass(() => true);
  await applyMembers(true);
  return report;
}

const indexes = new WeakMap<Op[], Map<string, Op>>();
function opIndex(ops: Op[]): Map<string, Op> {
  let m = indexes.get(ops);
  if (!m) { m = new Map(ops.map((o) => [o.id, o] as const)); indexes.set(ops, m); }
  return m;
}
