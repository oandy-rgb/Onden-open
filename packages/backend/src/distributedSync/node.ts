// One node of the distributed sync (beta). Doc: docs/architecture/distributed-sync.md.
//
// A node owns three duties and nothing else:
//   submit   a local op: checked against local state, stamped, appended   (one transaction)
//   ingest   ops from a peer: checked, appended or refused, never forwarded if invalid
//   offer    which ops to send a peer: only what the peer's actors may read, only valid ones
// State (World) is derived from the op log on demand and cached by log length.
import { compareOps, receive, tick } from "./hlc.js";
import { applyOp, canRead, materialize, type World } from "./materialize.js";
import { GENESIS_HLC, GENESIS_ORIGIN, type ActorId, type Have, type Hlc, type NodeDirectory, type NodeId, type Op, type OpBody, type SpaceId, type SyncDb, type SyncMessage } from "./types.js";

/** A remote clock further ahead than this is refused: one broken clock must not drag every other node's order into the future. */
export const MAX_CLOCK_DRIFT = 10 * 60 * 1000;
export const OFFER_BATCH = 100;

type OpRow = { op_id: string; origin_node: string; origin_seq: string | number; hlc_wall: string | number; hlc_counter: number; author_actor: string; space_id: string; body: OpBody | string };

const rowToOp = (r: OpRow): Op => ({
  id: r.op_id, origin: r.origin_node, seq: Number(r.origin_seq), hlc: { wall: Number(r.hlc_wall), counter: r.hlc_counter },
  author: r.author_actor, space: r.space_id, body: typeof r.body === "string" ? (JSON.parse(r.body) as OpBody) : r.body,
});

export type IngestResult = { added: number; duplicates: number; rejected: Array<{ op: string; reason: string }> };
export type SubmitResult = { ok: true; op: Op } | { ok: false; reason: string };

export type NodeOptions = {
  nodeId: NodeId;
  /** Actors this node speaks for (the people signed in on this device; every user for a server). */
  actors: ActorId[];
  /** Everyone's node -> actors, as agreed when pairing. This node's own entry is added. */
  directory: NodeDirectory;
  /** Wall clock in the same integer unit as the HLC (ms). Injected so tests control time. */
  now: () => number;
};

export class SyncNode {
  private cache: { count: number; ops: Op[]; world: World } | null = null;
  private constructor(readonly db: SyncDb, private readonly opts: NodeOptions, private clock: Hlc, private nextSeq: number) {}

  get nodeId(): NodeId { return this.opts.nodeId; }
  get actors(): readonly ActorId[] { return this.opts.actors; }

  /** Open (or create) the node's identity in `db`. Reopening after a crash restores the clock and the sequence from the database. */
  static async open(db: SyncDb, opts: NodeOptions): Promise<SyncNode> {
    const dir: NodeDirectory = { ...opts.directory, [opts.nodeId]: opts.actors };
    const o = { ...opts, directory: dir };
    return db.transaction(async (tx) => {
      const rows = await tx.query<{ node_id: string; hlc_wall: string | number; hlc_counter: number; next_seq: string | number }>("SELECT node_id, hlc_wall, hlc_counter, next_seq FROM ds_node");
      if (rows[0] && rows[0].node_id !== opts.nodeId) throw new Error(`this database belongs to node ${rows[0].node_id}, not ${opts.nodeId}`);
      if (!rows[0]) await tx.query("INSERT INTO ds_node (node_id) VALUES ($1)", [opts.nodeId]);
      const r = rows[0];
      for (const [node, actors] of Object.entries(dir)) {
        await tx.query("INSERT INTO ds_peers (node_id, actors) VALUES ($1, $2::text[]) ON CONFLICT (node_id) DO UPDATE SET actors = EXCLUDED.actors", [node, actors]);
      }
      return new SyncNode(db, o, r ? { wall: Number(r.hlc_wall), counter: r.hlc_counter } : { wall: 0, counter: 0 }, r ? Number(r.next_seq) : 1);
    });
  }

  // ── reading ─────────────────────────────────────────────────────────

  private async load(): Promise<{ count: number; ops: Op[]; world: World }> {
    const [{ n }] = await this.db.query<{ n: string | number }>("SELECT count(*) AS n FROM ds_ops");
    if (this.cache && this.cache.count === Number(n)) return this.cache;
    const rows = await this.db.query<OpRow>("SELECT op_id, origin_node, origin_seq, hlc_wall, hlc_counter, author_actor, space_id, body FROM ds_ops");
    const ops = rows.map(rowToOp).sort(compareOps);
    this.cache = { count: ops.length, ops, world: materialize(ops) };
    return this.cache;
  }
  /** The state derived from every op this node holds. */
  async world(): Promise<World> { return (await this.load()).world; }
  /** Every op this node holds, in the agreed order. */
  async ops(): Promise<Op[]> { return (await this.load()).ops; }

  /** Notes `actor` may read on this node (not deleted-hidden: callers filter on `deleted`). The same rule `offer` uses to decide what leaves. */
  async readableSpaces(actor: ActorId): Promise<SpaceId[]> {
    const w = await this.world();
    return [...w.spaces.keys()].filter((s) => canRead(w, s, actor));
  }

  async have(): Promise<Have> {
    const rows = await this.db.query<{ origin_node: string; origin_seq: string | number }>("SELECT origin_node, origin_seq FROM ds_ops ORDER BY origin_node, origin_seq");
    const have: Have = {};
    for (const r of rows) {
      const runs = (have[r.origin_node] ??= []);
      const seq = Number(r.origin_seq), last = runs[runs.length - 1];
      if (last && last[1] + 1 === seq) last[1] = seq; else runs.push([seq, seq]);
    }
    return have;
  }

  // ── writing ─────────────────────────────────────────────────────────

  /** A local edit by one of this node's actors. Refused (nothing stored) when the node's own state says the actor may not do it.
   *  `unchecked` exists only for tests that play a stale or modified client: the op is stored and sent like any other, and
   *  other nodes must refuse it. */
  async submit(author: ActorId, space: SpaceId, body: OpBody, { unchecked = false }: { unchecked?: boolean } = {}): Promise<SubmitResult> {
    if (!this.opts.actors.includes(author)) return { ok: false, reason: "not_a_local_actor" };
    const cache = await this.load();
    const hlc = tick(this.clock, this.opts.now());
    const op: Op = { id: `${this.nodeId}:${this.nextSeq}`, origin: this.nodeId, seq: this.nextSeq, hlc, author, space, body };
    // A new local op sorts after everything held (the clock is past it), so applying it to the cached state IS the fold.
    // An invalid op leaves the state untouched, so applying in place needs no copy; only its verdict entry has to go again.
    const verdict = applyOp(cache.world, op);
    if (!verdict.ok && !unchecked) {
      cache.world.verdicts.delete(op.id);
      return { ok: false, reason: verdict.reason };
    }
    try {
      await this.db.transaction(async (tx) => {
        await insertOp(tx, op, null);
        await tx.query("UPDATE ds_node SET hlc_wall = $1, hlc_counter = $2, next_seq = $3", [hlc.wall, hlc.counter, this.nextSeq + 1]);
      });
    } catch (e) {
      this.cache = null; // the state was already advanced in memory: rebuild it from the log
      throw e;
    }
    this.clock = hlc;
    this.nextSeq += 1;
    cache.ops.push(op);
    cache.count += 1;
    return { ok: true, op };
  }

  /** Forget the cached state and reread the clock: call after a transaction that wrote through this node was rolled back by its owner. */
  async reopen(): Promise<void> {
    this.cache = null;
    const rows = await this.db.query<{ hlc_wall: string | number; hlc_counter: number; next_seq: string | number }>("SELECT hlc_wall, hlc_counter, next_seq FROM ds_node");
    if (rows[0]) { this.clock = { wall: Number(rows[0].hlc_wall), counter: rows[0].hlc_counter }; this.nextSeq = Number(rows[0].next_seq); }
  }

  /** Put the genesis ops (doc §9) into the log. Every copy of one server derives the same ones, so this is idempotent;
   *  a genesis op that exists with different content means the two databases are not copies of one server, and nothing is written. */
  async seedGenesis(ops: Op[]): Promise<{ added: number }> {
    for (const op of ops) {
      if (op.origin !== GENESIS_ORIGIN || op.hlc.wall !== GENESIS_HLC.wall || op.hlc.counter !== GENESIS_HLC.counter) throw new Error(`${op.id} is not a genesis op`);
    }
    const { ops: held } = await this.load();
    const heldIds = new Map(held.map((o) => [o.id, o] as const));
    const fresh: Op[] = [];
    for (const op of ops) {
      const known = heldIds.get(op.id);
      if (!known) fresh.push(op);
      else if (JSON.stringify([known.author, known.space, known.body]) !== JSON.stringify([op.author, op.space, op.body])) throw new Error(`genesis_mismatch: ${op.id}`);
    }
    if (!fresh.length) return { added: 0 };
    await this.db.transaction(async (tx) => { for (const op of fresh) await insertOp(tx, op, null); });
    this.cache = null;
    return { added: fresh.length };
  }

  /** Ops from `from`. Each is checked on its own; one bad op does not poison the batch. The batch is one transaction. */
  async ingest(from: NodeId, ops: Op[], { failAfterInsert = false }: { failAfterInsert?: boolean } = {}): Promise<IngestResult> {
    const result: IngestResult = { added: 0, duplicates: 0, rejected: [] };
    const { ops: held } = await this.load();
    const heldIds = new Map(held.map((o) => [o.id, o] as const));
    const accepted: Op[] = [];
    const refuse = (op: Op, reason: string) => result.rejected.push({ op: op.id, reason });

    for (const op of [...ops].sort(compareOps)) {
      const known = heldIds.get(op.id);
      if (known) {
        if (JSON.stringify([known.hlc, known.author, known.space, known.body]) !== JSON.stringify([op.hlc, op.author, op.space, op.body])) refuse(op, "equivocation");
        else result.duplicates += 1;
        continue;
      }
      if (!isWellFormed(op)) refuse(op, "malformed");
      else if (!(this.opts.directory[op.origin] ?? []).includes(op.author)) refuse(op, "author_not_of_origin");
      else if (op.hlc.wall > this.opts.now() + MAX_CLOCK_DRIFT) refuse(op, "clock_too_far_ahead");
      else if (op.origin === this.nodeId) refuse(op, "claims_to_be_mine"); // my own ops only ever come from submit()
      else accepted.push(op);
    }

    // Receiving side of the read rule: keep a space's ops only if one of my actors may read that space once these ops are in.
    // (A first batch carries the very membership op that makes me a reader, so the answer comes from the trial state.)
    const bySpace = new Map<SpaceId, Op[]>();
    for (const op of accepted) bySpace.set(op.space, [...(bySpace.get(op.space) ?? []), op]);
    const keep: Op[] = [];
    for (const [space, incoming] of bySpace) {
      const before = held.filter((o) => o.space === space);
      const trial = materialize([...before, ...incoming]);
      const wasReader = before.length > 0 && this.opts.actors.some((a) => canRead(materialize(before), space, a));
      const readable = this.opts.actors.some((a) => canRead(trial, space, a));
      for (const op of incoming) {
        // A node that could read the space still learns it was removed: the membership op about its own actor is the one op it may
        // receive without reading the space afterwards. Anything else from that space is refused.
        const aboutMe = wasReader && op.body.kind === "member.set" && this.opts.actors.includes(op.body.actor);
        if (readable || aboutMe) keep.push(op); else refuse(op, "space_not_readable_here");
      }
    }

    let nextClock = this.clock;
    await this.db.transaction(async (tx) => {
      nextClock = this.clock; // a retried transaction starts from the stored clock again
      for (const r of result.rejected) {
        const op = ops.find((o) => o.id === r.op);
        await tx.query("INSERT INTO ds_rejections (op_id, from_node, reason, op) VALUES ($1, $2, $3, $4::jsonb)", [r.op, from, r.reason, JSON.stringify(op ?? null)]);
      }
      result.added = 0;
      for (const op of keep) {
        await insertOp(tx, op, from);
        nextClock = receive(nextClock, op.hlc, this.opts.now());
        result.added += 1;
      }
      if (failAfterInsert && keep.length) throw new Error("injected failure after insert"); // tests: the transaction must roll back whole
      if (keep.length) await tx.query("UPDATE ds_node SET hlc_wall = $1, hlc_counter = $2", [nextClock.wall, nextClock.counter]);
    });
    if (result.added) { this.clock = nextClock; this.cache = null; }
    return result;
  }

  // ── sending ─────────────────────────────────────────────────────────

  /** Ops the peer lacks (per its `have`) that this node may send it: valid here, and in a space one of the peer's actors may read here.
   *  A membership op about a peer's actor also goes to that peer, so a revoked device learns it was revoked. */
  async opsFor(peer: NodeId, have: Have, limit = OFFER_BATCH): Promise<Op[]> {
    const peerActors = this.opts.directory[peer] ?? [];
    if (!peerActors.length) return [];
    const { ops, world } = await this.load();
    const has = (op: Op) => (have[op.origin] ?? []).some(([from, to]) => op.seq >= from && op.seq <= to);
    const out: Op[] = [];
    for (const op of ops) {
      if (out.length >= limit) break;
      if (has(op) || !world.verdicts.get(op.id)?.ok) continue;
      const readable = peerActors.some((a) => canRead(world, op.space, a));
      const aboutPeer = op.body.kind === "member.set" && peerActors.includes(op.body.actor);
      if (readable || aboutPeer) out.push(op);
    }
    return out;
  }

  /** Protocol: answer one message with the messages to send next. Pure message in, messages out; the transport is not this node's business. */
  async handle(msg: SyncMessage, faults: { failIngestAfterInsert?: boolean } = {}): Promise<SyncMessage[]> {
    if (msg.to !== this.nodeId) return [];
    if (msg.type === "offer") {
      const out: SyncMessage[] = [];
      const ops = await this.opsFor(msg.from, msg.have);
      if (ops.length) out.push({ type: "ops", from: this.nodeId, to: msg.from, ops });
      if (msg.reply) out.push(await this.offerTo(msg.from, false));
      return out;
    }
    await this.ingest(msg.from, msg.ops, { failAfterInsert: faults.failIngestAfterInsert });
    return [];
  }

  async offerTo(peer: NodeId, reply = true): Promise<SyncMessage> {
    return { type: "offer", from: this.nodeId, to: peer, have: await this.have(), reply };
  }
}

async function insertOp(tx: SyncDb, op: Op, receivedFrom: NodeId | null): Promise<void> {
  await tx.query(
    `INSERT INTO ds_ops (op_id, origin_node, origin_seq, hlc_wall, hlc_counter, author_actor, space_id, kind, body, received_from)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
    [op.id, op.origin, op.seq, op.hlc.wall, op.hlc.counter, op.author, op.space, op.body.kind, JSON.stringify(op.body), receivedFrom]);
}

function isWellFormed(op: Op): boolean {
  return typeof op.id === "string" && op.id === `${op.origin}:${op.seq}` && Number.isInteger(op.seq) && op.seq >= 1
    && Number.isInteger(op.hlc?.wall) && Number.isInteger(op.hlc?.counter) && typeof op.author === "string" && typeof op.space === "string"
    && typeof op.body === "object" && op.body !== null && typeof op.body.kind === "string";
}
