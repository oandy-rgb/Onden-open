// Merging ONE stamped unit (a row's field, a JSON key, a whole row, a tombstone) from two nodes.
// Contract and the reasons for its shape: ./README.md. Pure: no database, no clock, no model call.
//
// A unit's state is its HEADS: the writes nobody who wrote later had seen. Usually one; two or more while two
// nodes changed it without seeing each other. The visible value is the head with the largest stamp
// (hlc.ts compareOps), every other head with different content is a conflict that stays visible (and carries its value)
// until a write that saw it replaces it. This is a multi-value register: the state is a function of the SET of
// writes, so merge is commutative, associative and idempotent, and what counts as "a conflict" is the same on every node.
//
// Why the writer's `saw` is in a write (and a stamp alone is not enough): to tell "B edited after reading A's value" from
// "B edited without ever seeing A's value" a node holding only A's value needs more than two clock readings. With stamps
// alone, node 1 (X, then Y after X, then Z after Y) and node 2 (only X, then Z) would record different conflicts
// whichever order they met in. See the `saw` field and the pinned counterexample in stampedMerge.test.ts.

import { compareOps } from "../../hlc.js";
import { sha256Hex } from "../../utils.js";

/** Same constants as migration 202: a unit that was never written by anyone since stamps existed carries this origin, seq 0, clock 0/0. */
export const GENESIS_STAMP_ORIGIN = "genesis";

export type Stamp = { origin: string; seq: number; wall: number; counter: number; author: string | null; device: string | null };
/** For each origin, the highest sequence number of that origin's writes TO THIS UNIT the writer had seen when writing (its own earlier ones included). Per unit, never across units. */
export type Saw = Readonly<Record<string, number>>;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/**
 * One write: `deleted` is the tombstone (then `value` is null); a tombstone is a value like any other.
 * `meta` is what the writer knew that the receiver cannot work out: the place a note was moved from, what a deleter had
 * seen of the row (rules/). It travels with the write, is part of its identity, and is never compared when deciding
 * whether two writes say the same thing.
 */
export type Cell<V extends Json = Json> = { stamp: Stamp; saw: Saw; deleted: boolean; value: V | null; meta?: Json; valueless?: true };
/**
 * `valueless`: this copy of the write does not say what it wrote (a node kept the stamp of a row it no longer holds, and nothing told it the value). A mark of the
 * COPY, stored and sent as such (dbUnits.ts storeUnit, the wire's `kept` and a head's `valueless`), never a value: `value` is null, it is not checked, shown or counted
 * as a conflict, and where two copies of one write meet, the one with the value is kept (review of PR #1853, round 8: as a flag of a whole side it held only during one
 * merge, and once stored it became a NULL). A write is valueless only where its value was never kept: the tables whose rows go with their note keep it (README).
 */
/** The heads, largest stamp first. Never empty. Two nodes holding the same writes hold the same array, element for element. */
export type Unit<V extends Json = Json> = readonly Cell<V>[];

export const stampKey = (s: Pick<Stamp, "origin" | "seq">): string => `${s.origin}:${s.seq}`;
const order = (a: Stamp) => ({ hlc: { wall: a.wall, counter: a.counter }, origin: a.origin, seq: a.seq });
export const compareStamps = (a: Stamp, b: Stamp): number => compareOps(order(a), order(b));
export const isGenesis = (c: Cell): boolean => c.stamp.origin === GENESIS_STAMP_ORIGIN;

/** JSON with object keys sorted: equal content gives equal text, whatever order the keys were written in. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}
const content = (c: Cell): string => (c.deleted ? "\u0000tombstone" : c.valueless ? "\u0000valueless" : canonical(c.value));
/** Same content: both tombstones, or equal values. The stamps do not matter (rule 4.11 + add-device-snapshot §5). */
export const sameContent = (a: Cell, b: Cell): boolean => content(a) === content(b);
const cellText = (c: Cell): string => canonical(c);
/** Two copies of one write say the same thing: equal, or equal but for the value where one of them has none (it does not contradict what the other says). */
const sameWrite = (a: Cell, b: Cell): boolean => {
  if (!a.valueless && !b.valueless) return cellText(a) === cellText(b);
  const bare = ({ value: _v, valueless: _n, ...rest }: Cell) => canonical(rest);
  return bare(a) === bare(b);
};
/** What names a write: its (origin, seq). Genesis has no author and every node makes the same stamp, so its content names it. */
const cellKey = (c: Cell): string => (isGenesis(c) ? genesisName(c) : stampKey(c.stamp));

/**
 * The text a genesis value is named by. A string is its own text (what a database column holds, migration 205's `sync_content_text`
 * says the same in SQL), anything else is its canonical JSON, a tombstone a text no value can have. The prefixes keep the string "1" and the number 1 apart.
 */
const genesisContent = (c: Cell): string => (c.deleted ? "\u0000tombstone" : typeof c.value === "string" ? `s:${c.value}` : `j:${canonical(c.value)}`);
/** The name of a genesis content in a `saw` and in a stored head: `genesis:` + SHA-256 of the content text (hex), the same text and hash migration 205's `sync_genesis_hash` makes. */
const genesisNameOf = (contentText: string): string => `${GENESIS_STAMP_ORIGIN}:${sha256Hex(contentText)}`;
/** What a write's `saw` calls a genesis value (every node's genesis stamp is the same, so only the content tells two apart). */
export const genesisName = (c: Cell): string => genesisNameOf(genesisContent(c));

/** `a` had seen `b` when it was written. A genesis value is seen only by a write made on top of that same value: a real write made over a different genesis value had not seen this one. */
export function covers(a: Cell, b: Cell): boolean {
  if (isGenesis(b)) return !isGenesis(a) && a.saw[genesisName(b)] !== undefined;
  if (isGenesis(a)) return false;
  return b.stamp.seq <= (a.saw[b.stamp.origin] ?? -1);
}

/** The `saw` of a write made on top of `heads` (what a node that holds these heads has seen of this unit). */
function sawOf(heads: Unit | undefined): Saw {
  const saw: Record<string, number> = {};
  for (const h of heads ?? []) {
    if (isGenesis(h)) { saw[genesisName(h)] = 0; continue; }
    for (const [o, n] of Object.entries(h.saw)) saw[o] = Math.max(saw[o] ?? -1, n);
    saw[h.stamp.origin] = Math.max(saw[h.stamp.origin] ?? -1, h.stamp.seq);
  }
  return Object.fromEntries(Object.entries(saw).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export type Rejection = "same-stamp-different-content" | "malformed";
/** Not now: the receiver's own clock has not reached the stamp's clock minus the limit. It will, so the write must be offered again later. */
type Deferral = "clock-ahead";
export type SkewGate = { nowWall: number; maxSkewMs: number };
/** The limit a stamp's clock may run ahead of the receiver's own clock (10 minutes; docs/architecture/proposals/add-device-snapshot-2026-11-15.md §5 warns at 5). */
export const DEFAULT_MAX_SKEW_MS = 10 * 60_000;

/** Is this write too far ahead of the receiver's clock to take now? It may be taken later (see `Deferral`). */
export function deferReason(c: Cell, gate?: SkewGate): Deferral | null {
  return gate && !isGenesis(c) && c.stamp.wall > gate.nowWall + gate.maxSkewMs ? "clock-ahead" : null;
}

/** Why an incoming write can never be taken (null = fine). Checked on every incoming write before it is compared. */
export function rejectReason(c: Cell): Rejection | null {
  const s = c.stamp;
  const ints = [s.seq, s.wall, s.counter, ...Object.values(c.saw)];
  if (!ints.every((n) => Number.isSafeInteger(n) && n >= 0) || !s.origin) return "malformed";
  if (c.deleted && c.value !== null) return "malformed";
  if (c.valueless && (c.deleted || c.value !== null || isGenesis(c))) return "malformed"; // a tombstone and a genesis value say what they are
  if (c.saw[s.origin] !== undefined && c.saw[s.origin]! >= s.seq && !isGenesis(c)) return "malformed"; // a write cannot have seen itself or a later write of its own node
  // a re-send is a creation's copy beside the heads (never a tombstone, never genesis) and covers nothing: it settles nothing, so it can never take a head's place
  if (isResent(c) && (c.deleted || isGenesis(c) || Object.keys(c.saw).length > 0)) return "malformed";
  return null;
}

/**
 * A row's `*` sent again by a node that holds the row (README 「筆記以同一個 id 重建時，握有掛在它上面的列的節點把它們再送出」): a new stamp of the holder whose only job
 * is to make the row travel whole again (a stamp above what any node holds of the holder). It sits BESIDE the heads of `*` (its `saw` is empty: it covers nothing,
 * rejectReason) and says nothing of its own: it ranks below every head that is not a re-send (byWinner), so it is never the row's creation, never shown over a
 * delete, and nothing follows it (a field without a unit of its own follows the creations: rows.ts fieldsOf, dbUnits.ts readUnit).
 */
export const isResent = (c: Cell): boolean => (c.meta as { resent?: unknown } | null | undefined)?.resent === true;
/** Largest first; equal stamps (only genesis against genesis) fall back to the content so the order is still total. A re-send ranks below every head that is not one
 *  (isResent): a delete another node wrote after one holder's re-send is not undone by a second holder's later re-send. */
const byWinner = (a: Cell, b: Cell): number => Number(isResent(a)) - Number(isResent(b)) || compareStamps(b.stamp, a.stamp) || (cellText(a) < cellText(b) ? 1 : -1);
/** Heads in the order a unit holds them (the winner first): for a caller that has the heads already (stored or carried) and only orders them. */
export const inWinnerOrder = (cells: readonly Cell[]): Cell[] => [...cells].sort(byWinner);

/** The heads of a set of writes: duplicates removed, everything a later write had seen dropped. Throws nothing; the caller checked `rejectReason`. */
export function maximalHeads(cells: readonly Cell[]): Cell[] {
  const byDot = new Map<string, Cell>();
  // the same write twice: the later copy, unless it has no value and the earlier one has (callers put the copy they prefer last)
  for (const c of cells) { const k = cellKey(c), was = byDot.get(k); if (!was || !c.valueless || was.valueless) byDot.set(k, c); }
  const all = [...byDot.values()];
  return all.filter((c) => !all.some((o) => o !== c && covers(o, c))).sort(byWinner);
}

type UnitOutcome = "same" | "took" | "kept" | "conflict" | "rejected" | "deferred";
export type MergeResult = {
  /** The unit after the merge (the local one again when rejected). */
  unit: Unit;
  outcome: UnitOutcome;
  /** The stored value or stamp changed: what a row and its stamp table show. (The heads can change without this.) */
  write: boolean;
  /** `conflict`: the values that lost and are now (newly) kept as a conflict, each with its stamp. */
  losers: Cell[];
  /** `rejected`: why. The incoming write is not kept and not a conflict. */
  reason?: Rejection;
  /**
   * Writes set aside because their clock is ahead of ours (`outcome` is `deferred` when nothing else came in). They are
   * neither applied nor dropped: the caller offers them again later, and must not count the sender's progress (which
   * sequence numbers of that origin it already has) past the first of them.
   */
  deferred: Cell[];
};

/**
 * Content of the heads that differ from the winner's: what keeps a system write off the unit (writeUnit). No screen shows a person the other heads yet (none reads
 * sync_stamp_heads, README 「接上傳輸前必須完成」); a future conflict screen must use this, so that what it shows as "the other values" is what refuses a system
 * write. A copy without a value is no value, and neither is a holder's re-send (isResent): a copy of a creation that says nothing of its own, also beside a later
 * delete of the row (review of PR #2024, round 2, point 1). Migration 240 sync_stamp_put_over skips the same two in the database's refusal of a system write.
 */
export function conflictsOf(unit: Unit): Cell[] {
  const win = unit[0]!;
  return unit.filter((c) => c !== win && !c.valueless && !isResent(c) && (win.valueless || !sameContent(c, win)));
}
export const winnerOf = (unit: Unit): Cell => unit[0]!;

const unitText = (u: Unit | undefined): string => (u ? u.map(cellText).join("\n") : "");

/**
 * What happens when `incoming` meets `local` (undefined = this node has no such unit).
 *   same      nothing new: same content (the larger stamp is kept), or the incoming head was already here;
 *   kept      the incoming value had already been replaced by something the local side holds: local stays;
 *   took      the incoming write replaces the local value (or the unit is new here);
 *   conflict  two writes neither of which had seen the other, with different content: the larger stamp is the value,
 *             the other is returned in `losers` and stays in `unit` until a write that saw it replaces both;
 *   rejected  same (origin, seq) with different content, a malformed write, or a clock too far ahead: nothing changes.
 * Commutative and associative as a function of `unit` (but `outcome` describes this merge, from this side).
 */
export function mergeUnit(local: Unit | undefined, incoming: Unit, gate?: SkewGate): MergeResult {
  const keep = (reason: Rejection): MergeResult => ({ unit: local ?? incoming, outcome: "rejected", write: false, losers: [], reason, deferred: [] });
  for (const c of incoming) { const r = rejectReason(c); if (r) return keep(r); }
  const here = new Map((local ?? []).map((c) => [cellKey(c), c]));
  for (const c of incoming) { const h = here.get(cellKey(c)); if (h && !sameWrite(h, c)) return keep("same-stamp-different-content"); }
  // Only the writes that are too far ahead wait; the others of the same unit are taken now.
  const deferred = incoming.filter((c) => deferReason(c, gate) !== null);
  const now = incoming.filter((c) => !deferred.includes(c));
  if (!now.length) return { unit: local ?? incoming, outcome: "deferred", write: false, losers: [], deferred };
  if (!local) return { unit: maximalHeads(now), outcome: "took", write: true, losers: [], deferred };
  return { ...describeUnitChange(local, maximalHeads([...local, ...now]), now), deferred };
}

/**
 * What changed between the heads a node held (`before`) and the heads it holds now (`after`), told from the unit's own state,
 * so a caller that builds `after` itself (store.ts, where a field also follows `*`) gets the same account the store keeps.
 * `incoming` (optional) tells `same` from `kept` when the heads did not change.
 */
export function describeUnitChange(before: Unit | undefined, after: Unit, incoming: readonly Cell[] = []): Omit<MergeResult, "deferred"> {
  if (!before) return { unit: after, outcome: "took", write: true, losers: [] };
  const wasConflict = new Set(conflictsOf(before).map(cellKey));
  const losers = conflictsOf(after).filter((c) => !wasConflict.has(cellKey(c)));
  const write = cellText(after[0]!) !== cellText(before[0]!);
  const held = new Set(before.map(cellKey));
  let outcome: UnitOutcome;
  if (losers.length) outcome = "conflict";
  else if (unitText(after) === unitText(before)) outcome = incoming.every((c) => held.has(cellKey(c))) ? "same" : "kept";
  else outcome = sameContent(after[0]!, before[0]!) ? "same" : "took";
  return { unit: after, outcome, write, losers };
}

/**
 * A local change. By a person: it has seen everything `local` holds, so it replaces all of it, a conflict too (this is how a
 * person resolves one). By the system (recalculation, schedulers, a function keeping its own field): it never resolves a
 * conflict nobody has looked at, and a write that sees only some heads cannot be told in a `saw`, which counts per origin
 * (a later write of the same origin would be taken to have seen the earlier one too). So the system does not write to a
 * unit that is in conflict: `local` comes back unchanged, and the caller waits for a person or tries again later.
 */
export function writeUnit(local: Unit | undefined, stamp: Stamp, change: ({ value: Json } | { deleted: true }) & { meta?: Json }, by: "person" | "system" = "person"): Unit {
  if (by === "system" && local && conflictsOf(local).length > 0) return local;
  const body = "deleted" in change ? { deleted: true, value: null } : { deleted: false, value: change.value };
  return [{ stamp, saw: sawOf(local), ...body, ...(change.meta === undefined ? {} : { meta: change.meta }) }];
}
