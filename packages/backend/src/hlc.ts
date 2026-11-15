// Hybrid logical clock. Used by write stamps (spine/stamps.ts) and by the distributed-sync engine
// (distributedSync/hlc.ts re-exports this file).
export type Hlc = { wall: number; counter: number };

type OpOrder = { hlc: Hlc; origin: string; seq: number };

/** Total order every node agrees on: clock reading first, then origin and sequence as tie-breakers.
 *  An op made after seeing another always sorts after it (receive() below), so the order respects causality. */
export function compareOps(a: OpOrder, b: OpOrder): number {
  return a.hlc.wall - b.hlc.wall || a.hlc.counter - b.hlc.counter || (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0) || a.seq - b.seq;
}

/** The next reading for a local event: later than the previous one and than the wall clock. */
export function tick(prev: Hlc, nowWall: number): Hlc {
  return nowWall > prev.wall ? { wall: nowWall, counter: 0 } : { wall: prev.wall, counter: prev.counter + 1 };
}

/** The clock after seeing a remote reading: never behind it, so later local ops sort after what was seen. */
export function receive(prev: Hlc, remote: Hlc, nowWall: number): Hlc {
  const wall = Math.max(prev.wall, remote.wall, nowWall);
  if (wall === prev.wall && wall === remote.wall) return { wall, counter: Math.max(prev.counter, remote.counter) + 1 };
  if (wall === prev.wall) return { wall, counter: prev.counter + 1 };
  if (wall === remote.wall) return { wall, counter: remote.counter + 1 };
  return { wall, counter: 0 };
}
