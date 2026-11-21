// Known bugs, planted into the pure merge core WITHOUT touching it: stampedMergePlanted.test.ts replaces a few exports of
// spine/stampedMerge/unit.ts, store.ts and body.ts through vitest's module mock, and each replacement here is the real
// function with one thing done wrong (or a copy of its few lines with that one thing changed). A bug is switched on by its id;
// with no bug on, every replacement IS the real function, which is how the same file also checks the real code.
//
// This file must not import the merge core at run time (the mock would hand it back to itself): it gets the real modules as arguments.
import type * as UnitModule from "../../../spine/stampedMerge/unit.js";
import type * as StoreModule from "../../../spine/stampedMerge/store.js";
import type * as BodyModule from "../../../spine/stampedMerge/body.js";
import type * as MoveCycleModule from "../../../spine/stampedMerge/rules/moveCycle.js";
import type { Cell, Json, Stamp, Unit } from "../../../spine/stampedMerge/unit.js";
import type { Store } from "../../../spine/stampedMerge/store.js";

export type PlantId =
  | "a-only-winning-head" | "b-saw-what-it-did-not" | "c-equal-content-asymmetric" | "d-gate-after-take" | "e-deferred-counted-received"
  | "f-system-settles-conflict" | "g-recreate-drops-unseen" | "i1-real-write-replaces-every-genesis" | "i2-whole-unit-deferred"
  | "body-conflict-drops-offered" | "body-no-base-drops-copy"
  // the surviving mutants of the Stryker run judged real holes (the PR's table names each by its mutant id)
  | "m8-body-equal-texts-offered" | "m31-body-no-base-offers-oldest-only" | "m909-malformed-admitted-when-new"
  | "m388-move-undone-off-the-loop";

/** The switch the module mocks read; one bug at a time. */
type PlantSwitch = { bug: PlantId | null };

type U = typeof UnitModule;
type S = typeof StoreModule;
type B = typeof BodyModule;
type M = typeof MoveCycleModule;

/**
 * unit.ts `maximalHeads` with the "has `a` seen `b`" test passed in: a COPY of its lines (by write, the valued copy of a write preferred, drop what another had
 * seen, largest first), because `covers` is called inside unit.ts and a module mock cannot reach it. With `real.covers` it must give what the real function
 * gives: stampedMergePlanted.test.ts "the copies agree with the real functions" checks that, so a change to maximalHeads that this copy misses turns it red.
 */
export function headsWith(u: U, cells: readonly Cell[], seen: (a: Cell, b: Cell) => boolean): Cell[] {
  const key = (c: Cell) => (u.isGenesis(c) ? u.genesisName(c) : u.stampKey(c.stamp));
  const byDot = new Map<string, Cell>();
  for (const c of cells) { const k = key(c), was = byDot.get(k); if (!was || !c.valueless || was.valueless) byDot.set(k, c); }
  const all = [...byDot.values()];
  return all.filter((c) => !all.some((o) => o !== c && seen(o, c))).sort((a, b) => u.compareStamps(b.stamp, a.stamp) || (u.canonical(a) < u.canonical(b) ? 1 : -1));
}

export function plantedUnit(real: U, plant: PlantSwitch): U {
  return {
    ...real,
    maximalHeads(cells: readonly Cell[]): Cell[] {
      switch (plant.bug) {
        // a: the merge keeps only the head that wins; the other value is gone and no conflict is left
        case "a-only-winning-head": return real.maximalHeads(cells).slice(0, 1);
        // b: a later stamp is taken to have seen every earlier write (stamps alone, design A of the README): a conflict is closed by a write that never saw it
        case "b-saw-what-it-did-not": return headsWith(real, cells, (a, b) => real.covers(a, b) || (!real.isGenesis(a) && !real.isGenesis(b) && real.compareStamps(a.stamp, b.stamp) > 0));
        // c: two heads with the same content and different stamps: the first one met is kept, the other dropped (which one depends on which side held it)
        case "c-equal-content-asymmetric": {
          const heads = real.maximalHeads(cells);
          const firstMet = (c: Cell) => cells.findIndex((x) => real.stampKey(x.stamp) === real.stampKey(c.stamp));
          return heads.filter((c) => !heads.some((o) => o !== c && real.sameContent(o, c) && firstMet(o) < firstMet(c)));
        }
        // i1 (premise "創世值也有「看過」"): any real write is taken to replace every value from before stamps, also another node's genesis value it never held
        case "i1-real-write-replaces-every-genesis": return headsWith(real, cells, (a, b) => real.covers(a, b) || (real.isGenesis(b) && !real.isGenesis(a)));
        default: return real.maximalHeads(cells);
      }
    },
    writeUnit(local: Unit | undefined, stamp: Stamp, change: ({ value: Json } | { deleted: true }) & { meta?: Json }, by: "person" | "system" = "person"): Unit {
      // f: the system's write is treated as a person's: it replaces a unit in conflict (settles it)
      return real.writeUnit(local, stamp, change, plant.bug === "f-system-settles-conflict" ? "person" : by);
    },
  };
}

export function plantedStore(real: S, unit: U, plant: PlantSwitch): S {
  return {
    ...real,
    mergeStore(local, incoming, gate) {
      switch (plant.bug) {
        // d: the clock gate is looked at after the write was taken: the write is in the store AND reported as deferred
        case "d-gate-after-take": { const took = real.mergeStore(local, incoming); return { ...took, deferred: real.mergeStore(local, incoming, gate).deferred }; }
        // e: a deferred write is counted as received: it is not taken and not handed back to be offered again
        case "e-deferred-counted-received": return { ...real.mergeStore(local, incoming, gate), deferred: [] };
        // i2 (premise "一個單位裡只有超前的那一筆延後，其他的照收"): one write ahead holds back the whole unit
        case "i2-whole-unit-deferred": {
          const now = new Map<string, Unit>(), held: { address: ReturnType<S["parseAddress"]>; cells: Cell[] }[] = [];
          for (const [k, u] of incoming) (u.some((c) => unit.deferReason(c, gate) !== null) ? held.push({ address: real.parseAddress(k), cells: [...u] }) : now.set(k, u));
          const r = real.mergeStore(local, now, gate);
          return { ...r, deferred: [...r.deferred, ...held] };
        }
        // mutant 909: the per-write format check is skipped; only the comparison with what this node holds refuses (so a malformed write to a unit this node lacks gets in)
        case "m909-malformed-admitted-when-new": {
          const r = real.mergeStore(local, incoming, gate);
          const sneaked = r.rejected.filter((x) => !local.has(real.addressKey(x.address)));
          if (!sneaked.length) return r;
          const store = new Map(r.store);
          for (const x of sneaked) store.set(real.addressKey(x.address), incoming.get(real.addressKey(x.address))!);
          return { ...r, store, rejected: r.rejected.filter((x) => !sneaked.includes(x)) };
        }
        default: return real.mergeStore(local, incoming, gate);
      }
    },
    createRow(store: Store, a: { table: string; row: string }, stamp: Stamp, values: Record<string, Json>, by: "person" | "system" = "person"): Store {
      const made = real.createRow(store, a, stamp, values, by);
      if (plant.bug !== "g-recreate-drops-unseen") return made;
      // g: made again over a permanent delete, the creation says the deleter had seen EVERY write of each origin it names (not only up to the number it held):
      // a field write the deleter had not seen is dropped as if the delete had ended it
      const key = real.addressKey({ ...a, field: real.STAR });
      const star = made.get(key)!;
      const seen = (star[0]!.meta as { seen?: Record<string, number> } | undefined)?.seen;
      if (!seen) return made;
      const all = Object.fromEntries(Object.keys(seen).map((o) => [o, Number.MAX_SAFE_INTEGER]));
      return new Map(made).set(key, [{ ...star[0]!, meta: { ...(star[0]!.meta as object), seen: all } }, ...star.slice(1)]);
    },
  };
}

export function plantedBody(real: B, plant: PlantSwitch): B {
  return {
    ...real,
    resolveBody(u, base, merge) {
      const r = real.resolveBody(u, base, merge);
      // the body merge could not combine two texts: the one that was left out is not offered back
      if (plant.bug === "body-conflict-drops-offered" && r.kind === "conflict") return { kind: "merged", text: r.text };
      // no base was found: only the newest text is kept, the other copy is not
      if (plant.bug === "body-no-base-drops-copy" && r.kind === "needs-decision") return { kind: "single", text: r.text };
      // mutant 31: with no base only the oldest other text is offered back (`slice(0, 1)` for `slice(0, -1)`)
      if (plant.bug === "m31-body-no-base-offers-oldest-only" && r.kind === "needs-decision") return { ...r, offered: r.offered.slice(0, 1) };
      // mutant 8: heads with the same text are not taken as one: the text shown is offered back again, and every copy of a text is offered
      if (plant.bug === "m8-body-equal-texts-offered" && u.filter((c) => !c.deleted).length > 1) {
        const all = u.filter((c) => !c.deleted).sort((a, b) => (a.stamp.wall - b.stamp.wall) || (a.stamp.counter - b.stamp.counter) || (a.stamp.origin < b.stamp.origin ? -1 : 1));
        const newest = all[all.length - 1]!;
        if (base === null) return { kind: "needs-decision", text: newest.value as string, offered: all.slice(0, -1), reason: "no-base" };
      }
      return r;
    },
  };
}

/**
 * rules/moveCycle.ts, a COPY of its two functions (the cycle search is inside the module, out of a mock's reach), with mutant 388 switched by `mutant`: the path
 * that leads INTO a loop is taken as the loop, so a move outside it can be undone. Without the mutant it must give what the real function gives
 * (stampedMergePlanted.test.ts "the copies agree with the real functions").
 */
export function moveCycleCopy(unit: U, links: Parameters<M["resolveMoveCycles"]>[0], mutant: boolean): ReturnType<M["resolveMoveCycles"]> {
  function findCycle(parents: Map<string, string | null>): string[] | null {
    for (const start of [...parents.keys()].sort()) {
      const path: string[] = [], at = new Map<string, number>();
      for (let n: string | null | undefined = start; n !== null && n !== undefined; n = parents.get(n)) { if (at.has(n)) return mutant ? path : path.slice(at.get(n)!); at.set(n, path.length); path.push(n); }
    }
    return null;
  }
  const by = new Map(links.map((l) => [l.note, l])), parents = new Map(links.map((l) => [l.note, l.parent]));
  const fixes: ReturnType<M["resolveMoveCycles"]>["fixes"] = [], needsDecision: string[] = [], reverted = new Set<string>();
  for (let guard = 0; guard <= links.length; guard++) {
    const cycle = findCycle(parents);
    if (!cycle) break;
    const edges = cycle.map((n) => by.get(n)!).sort((a, b) => unit.compareStamps(b.stamp, a.stamp));
    const undo = edges.find((e) => e.from !== undefined && !reverted.has(e.note)), cut = undo ?? edges[0]!;
    reverted.add(cut.note);
    if (!undo) needsDecision.push(cut.note);
    const to = undo ? undo.from! : null;
    parents.set(cut.note, to);
    fixes.push({ note: cut.note, parent: to, notify: cut.stamp.author });
  }
  return { fixes, parents, needsDecision: needsDecision.sort() };
}

export function plantedMoveCycle(real: M, plant: PlantSwitch, unit: U): M {
  return { ...real, resolveMoveCycles: (links) => (plant.bug === "m388-move-undone-off-the-loop" ? moveCycleCopy(unit, links, true) : real.resolveMoveCycles(links)) };
}
