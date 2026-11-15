// A Replica = one real workspace + the engine node that syncs it. The three duties of step 2a, in the order a message needs them:
//   capture    local committed writes -> ops          (capture.ts)
//   ingest     ops from a peer -> ds_ops              (node.ts)
//   project    the state change that caused -> the real tables, through the services (project.ts)
// A message from a peer is handled in ONE transaction: if the projection throws, the ops are not stored either, so the log and the tables
// never disagree about what was received. A step that merely fails (a refusal by the services) is recorded and the transaction goes on.
import { sql } from "kysely";
import { withTransaction } from "../../db.js";
import { db } from "../../dbKysely.js";
import { DistributedSyncOff, distributedSyncEnabled, openSyncNode } from "../index.js";
import type { SyncNode } from "../node.js";
import { GENESIS_ORIGIN, type ActorId, type NodeDirectory, type NodeId, type SyncMessage } from "../types.js";
import { captureLocalWrites, type CaptureReport } from "./capture.js";
import { planGenesis } from "./genesis.js";
import { projectChange, type ProjectionReport } from "./project.js";
import { qSyncDb } from "./qSyncDb.js";
import { dbView, viewDifferences, worldView } from "./view.js";

export type ReplicaOptions = {
  workspaceId: string;
  nodeId: NodeId;
  /** The people this node speaks for. A server: every actor of the workspace (default). A device: its signed-in person. */
  actors?: ActorId[];
  /** Everyone else's node -> people, from pairing. The genesis origin is added. */
  directory?: NodeDirectory;
  now?: () => number;
};

export type HandleReport = { capture: CaptureReport; added: number; rejected: Array<{ op: string; reason: string }>; projection: ProjectionReport | null };

export class Replica {
  /** What the last handled message did (diagnostics and tests). */
  last: HandleReport | null = null;
  private constructor(readonly node: SyncNode, readonly workspaceId: string) {}

  /** Opens the node of this database, and brings in genesis (doc §9) when the log has none yet. Off unless ONDEN_DISTRIBUTED_SYNC=1. */
  static async open(opts: ReplicaOptions): Promise<Replica> {
    if (!distributedSyncEnabled()) throw new DistributedSyncOff(); // before any query: off leaves no trace
    // Genesis is derived ONCE, from the rows as they are when a database first becomes a node (doc §9). A node that already has it (a
    // restart; a copy that carries the ds_ tables) keeps it: re-deriving from rows that have changed since would give other ops.
    const hasGenesis = !!(await db.selectFrom("ds_ops").select("op_id").where("origin_node", "=", GENESIS_ORIGIN).limit(1).executeTakeFirst());
    const plan = hasGenesis ? null : await planGenesis(opts.workspaceId);
    const everyone = plan?.actors ?? (await db.selectFrom("actors").select("id").where("workspace_id", "=", opts.workspaceId).execute()).map((a) => a.id).sort();
    const actors = opts.actors ?? everyone;
    const directory: NodeDirectory = { ...opts.directory, [GENESIS_ORIGIN]: everyone };
    const node = await openSyncNode(qSyncDb, { nodeId: opts.nodeId, actors, directory, now: opts.now ?? Date.now });
    const replica = new Replica(node, opts.workspaceId);
    if (plan) await withTransaction(async () => {
      await node.seedGenesis(plan.ops);
      for (const [what, n] of Object.entries(plan.skipped)) {
        await sql`INSERT INTO ds_unsupported (event_type, event_count, first_event_id, last_event_id) VALUES (${`snapshot: ${what}`}, ${n}, 0, 0)
                  ON CONFLICT (event_type) DO UPDATE SET event_count = ${n}`.execute(db);
      }
      // Everything up to now is inside genesis: only later events are new local writes.
      const latest = await db.selectFrom("domain_events").select(sql<string>`COALESCE(max(id), 0)`.as("id")).where("workspace_id", "=", opts.workspaceId).executeTakeFirstOrThrow();
      await sql`INSERT INTO ds_capture_cursor (singleton, last_event_id) VALUES (true, ${latest.id}) ON CONFLICT (singleton) DO UPDATE SET last_event_id = ${latest.id}`.execute(db);
    });
    return replica;
  }

  capture(): Promise<CaptureReport> {
    return withTransaction(() => captureLocalWrites(this.node, this.workspaceId));
  }

  /** The next offer to `peer`, with everything written here so far included. */
  async offerTo(peer: NodeId, reply = true): Promise<SyncMessage> {
    await this.capture();
    return this.node.offerTo(peer, reply);
  }

  /** One message in, the messages to send next out. Local writes are captured first, so what is offered (or merged with) is current. */
  async handle(msg: SyncMessage): Promise<SyncMessage[]> {
    if (msg.to !== this.node.nodeId) return [];
    try {
      return await withTransaction(async () => {
        const capture = await captureLocalWrites(this.node, this.workspaceId);
        if (msg.type === "offer") { this.last = { capture, added: 0, rejected: [], projection: null }; return this.node.handle(msg); }
        const before = await this.node.world();
        const result = await this.node.ingest(msg.from, msg.ops);
        let projection: ProjectionReport | null = null;
        if (result.added) projection = await projectChange({ workspaceId: this.workspaceId, before, after: await this.node.world(), ops: await this.node.ops() });
        this.last = { capture, added: result.added, rejected: result.rejected, projection };
        return [];
      });
    } catch (e) {
      await this.node.reopen(); // the transaction rolled back; the cached state may be ahead of the log
      throw e;
    }
  }

  /** Where the real tables differ from the state the engine derived (empty = in step). */
  async differences(): Promise<string[]> {
    return viewDifferences(worldView(await this.node.world()), await dbView(this.workspaceId));
  }

  /** What the engine cannot carry yet, counted from capture and from genesis. */
  async unsupported(): Promise<Array<{ what: string; count: number }>> {
    return (await db.selectFrom("ds_unsupported").select(["event_type", "event_count"]).orderBy("event_type").execute()).map((r) => ({ what: r.event_type, count: Number(r.event_count) }));
  }

  /** Remote changes the services refused (the tables then differ from the engine's state). */
  async failures(): Promise<Array<{ step: string; op: string | null; note: string | null; reason: string }>> {
    return (await db.selectFrom("ds_projection_failures").select(["step", "op_id", "note_id", "reason"]).orderBy("id").execute()).map((r) => ({ step: r.step, op: r.op_id, note: r.note_id, reason: r.reason }));
  }
}
