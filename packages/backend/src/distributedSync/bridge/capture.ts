// Capture: committed local writes (domain_events) become engine ops (doc §3.1). Run after commit, never inside a write.
//
// The write already went through mutate() and its authority checks; the op records the FACT. It is stamped (HLC) here, at capture, and
// appended with `unchecked`: if the engine's own state would call it invalid, that is a disagreement between the two permission models
// and is reported (never hidden, never "fixed" by rewriting the write).
//   * an event that has `tx_meta.ds_op_id` was written by the projection of a remote op: skipped, so nothing is sent back;
//   * the cursor and ds_captured_events make a second run capture nothing twice;
//   * an event kind or target the engine does not carry is counted in ds_unsupported, never dropped without a trace.
import { sql } from "kysely";
import { db } from "../../dbKysely.js";
import type { SyncNode } from "../node.js";
import type { OpBody, Role, SpaceId } from "../types.js";
import { tagSpaceId } from "./view.js";

export type CaptureReport = {
  events: number;
  ops: number;
  skippedRemote: number;
  unsupported: Record<string, number>;
  /** Ops the engine holds as invalid right after capture: the real tables allowed it, the engine's rules do not. */
  disagreements: Array<{ event: string; op: string; kind: string; reason: string }>;
};

type EventRow = { id: string; actor_type: string; actor_id: string; event_type: string; target_type: string; target_id: string; payload: Record<string, unknown>; tx_meta: Record<string, unknown> };

/** The event kinds the engine carries (the rest is counted). Keep in step with opsOf() below. */
export const CAPTURED_EVENT_TYPES = ["SPACE_CREATED", "SPACE_MEMBER_SET", "NODE_CREATED", "TAG_CREATED", "NODE_UPDATED", "NODE_RESTORED", "TAG_APPLIED", "TAG_REMOVED", "NODE_DELETED", "NODE_UNDELETED"] as const;

const roleOfPermission = (p: unknown): Role => (p === "edit" ? "edit" : p === "suggest" ? "suggest" : p === "view" ? "view" : "none");

async function bodyOf(hash: unknown): Promise<string | null> {
  if (typeof hash !== "string") return null;
  const row = await db.selectFrom("blobs").select("content").where("hash", "=", hash).executeTakeFirst();
  return row?.content ?? null;
}

export async function captureLocalWrites(node: SyncNode, workspaceId: string, { limit = 5000 }: { limit?: number } = {}): Promise<CaptureReport> {
  const report: CaptureReport = { events: 0, ops: 0, skippedRemote: 0, unsupported: {}, disagreements: [] };
  const tagSpace = tagSpaceId(workspaceId);
  const cursor = await db.selectFrom("ds_capture_cursor").select("last_event_id").executeTakeFirst();
  let last = cursor ? BigInt(cursor.last_event_id) : 0n;
  const touched = new Map<string, string>(); // note -> the actor of the last local event on it
  for (;;) {
    const events = (await db.selectFrom("domain_events")
      .select(["id", "actor_type", "actor_id", "event_type", "target_type", "target_id", "payload", "tx_meta"])
      .where("workspace_id", "=", workspaceId).where("id", ">", String(last)).orderBy("id").limit(limit).execute()) as unknown as EventRow[];
    if (!events.length) break;
    const unsupportedSeen = new Map<string, { n: number; first: string; last: string }>();
    for (const e of events) {
      report.events += 1;
      last = BigInt(e.id);
      const already = await db.selectFrom("ds_captured_events").select("event_id").where("event_id", "=", e.id).executeTakeFirst();
      if (already) continue;
      let count = 0;
      if (typeof e.tx_meta?.ds_op_id === "string") report.skippedRemote += 1;
      else {
        const planned = await opsOf(node, e, tagSpace);
        if (planned.kind === "ops" && e.target_type !== "space") touched.set(e.target_id, e.actor_id);
        if (planned.kind === "unsupported") {
          const k = planned.why;
          report.unsupported[k] = (report.unsupported[k] ?? 0) + 1;
          const seen = unsupportedSeen.get(k);
          unsupportedSeen.set(k, { n: (seen?.n ?? 0) + 1, first: seen?.first ?? e.id, last: e.id });
        } else {
          for (const { space, body } of planned.ops) {
            const result = await node.submit(e.actor_id, space, body, { unchecked: true });
            if (!result.ok) { report.disagreements.push({ event: e.id, op: "-", kind: body.kind, reason: result.reason }); continue; }
            count += 1;
            const verdict = (await node.world()).verdicts.get(result.op.id);
            if (verdict && !verdict.ok) report.disagreements.push({ event: e.id, op: result.op.id, kind: body.kind, reason: verdict.reason });
          }
        }
      }
      report.ops += count;
      await db.insertInto("ds_captured_events").values({ event_id: e.id, op_count: count }).onConflict((oc) => oc.doNothing()).execute();
    }
    await reconcileTouched(node, touched, report);
    touched.clear();
    for (const [type, u] of unsupportedSeen) {
      await sql`INSERT INTO ds_unsupported (event_type, event_count, first_event_id, last_event_id) VALUES (${type}, ${u.n}, ${u.first}, ${u.last})
                ON CONFLICT (event_type) DO UPDATE SET event_count = ds_unsupported.event_count + ${u.n}, last_event_id = ${u.last}`.execute(db);
    }
    await sql`INSERT INTO ds_capture_cursor (singleton, last_event_id) VALUES (true, ${String(last)}) ON CONFLICT (singleton) DO UPDATE SET last_event_id = ${String(last)}`.execute(db);
    if (events.length < limit) break;
  }
  for (const d of report.disagreements) {
    await db.insertInto("ds_projection_failures").values({ op_id: d.op, note_id: null, step: "capture", reason: `${d.kind}: ${d.reason} (event ${d.event})` }).execute();
  }
  return report;
}

type Planned = { kind: "ops"; ops: Array<{ space: SpaceId; body: OpBody }> } | { kind: "unsupported"; why: string };
const ops = (...list: Array<{ space: SpaceId; body: OpBody }>): Planned => ({ kind: "ops", ops: list });
const unsupported = (why: string): Planned => ({ kind: "unsupported", why });

async function opsOf(node: SyncNode, e: EventRow, tagSpace: SpaceId): Promise<Planned> {
  if (e.actor_type === "system") return unsupported(`${e.event_type} (by a system job)`);
  if (!node.actors.includes(e.actor_id)) return unsupported(`${e.event_type} (by an actor this node does not speak for)`);
  const world = await node.world();
  const p = e.payload;
  switch (e.event_type) {
    case "SPACE_CREATED": {
      const name = typeof p.name === "string" ? p.name : "";
      return ops({ space: e.target_id, body: { kind: "space.create", space: e.target_id, name } });
    }
    case "SPACE_MEMBER_SET": {
      if (typeof p.actor_id !== "string") return unsupported(`${e.event_type} (no member named)`);
      if (!world.spaces.has(e.target_id)) return unsupported(`${e.event_type} (space unknown to the engine, e.g. a personal space)`);
      return ops({ space: e.target_id, body: { kind: "member.set", space: e.target_id, actor: p.actor_id, role: roleOfPermission(p.permission) } });
    }
    case "TAG_CREATED": {
      const parent = typeof p.parent_id === "string" ? p.parent_id : null;
      return ops({ space: tagSpace, body: { kind: "note.create", note: e.target_id, noteKind: "tag", title: String(p.name ?? ""), body: "", parent } });
    }
    case "NODE_CREATED": {
      const row = await db.selectFrom("content_nodes").select(["node_type", "space_id", "parent_id", "title", "markdown"]).where("id", "=", e.target_id).executeTakeFirst();
      if (!row) return unsupported(`${e.event_type} (the note is gone by now)`);
      if (row.node_type !== "content" || !row.space_id) return unsupported(`${e.event_type} (node_type=${row.node_type})`);
      const body = (await bodyOf(p.body_hash)) ?? row.markdown;
      return ops({ space: row.space_id, body: { kind: "note.create", note: e.target_id, noteKind: "content", title: typeof p.title === "string" ? p.title : row.title, body, parent: row.parent_id } });
    }
    case "NODE_UPDATED": case "NODE_RESTORED": { // a restored version is a title and a body like any save
      const note = world.notes.get(e.target_id);
      if (!note) return unsupported(`${e.event_type} (note unknown to the engine)`);
      const out: Array<{ space: SpaceId; body: OpBody }> = [];
      if (typeof p.title === "string" && p.title !== note.title) out.push({ space: note.space, body: { kind: "note.title", note: note.id, title: p.title } });
      const after = await bodyOf(p.body_hash);
      if (after !== null && after !== note.body) out.push({ space: note.space, body: { kind: "note.body", note: note.id, before: note.body, after } });
      if ("parent_id" in p) {
        const parent = typeof p.parent_id === "string" ? p.parent_id : null;
        if (parent !== note.parent) out.push({ space: note.space, body: { kind: "note.move", note: note.id, parent } });
      }
      return out.length ? ops(...out) : unsupported(`${e.event_type} (changed only fields the engine does not carry)`);
    }
    case "TAG_APPLIED": case "TAG_REMOVED": {
      const note = world.notes.get(e.target_id);
      if (!note || typeof p.tag_id !== "string") return unsupported(`${e.event_type} (note or tag unknown to the engine)`);
      return ops({ space: note.space, body: { kind: "note.tag", note: note.id, tag: p.tag_id, on: e.event_type === "TAG_APPLIED" } });
    }
    case "NODE_DELETED": case "NODE_UNDELETED": {
      const note = world.notes.get(e.target_id);
      if (!note) return unsupported(`${e.event_type} (note unknown to the engine)`);
      return ops({ space: note.space, body: { kind: e.event_type === "NODE_DELETED" ? "note.delete" : "note.restore", note: note.id } });
    }
    default:
      return unsupported(e.event_type);
  }
}

/** The services do more than their event says (bringing a note back under a parent that is still in the trash puts it at the top
 *  level; a rename follows through). Every note a local event touched is compared with its row once the batch is in, and what the
 *  events did not explain becomes an op too: the engine must hold what the tables hold, whatever produced it. */
async function reconcileTouched(node: SyncNode, touched: Map<string, string>, report: CaptureReport): Promise<void> {
  const ids = [...touched.keys()];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = await db.selectFrom("content_nodes").select(["id", "title", "markdown", "parent_id", "deleted_at", "node_type"]).where("id", "in", chunk).execute();
    for (const r of rows) {
      const world = await node.world();
      const note = world.notes.get(r.id);
      if (!note) continue;
      const author = touched.get(r.id)!;
      const out: Array<{ space: SpaceId; body: OpBody }> = [];
      if (r.title !== note.title) out.push({ space: note.space, body: { kind: "note.title", note: note.id, title: r.title } });
      if (note.kind === "content" && r.markdown !== note.body) out.push({ space: note.space, body: { kind: "note.body", note: note.id, before: note.body, after: r.markdown } });
      if ((r.parent_id ?? null) !== note.parent) out.push({ space: note.space, body: { kind: "note.move", note: note.id, parent: r.parent_id ?? null } });
      if ((r.deleted_at !== null) !== note.deleted) out.push({ space: note.space, body: { kind: note.deleted ? "note.restore" : "note.delete", note: note.id } });
      for (const { body } of out) {
        const result = await node.submit(author, note.space, body, { unchecked: true });
        if (!result.ok) { report.disagreements.push({ event: "-", op: "-", kind: body.kind, reason: result.reason }); continue; }
        report.ops += 1;
        const verdict = (await node.world()).verdicts.get(result.op.id);
        if (verdict && !verdict.ok) report.disagreements.push({ event: "-", op: result.op.id, kind: body.kind, reason: verdict.reason });
      }
    }
  }
}
