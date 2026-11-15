// Several complete backends (RealNode) joined by the in-memory network, each syncing its real workspace through a Replica.
// Everything a test writes goes through the real services or the real HTTP app of ONE node (`on`); the sync messages then move the
// engine's ops between nodes and each node projects what it receives through ITS OWN services. Nothing here knows how a note is stored.
import { materialize, spaceDigest } from "../../../distributedSync/materialize.js";
import { Replica, dbView, planGenesis, worldView } from "../../../distributedSync/bridge/index.js";
import type { ActorId, NodeDirectory, NodeId, Op } from "../../../distributedSync/types.js";
import { MemoryNetwork, RELIABLE, type Faults } from "./network.js";
import { RealNode, onNode } from "./realNode.js";
import { makeRng, type Rng } from "./rng.js";

export type Member = { node: RealNode; replica: Replica };

const planGenesisActors = async (workspaceId: string) => (await planGenesis(workspaceId)).actors;

export class RealCluster {
  readonly members = new Map<NodeId, Member>();
  net!: MemoryNetwork;
  private clockMs = 1_800_000_000_000;
  private skew = new Map<NodeId, number>();
  readonly stats = { messages: 0, projections: 0, failures: 0 };

  private constructor(readonly workspaceId: string, private readonly ids: NodeId[], readonly rng: Rng) {}

  /** `seed` builds the starting workspace on the FIRST node through the real services; the others are copies of that database. */
  static async create(ids: NodeId[], seed: () => Promise<string>, { rng = makeRng(1), faults = RELIABLE }: { rng?: Rng; faults?: Faults } = {}): Promise<RealCluster> {
    const first = await RealNode.open(ids[0]!);
    const workspaceId = await onNode(first, seed);
    const cluster = new RealCluster(workspaceId, ids, rng);
    cluster.net = new MemoryNetwork(rng, faults);
    const nodes = new Map<NodeId, RealNode>([[ids[0]!, first]]);
    for (const id of ids.slice(1)) nodes.set(id, await RealNode.open(id, first));
    for (const id of ids) cluster.skew.set(id, 0);
    // Every node is a full backend that speaks for every person of the workspace (a server, or a desktop app holding the whole workspace).
    for (const id of ids) {
      const node = nodes.get(id)!;
      const actors = (await onNode(node, () => planGenesis(workspaceId))).actors;
      const directory: NodeDirectory = Object.fromEntries(ids.filter((o) => o !== id).map((o) => [o, actors] as const));
      const replica = await onNode(node, () => Replica.open({ workspaceId, nodeId: id, actors, directory, now: () => cluster.clockMs + (cluster.skew.get(id) ?? 0) }));
      cluster.members.set(id, { node, replica });
    }
    return cluster;
  }

  /** After a RealNode restarted: a new process opens the node again from its tables (the clock and the sequence come from them). */
  async reopen(id: NodeId): Promise<void> {
    const m = this.node(id);
    const actors = (await onNode(m.node, () => planGenesisActors(this.workspaceId)));
    const directory: NodeDirectory = Object.fromEntries(this.ids.filter((o) => o !== id).map((o) => [o, actors] as const));
    m.replica = await onNode(m.node, () => Replica.open({ workspaceId: this.workspaceId, nodeId: id, directory, now: () => this.clockMs + (this.skew.get(id) ?? 0) }));
    this.net.dropMessagesOf(id);
  }

  setSkew(id: NodeId, ms: number): void { this.skew.set(id, ms); }
  tick(ms = 10): void { this.clockMs += ms; }
  node(id: NodeId): Member { return this.members.get(id)!; }
  /** Run `fn` against node `id`'s database: this is where a test writes through the real services. */
  async on<T>(id: NodeId, fn: () => Promise<T>): Promise<T> {
    this.tick();
    const result = await onNode(this.node(id).node, fn);
    // What a post-commit hook does in production: the write is captured (and stamped) when it happens, not when the next sync starts.
    await this.run(id, (r) => r.capture());
    return result;
  }

  private run<T>(id: NodeId, fn: (r: Replica) => Promise<T>): Promise<T> { return onNode(this.node(id).node, () => fn(this.node(id).replica)); }

  /** Offer from a to b (b answers with what a lacks, a answers with what b lacks…): one exchange, delivered in any order. */
  async gossip(a: NodeId, b: NodeId): Promise<void> {
    this.net.send(await this.run(a, (r) => r.offerTo(b)));
  }
  async deliverOne(): Promise<boolean> {
    const msg = this.net.take();
    if (!msg) return false;
    this.stats.messages += 1;
    const out = await this.run(msg.to, (r) => r.handle(msg));
    const last = this.node(msg.to).replica.last;
    if (last?.projection) { this.stats.projections += 1; this.stats.failures += last.projection.failures.length; }
    for (const m of out) this.net.send(m);
    return true;
  }
  async deliverAll(max = 10_000): Promise<void> { for (let i = 0; i < max && (await this.deliverOne()); i++); }

  edges(topology: "mesh" | "star"): Array<[NodeId, NodeId]> {
    const out: Array<[NodeId, NodeId]> = [];
    for (let i = 0; i < this.ids.length; i++) for (let j = i + 1; j < this.ids.length; j++) {
      if (topology === "mesh" || this.ids[i] === this.ids[0] || this.ids[j] === this.ids[0]) out.push([this.ids[i]!, this.ids[j]!]);
    }
    return out;
  }

  /** Exchange until a whole round changes nothing (every node's op count stops moving). */
  async quiesce(topology: "mesh" | "star" = "mesh", maxRounds = 12): Promise<number> {
    this.net.healAll();
    this.net.faults = RELIABLE;
    let stable = 0;
    for (let round = 1; round <= maxRounds; round++) {
      const before = await this.fingerprint();
      for (const [a, b] of this.edges(topology)) await this.gossip(a, b);
      await this.deliverAll();
      const after = await this.fingerprint();
      stable = before === after ? stable + 1 : 0;
      if (stable >= 2) return round;
    }
    throw new Error(`not quiet after ${maxRounds} rounds`);
  }
  private async fingerprint(): Promise<string> {
    const parts: string[] = [];
    for (const id of this.ids) parts.push(`${id}:${(await this.run(id, (r) => r.node.ops())).length}`);
    return parts.join(",");
  }

  async ops(id: NodeId): Promise<Op[]> { return this.run(id, (r) => r.node.ops()); }

  /** After quiescing: every node ended with the whole op set's state, and each node's real tables say the same as its state. */
  async checkConverged(): Promise<string[]> {
    const failures: string[] = [];
    const union = new Map<string, Op>();
    for (const id of this.ids) for (const op of await this.ops(id)) union.set(op.id, op);
    const truth = materialize([...union.values()]);
    const reference = JSON.stringify(worldView(truth));
    for (const id of this.ids) {
      const world = await this.run(id, (r) => r.node.world());
      for (const space of truth.spaces.keys()) {
        if (spaceDigest(world, space) !== spaceDigest(truth, space)) failures.push(`(a) ${id} differs from the truth in space ${space}`);
      }
      const have = new Set((await this.ops(id)).map((o) => o.id));
      for (const op of union.values()) if (truth.verdicts.get(op.id)?.ok && !have.has(op.id)) failures.push(`(b) ${id} lacks valid op ${op.id} (${op.body.kind})`);
      for (const diff of await this.run(id, (r) => r.differences())) failures.push(`(tables) ${id}: ${diff}`);
      for (const f of await this.run(id, (r) => r.failures())) failures.push(`(projection) ${id}: ${f.step} ${f.reason}`);
      const view = await this.run(id, () => dbView(this.workspaceId));
      void view;
    }
    void reference;
    return failures;
  }

  /** Each node's tables as the shared comparable view (live notes and members), for equality between nodes and with /api/sync. */
  async views(): Promise<Record<NodeId, Awaited<ReturnType<typeof dbView>>>> {
    const out: Record<NodeId, Awaited<ReturnType<typeof dbView>>> = {};
    for (const id of this.ids) out[id] = await this.run(id, () => dbView(this.workspaceId));
    return out;
  }

  async close(): Promise<void> { for (const m of this.members.values()) await m.node.close(); }
}

export type { ActorId };
