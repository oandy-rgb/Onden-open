// An in-memory network that misbehaves on purpose: messages are dropped, duplicated, delayed and delivered in any order,
// and pairs of nodes can be cut off. Everything is decided by the seeded generator, so a failing run replays exactly.
import type { NodeId, SyncMessage } from "../../../distributedSync/types.js";
import type { Rng } from "./rng.js";

export type Faults = { drop: number; duplicate: number };
export const RELIABLE: Faults = { drop: 0, duplicate: 0 };

/** Any message that says who sent it and who it is for; the engine's own are `SyncMessage`s. */
export type Addressed = { from: NodeId; to: NodeId };
export class MemoryNetwork<M extends Addressed = SyncMessage> {
  private queue: M[] = [];
  private cut = new Set<string>();
  readonly stats = { sent: 0, dropped: 0, duplicated: 0, delivered: 0, cutOff: 0 };
  constructor(private readonly rng: Rng, public faults: Faults = RELIABLE) {}

  private key = (a: NodeId, b: NodeId) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  partition(a: NodeId, b: NodeId, on: boolean): void { if (on) this.cut.add(this.key(a, b)); else this.cut.delete(this.key(a, b)); }
  healAll(): void { this.cut.clear(); }
  isCut(a: NodeId, b: NodeId): boolean { return this.cut.has(this.key(a, b)); }
  get pending(): number { return this.queue.length; }

  send(msg: M): void {
    this.stats.sent += 1;
    if (this.isCut(msg.from, msg.to)) { this.stats.cutOff += 1; return; }
    if (this.rng.chance(this.faults.drop)) { this.stats.dropped += 1; return; }
    this.queue.push(msg);
    if (this.rng.chance(this.faults.duplicate)) { this.stats.duplicated += 1; this.queue.push(msg); }
  }
  /** Any pending message, not the oldest: delay and reordering are the same thing here. */
  take(): M | undefined {
    if (!this.queue.length) return undefined;
    const [msg] = this.queue.splice(this.rng.int(this.queue.length), 1);
    if (this.isCut(msg!.from, msg!.to)) { this.stats.cutOff += 1; return this.take(); }
    this.stats.delivered += 1;
    return msg;
  }
  /** A node lost power: what it had sent or was about to receive is gone. */
  dropMessagesOf(node: NodeId): void { this.queue = this.queue.filter((m) => m.from !== node && m.to !== node); }
}
