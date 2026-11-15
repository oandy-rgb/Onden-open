// N nodes in one process, each with its own PGlite, joined by a MemoryNetwork.
import type { PGlite } from "@electric-sql/pglite";
import { SyncNode } from "../../../distributedSync/node.js";
import { canRead } from "../../../distributedSync/materialize.js";
import type { ActorId, NodeDirectory, NodeId, SyncMessage } from "../../../distributedSync/types.js";
import { MemoryNetwork, RELIABLE } from "./network.js";
import { openSyncPglite, pgliteSyncDb, resetSyncTables } from "./pgliteDb.js";
import type { Rng } from "./rng.js";

export type Topology = "star" | "mesh";
export const HUB = "S";

/** The fixed cast. S is the server (speaks for everyone, always reachable); the rest are devices. eve is a stranger on a collaboration link. */
export const DIRECTORY: NodeDirectory = {
  S: ["alice", "bob", "carol", "eve"],
  A: ["alice"],
  B: ["bob"],
  C: ["carol"],
  E: ["eve"],
};
export const DEVICES = ["A", "B", "C", "E"] as const;

export class Violation extends Error {}

export class Cluster {
  readonly nodes = new Map<NodeId, SyncNode>();
  readonly pgs = new Map<NodeId, PGlite>();
  net!: MemoryNetwork;
  /** Counters for the run report. */
  readonly stats = { ingestRefusals: {} as Record<string, number>, crashes: 0, heavyCrashes: 0, messages: 0 };
  private clockMs = 1_000_000;
  /** Each node's wall clock drifts by its own offset (ms), so HLC tie-breaking is exercised. */
  private skew: Record<NodeId, number> = {};

  constructor(readonly topology: Topology, private readonly ids: NodeId[] = Object.keys(DIRECTORY)) {}

  /** Open (first time) or wipe-and-reopen every node's database, then bring the nodes up. */
  async start(rng: Rng, faults = RELIABLE, { skew = true }: { skew?: boolean } = {}): Promise<void> {
    this.net = new MemoryNetwork(rng, faults);
    for (const id of this.ids) {
      this.skew[id] = id === HUB || !skew ? 0 : rng.int(5000) - 2500;
      let pg = this.pgs.get(id);
      if (!pg) { pg = await openSyncPglite(); this.pgs.set(id, pg); } else await resetSyncTables(pg);
      this.nodes.set(id, await this.openNode(id));
    }
  }
  private openNode(id: NodeId): Promise<SyncNode> {
    return SyncNode.open(pgliteSyncDb(this.pgs.get(id)!), { nodeId: id, actors: DIRECTORY[id]!, directory: DIRECTORY, now: () => this.clockMs + (this.skew[id] ?? 0) });
  }
  async close(): Promise<void> { for (const pg of this.pgs.values()) await pg.close(); }

  node(id: NodeId): SyncNode { return this.nodes.get(id)!; }
  advanceTime(ms = 10): void { this.clockMs += ms; }

  /** Who talks to whom: devices only to the server (star), or to anyone (mesh; the server is one more node). */
  edges(): Array<[NodeId, NodeId]> {
    const out: Array<[NodeId, NodeId]> = [];
    for (let i = 0; i < this.ids.length; i++) for (let j = i + 1; j < this.ids.length; j++) {
      const a = this.ids[i]!, b = this.ids[j]!;
      if (this.topology === "mesh" || a === HUB || b === HUB) out.push([a, b]);
    }
    return out;
  }

  async gossip(a: NodeId, b: NodeId): Promise<void> {
    if (this.topology === "star" && a !== HUB && b !== HUB) return;
    this.net.send(await this.node(a).offerTo(b));
  }

  /** Deliver one pending message; what the receiver answers goes back on the network. */
  async deliverOne(faults: { failIngestAfterInsert?: boolean } = {}): Promise<boolean> {
    const msg = this.net.take();
    if (!msg) return false;
    this.stats.messages += 1;
    const node = this.node(msg.to);
    let out: SyncMessage[];
    try { out = await node.handle(msg, faults); }
    catch (e) { if (faults.failIngestAfterInsert) return true; throw e; } // an injected failure: the batch rolled back and is simply lost
    await this.checkOutgoing(msg.to, out);
    for (const m of out) this.net.send(m);
    return true;
  }
  async deliver(n: number): Promise<void> { for (let i = 0; i < n && (await this.deliverOne()); i++); }

  /** (d) online: a node never sends an op it considers invalid, nor one the recipient's actors cannot read there. */
  private async checkOutgoing(from: NodeId, msgs: SyncMessage[]): Promise<void> {
    for (const m of msgs) {
      if (m.type !== "ops") continue;
      const world = await this.node(from).world();
      for (const op of m.ops) {
        if (!world.verdicts.get(op.id)?.ok) throw new Violation(`${from} sent ${op.id} (${op.body.kind}) which it holds as invalid`);
        const peerActors = DIRECTORY[m.to]!;
        const readable = peerActors.some((a) => canRead(world, op.space, a));
        const aboutPeer = op.body.kind === "member.set" && peerActors.includes(op.body.actor);
        if (!readable && !aboutPeer) throw new Violation(`${from} sent ${op.id} in space ${op.space} to ${m.to}, whose actors cannot read it`);
      }
    }
  }

  async partition(a: NodeId, b: NodeId, on: boolean): Promise<void> { this.net.partition(a, b, on); }

  /** Power loss. `heavy` also pushes the database through dump and reload, which is what a restart from disk is. */
  async crash(id: NodeId, heavy: boolean): Promise<void> {
    this.stats.crashes += 1;
    this.net.dropMessagesOf(id);
    if (heavy) {
      this.stats.heavyCrashes += 1;
      const old = this.pgs.get(id)!;
      const dump = await old.dumpDataDir("none");
      await old.close();
      this.pgs.set(id, await openSyncPglite(dump));
    }
    this.nodes.set(id, await this.openNode(id));
  }

  /** Heal everything, stop the faults, and exchange until a full round changes nothing. */
  async quiesce(maxRounds = 12): Promise<number> {
    this.net.healAll();
    this.net.faults = RELIABLE;
    let stable = 0;
    for (let round = 1; round <= maxRounds; round++) {
      const before = await this.fingerprint();
      for (const [a, b] of this.edges()) await this.gossip(a, b);
      while (await this.deliverOne());
      const after = await this.fingerprint();
      stable = before === after ? stable + 1 : 0;
      if (stable >= 2) return round;
    }
    throw new Violation(`not quiet after ${maxRounds} rounds`);
  }
  private async fingerprint(): Promise<string> {
    const parts: string[] = [];
    for (const id of this.ids) parts.push(`${id}:${(await this.node(id).ops()).length}`);
    return parts.join(",");
  }
}

export const actorsOf = (id: NodeId): ActorId[] => DIRECTORY[id]!;
