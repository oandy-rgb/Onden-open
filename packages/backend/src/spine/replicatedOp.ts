// A write that replays a REPLICATED op (distributed sync, docs/architecture/distributed-sync.md §5, §11-1).
//
// Local policy answers "may this person do it NOW". A replicated op was already judged by the sync engine against the membership
// that held at its place in the agreed order (`materialize`): an edit made before a revocation stays valid on every node even if the
// revocation reached this node first. Asking today's local rows again would refuse it on exactly the node that heard of the revocation
// first, and the nodes would stop agreeing. So while one validated op is being replayed, THAT op's author passes the space and node
// checks; every other part of the write path (event lock, event + state in one transaction, membership epoch, cascades) is unchanged.
//
// Confinement, like `cascade` authority: the scope exists only inside withReplicatedOp(), which only the sync projection
// (distributedSync/bridge/project.ts) may import (test/distributedSyncOff.test.ts), and it passes only the named author, never a token.
import { createContextSlot } from "../requestContext.js";
import type { ActorCtx } from "../types.js";

type Replay = { opId: string; authorId: string };
const replaying = createContextSlot<Replay>();

/** Run `fn` as the replay of the engine-validated op `opId` by `authorId`. */
export function withReplicatedOp<T>(replay: Replay, fn: () => Promise<T>): Promise<T> {
  return replaying.run(replay, fn);
}

/** True while `actor` is the author of the op being replayed (and not a delegated token). */
export function replicatedAuthor(actor: ActorCtx | null): boolean {
  const s = replaying.getStore();
  return !!s && !!actor && !actor.tokenScope && actor.id === s.authorId;
}

/** The op being replayed, or null: event() stamps it into tx_meta as `ds_op_id`, which is how capture knows an event came from a
 *  remote node and must not be sent back (docs/architecture/distributed-sync.md §3.1). */
export function replayedOpId(): string | null {
  return replaying.getStore()?.opId ?? null;
}
