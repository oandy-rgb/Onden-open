// A few nodes, each holding a stamped store (spine/stampedMerge), exchanging units over the engine's faulty network
// (distSim/network.ts: drop, duplicate, delay, reorder, partition). In memory; no database. Local changes are stamped the way
// the real thing will be (hlc.ts tick/receive), and what arrives goes through the same gate the merge core has (clock too far ahead = refused).
import { receive, tick, type Hlc } from "../../../hlc.js";
import { type Cell, type Json, type SkewGate, type Stamp, type Unit, DEFAULT_MAX_SKEW_MS, canonical, conflictsOf, genesisName, isGenesis } from "../../../spine/stampedMerge/unit.js";
import { type Store, type UnitAddress, addressKey, effectiveUnit, mergeStore, parseAddress, storeText } from "../../../spine/stampedMerge/store.js";
import { MemoryNetwork } from "../distSim/network.js";
import type { Rng } from "../distSim/rng.js";

export type Msg = { from: string; to: string; items: [string, Unit][] };
export type Refused = { at: string; address: UnitAddress; stamp: Stamp; reason: string };
export type SimNode = { id: string; author: string; store: Store; hlc: Hlc; seq: number; skewMs: number; honest: boolean; refused: Refused[]; /** writes whose clock was ahead of this node's: kept, offered again after the clock has moved on */ deferred: Map<string, Cell[]> };
/** One local change, as it was made: what the node had seen of that unit and what it wrote. */
export type Written = { node: string; /** the unit already had a conflict (heads with different content) when it was written */ conflictedBefore: boolean; address: UnitAddress; cell: Cell; sawHeads: string[]; /** the genesis values (by name) the writer held in that unit when it wrote */ sawGenesis: string[]; kind: string };

export type WorldOptions = { skewsMs?: number[]; rogue?: number[]; maxSkewMs?: number; drop?: number; duplicate?: number; authors?: string[] };
const START = 1_700_000_000_000;

export class StampedWorld {
  readonly nodes: SimNode[];
  readonly net: MemoryNetwork<Msg>;
  readonly writes: Written[] = [];
  /** The genesis values each node was given for a unit before any stamp existed (a restored backup, an older copy): by unit, the names of the different values. */
  /** How many times a system write was asked for on a unit that had a conflict (and must have been left undone). */
  systemBlocked = 0;
  readonly genesisSeeds = new Map<string, Set<string>>();
  /** Every message ever sent (before loss and duplication): the replays in other orders start from it. */
  readonly sent: Msg[] = [];
  now = START;
  readonly maxSkewMs: number;
  /** Every stamp any node ever ingested or made, per node: causality is checked against it. */
  private maxSeen = new Map<string, Stamp>();
  causalityBreaks: string[] = [];
  /** An event whose unit is not the unit the store shows afterwards: the account of what happened must match the data. */
  eventMismatches: string[] = [];

  constructor(count: number, private readonly rng: Rng, o: WorldOptions = {}) {
    this.maxSkewMs = o.maxSkewMs ?? DEFAULT_MAX_SKEW_MS;
    this.net = new MemoryNetwork<Msg>(rng, { drop: o.drop ?? 0.15, duplicate: o.duplicate ?? 0.1 });
    this.nodes = Array.from({ length: count }, (_, i) => ({
      id: `n${i}`, author: o.authors?.[i] ?? `u${i}`, store: new Map(), hlc: { wall: 0, counter: 0 }, seq: 1,
      skewMs: o.skewsMs?.[i] ?? 0, honest: !o.rogue?.includes(i), refused: [], deferred: new Map(),
    }));
  }
  node(id: string): SimNode { return this.nodes.find((n) => n.id === id)!; }
  get honest(): SimNode[] { return this.nodes.filter((n) => n.honest); }
  physical(n: SimNode): number { return this.now + n.skewMs; }
  gate(n: SimNode): SkewGate { return { nowWall: this.physical(n), maxSkewMs: this.maxSkewMs }; }

  /** The next stamp of a node: after everything it has seen (hlc.ts tick on top of what ingest received). */
  stamp(n: SimNode): Stamp {
    n.hlc = tick(n.hlc, this.physical(n));
    return { origin: n.id, seq: n.seq++, wall: n.hlc.wall, counter: n.hlc.counter, author: n.author, device: null };
  }

  /** Run a local change on a node: `change` gets the store and a stamp, returns the new store; every unit that differs is sent to the others. */
  local(n: SimNode, kind: string, change: (store: Store, stamp: Stamp) => Store): void {
    const before = n.store;
    const stamp = this.stamp(n);
    this.checkCausal(n, stamp);
    const after = change(before, stamp);
    if (after === before) { n.seq--; return; }
    const items: [string, Unit][] = [];
    for (const [key, unit] of after) {
      if (canonical(before.get(key)) === canonical(unit)) continue;
      items.push([key, unit]);
      const address = parseAddress(key);
      const mine = unit.find((c) => c.stamp.origin === n.id && c.stamp.seq === stamp.seq);
      const held = effectiveUnit(before, address) ?? [];
      if (mine) this.writes.push({ node: n.id, conflictedBefore: conflictsOf(held).length > 0, address, cell: mine, sawHeads: held.filter((c) => !isGenesis(c)).map((c) => `${c.stamp.origin}:${c.stamp.seq}`), sawGenesis: held.filter(isGenesis).map(genesisName), kind });
    }
    n.store = after;
    this.noteSeen(n, stamp);
    for (const peer of this.nodes) if (peer !== n) { const msg = { from: n.id, to: peer.id, items }; this.sent.push(msg); this.net.send(msg); }
  }

  /** A value this node has had since before stamps (not a write: nothing is sent, every node is assumed to hold its own copy). */
  seedGenesis(n: SimNode, address: UnitAddress, value: Json): void {
    const key = addressKey(address);
    if (n.store.has(key)) return;
    const cell: Cell = { stamp: { origin: "genesis", seq: 0, wall: 0, counter: 0, author: null, device: null }, saw: {}, deleted: false, value };
    n.store = new Map(n.store).set(key, [cell]);
    this.genesisSeeds.set(key, (this.genesisSeeds.get(key) ?? new Set()).add(genesisName(cell)));
    this.sent.push({ from: n.id, to: "*", items: [[key, [cell]]] }); // never sent to anyone, but the replays in other orders must start from what each node was given
  }

  private checkCausal(n: SimNode, stamp: Stamp): void {
    const seen = this.maxSeen.get(n.id);
    if (seen && (stamp.wall - seen.wall || stamp.counter - seen.counter) <= 0) this.causalityBreaks.push(`${n.id} stamped ${stamp.wall}/${stamp.counter} not after ${seen.wall}/${seen.counter}`);
  }
  private noteSeen(n: SimNode, s: Pick<Stamp, "wall" | "counter" | "origin" | "seq">): void {
    const cur = this.maxSeen.get(n.id);
    if (!cur || s.wall > cur.wall || (s.wall === cur.wall && s.counter > cur.counter)) this.maxSeen.set(n.id, s as Stamp);
  }

  /** A message arrives. What the merge refuses for good is listed; what is ahead of this node's clock is kept to be offered again. Nothing is simply gone. */
  ingest(n: SimNode, items: readonly [string, Unit][]): void {
    const r = mergeStore(n.store, new Map(items), this.gate(n));
    n.store = r.store;
    for (const x of r.rejected) n.refused.push({ at: n.id, address: x.address, stamp: items.find(([k]) => k === addressKey(x.address))![1][0]!.stamp, reason: x.reason });
    for (const d of r.deferred) { const k = addressKey(d.address); n.deferred.set(k, [...(n.deferred.get(k) ?? []).filter((c) => !d.cells.some((x) => x.stamp.origin === c.stamp.origin && x.stamp.seq === c.stamp.seq)), ...d.cells]); }
    for (const e of r.events) if (canonical(e.result.unit) !== canonical(effectiveUnit(r.store, e.address))) this.eventMismatches.push(`${n.id}: the event of a ${e.address.field === "*" ? "row" : "field"} in ${e.address.table} shows another unit than the store`);
    const skipped = new Set([...r.rejected.map((x) => addressKey(x.address))]);
    for (const [key, unit] of items) {
      if (skipped.has(key)) continue;
      for (const c of unit) {
        if (n.deferred.get(key)?.some((d) => d.stamp.origin === c.stamp.origin && d.stamp.seq === c.stamp.seq)) continue;
        n.hlc = receive(n.hlc, { wall: c.stamp.wall, counter: c.stamp.counter }, this.physical(n)); this.noteSeen(n, c.stamp);
      }
    }
  }

  /** Offer every deferred write again (after the clock has moved): those that are now within the limit go in, the rest stay. */
  retryDeferred(): void {
    for (const n of this.nodes) {
      const pending = [...n.deferred];
      n.deferred = new Map();
      if (pending.length) this.ingest(n, pending.map(([k, cells]) => [k, cells] as [string, Unit]));
    }
  }

  deliver(count: number): void {
    for (let i = 0; i < count; i++) {
      const msg = this.net.take();
      if (!msg) return;
      this.ingest(this.node(msg.to), msg.items);
    }
  }

  /** The network is healed and every node tells every other everything it holds, until nothing changes: the retransmission after losses. */
  settle(catchUpMs = 0): number {
    this.net.healAll();
    this.net.faults = { drop: 0, duplicate: 0 };
    while (this.net.pending) this.deliver(this.net.pending);
    if (catchUpMs) { this.now += catchUpMs; this.retryDeferred(); }
    for (let round = 1; round <= 6; round++) {
      const before = this.nodes.map((n) => storeText(n.store)).join("\u0002");
      for (const a of this.nodes) for (const b of this.nodes) if (a !== b) this.ingest(b, [...a.store]);
      if (this.nodes.map((n) => storeText(n.store)).join("\u0002") === before) return round;
    }
    return 6;
  }

  /** The unit as a node sees it (own and following `*`). */
  unit(n: SimNode, a: UnitAddress): Unit | undefined { return effectiveUnit(n.store, a); }
  tick(ms: number): void { this.now += ms; }
}
export type { Json };
