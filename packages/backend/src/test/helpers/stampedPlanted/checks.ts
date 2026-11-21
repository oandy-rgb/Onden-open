// Checks the pure simulator (helpers/stampedSim/) did not have, found by planting known bugs (stampedMergePlanted.test.ts): each one
// is a README sentence that no existing check enforced, stated in plain words. They run over the same worlds as the existing checks.
//
//   checkArrivals     every write that arrives is, right after that arrival, taken (a head, or seen by a head), ended by a delete that had
//                     seen it, refused, or set aside to be offered again; and only a write whose own clock is too far ahead is set aside.
//                     README "這個設計成立的前提": 「被延後的寫入要再送一次，而且不可把『我已有某來源到第幾號』記過它。一個單位裡只有超前的那一筆延後，其他的照收。」
//                     Why the existing checks miss it: the simulator's settle step has every node send everything it holds to every other node,
//                     so a write that one arrival silently dropped usually comes back by another road (no node keeps a "have up to N" mark that would stop it):
//                     planted, the existing checks first saw "a deferred write counted as received" on the 32nd of 200 seeds, this one on the first.
//   checkBodyNoBase   a body written on both sides with no base known keeps every text: the newest in the body, every other one offered back whole.
//                     README table: 「body.ts | 內文兩邊都改過：呼叫既有的 mergeBody（注入），找不到基底就兩份都留」.
//                     Why the existing check misses it: checkRules' 4.12 always passes the base (BASE_BODY), so the no-base road never runs.
//   checkMalformedRefused  a malformed write (README: 「同一個 (origin, seq) 內容不同、格式不合：拒絕，不是衝突，不改變任何東西」) is refused and changes nothing, also on a node
//                     that does not hold that unit yet. The simulator never sends a malformed write, so no existing check could see mutant 909.
//   checkMoveFixes    rule 4.10 「搬動造成迴圈：較晚的那一筆不生效」: a move is undone only while it is part of a loop. Replayed fix by fix, each fixed note is on a loop
//                     of the parents as they stand at that fix. The existing check sees only "no loop left" (mutant 388 undoes a move that leads INTO a loop). The simulator rarely makes that case
//                     (a planted 388 was caught after 2 to more than 30 seeds), so it is also checked on a fixed case (moveFixBreaks).
//   checkAcrossDeletes  README 「刪除之後再建立」, judged from the log (what each delete and each re-creation held), never from `saw`: a field write a deleter had seen
//                     is ended once a live re-creation held that delete, and every other write is kept. checkNoLoss and the oracle do not model deletes: on rows made
//                     again with fields the creation does not set they call the rule a loss. On that scenario the real code fails this check (stampedMergeFindings.test.ts).
//   genesisNamingBreaks    the README's naming of a value from before stamps (「字串＝s:＋原文，其他＝j:＋canonical JSON」, sha-256): two different values never share
//                     a name, and the name is the one migration 205 makes. Deterministic.
//   bodyThreeTextsBreaks   three different texts and a repeated one, no base: every different text is kept once, the shown one is not offered again. Deterministic;
//                     the simulator rarely makes three heads of one body.
import { mergeBody } from "../../../services/eventLog/bodyMergeMoves.js";
import { sha256Hex } from "../../../utils.js";
import { resolveBody } from "../../../spine/stampedMerge/body.js";
import { resolveMoveCycles } from "../../../spine/stampedMerge/rules/moveCycle.js";
import { type Cell, type Json, type Unit, canonical, covers, deferReason, genesisName, isGenesis, stampKey } from "../../../spine/stampedMerge/unit.js";
import { type Store, STAR, addressKey, droppedBySeen, effectiveUnit, mergeStore, parseAddress, rowKeys, storeText } from "../../../spine/stampedMerge/store.js";
import { makeRng, type Rng } from "../distSim/rng.js";
import { StampedWorld, type SimNode } from "../stampedSim/world.js";
import { NOTE, applyStampedOp, linksOf, resetUnique, type Step } from "../stampedSim/domain.js";
import type { RunOptions } from "../stampedSim/runner.js";

const nameOf = (c: Unit[number]) => (isGenesis(c) ? genesisName(c) : stampKey(c.stamp));

type Held = { row: string; dot: string; held: Set<string> };
/** The simulator's world, unchanged, with every arrival accounted for as it happens, and what each permanent delete and each re-creation held (from the store, not from `saw`). */
class AccountedWorld extends StampedWorld {
  readonly arrivalBreaks: string[] = [];
  readonly purges: Held[] = [];
  readonly remakes: Held[] = [];
  override local(n: SimNode, kind: string, change: Parameters<StampedWorld["local"]>[2]): void {
    const before = n.store, count = this.writes.length;
    super.local(n, kind, change);
    const star = this.writes.slice(count).find((x) => x.address.field === STAR && x.node === n.id);
    if (!star || (kind !== "note.purge" && kind !== "note.derived")) return;
    const { table, row } = star.address, dot = stampKey(star.cell.stamp);
    if (kind === "note.purge") {
      const held = new Set<string>();
      for (const [key, unit] of before) { const a = parseAddress(key); if (a.table === table && a.row === row && a.field !== STAR) for (const c of effectiveUnit(before, a) ?? unit) held.add(`${stampKey(c.stamp)}@${a.field}`); }
      this.purges.push({ row, dot, held });
    } else if (before.has(addressKey({ table, row, field: STAR }))) {
      this.remakes.push({ row, dot, held: new Set((before.get(addressKey({ table, row, field: STAR })) ?? []).map((c) => stampKey(c.stamp))) });
    }
  }
  override ingest(n: SimNode, items: readonly [string, Unit][]): void {
    const gate = this.gate(n), refusedBefore = n.refused.length;
    super.ingest(n, items);
    const refused = new Set(n.refused.slice(refusedBefore).map((r) => addressKey(r.address)));
    for (const [key, unit] of items) {
      if (refused.has(key)) continue;
      const address = parseAddress(key);
      const heads = (address.field === STAR ? n.store.get(key) : effectiveUnit(n.store, address)) ?? [];
      const star = n.store.get(addressKey({ ...address, field: STAR }));
      const waiting = new Set((n.deferred.get(key) ?? []).map(nameOf));
      for (const c of unit) {
        const where = `${n.id}: a ${address.field === STAR ? "row" : "field"} write of ${address.table} from ${c.stamp.origin} #${c.stamp.seq}`;
        if (waiting.has(nameOf(c))) { if (deferReason(c, gate) === null) this.arrivalBreaks.push(`${where} was set aside although its clock is within the limit`); continue; }
        const kept = heads.some((h) => nameOf(h) === nameOf(c) || covers(h, c));
        const endedByDelete = address.field !== STAR && droppedBySeen(star, [c]).length === 0;
        if (!kept && !endedByDelete) this.arrivalBreaks.push(`${where} arrived and is neither taken, nor refused, nor set aside to be offered again`);
      }
    }
  }
}

/** helpers/stampedSim/runner.ts `runStampedSim`, the same lines, on an AccountedWorld. */
export function runAccounted(seed: number, steps: readonly Step[], o: RunOptions): AccountedWorld {
  resetUnique();
  const w = new AccountedWorld(o.nodes, makeRng(seed ^ 0x9e3779b9), o);
  for (const s of steps) {
    if (s.t === "op") applyStampedOp(w, w.nodes[s.node % w.nodes.length]!, s.kind, s.p);
    else if (s.t === "deliver") w.deliver(s.n);
    else if (s.t === "tick") w.tick(s.ms);
    else { const a = w.nodes[s.a % w.nodes.length]!, b = w.nodes[s.b % w.nodes.length]!; if (a !== b) { w.ingest(b, [...a.store]); w.ingest(a, [...b.store]); } }
  }
  w.settle(o.catchUpMs ?? 0);
  return w;
}

/** Every arrival accounted for (see the file header). Only the honest nodes' arrivals count: the fast node's own store is not the promise. */
export function checkArrivals(w: StampedWorld): string[] {
  if (!(w instanceof AccountedWorld)) throw new Error("checkArrivals needs a world made by runAccounted");
  const honest = new Set(w.honest.map((n) => n.id));
  return w.arrivalBreaks.filter((b) => honest.has(b.split(":")[0]!)).map((b) => `(3) ${b}`);
}

/** A body on both sides with no base: every line any head wrote is in the body shown or in a copy offered back (see the file header). */
export function checkBodyNoBase(w: StampedWorld): string[] {
  const out: string[] = [];
  const s = w.honest[0]?.store;
  if (!s) return out;
  for (const { row } of rowKeys(s, NOTE)) {
    const u = effectiveUnit(s, { table: NOTE, row, field: "body" });
    if (!u || u.length < 2) continue;
    const res = resolveBody(u, null, mergeBody);
    const kept = [res.text, ...("offered" in res ? res.offered.map((c) => String(c.value)) : [])].join("\n");
    for (const c of u) if (!c.deleted) for (const line of String(c.value).split("\n")) if (/加的句子|改寫/.test(line) && !kept.includes(line)) out.push("(3) 4.12 without a base: a line one writer wrote is neither in the body nor in a copy offered back");
    out.push(...offeredOnce(res));
  }
  return out;
}

/** 「內容相同不算衝突」: what is offered back is never the text shown, and no text is offered twice. */
function offeredOnce(res: ReturnType<typeof resolveBody>): string[] {
  if (!("offered" in res)) return [];
  const texts = res.offered.map((c) => String(c.value));
  return texts.some((t) => t === res.text) || new Set(texts).size !== texts.length ? ["(3) 4.12: the same text is offered back twice, or the text shown is offered back again"] : [];
}

const T = 1_700_000_000_000;
const bodyCell = (origin: string, seq: number, value: string): Cell => ({ stamp: { origin, seq, wall: T + seq * 10 + origin.length, counter: 0, author: origin, device: null }, saw: {}, deleted: false, value });
/** Three nodes wrote the body without seeing each other, two of them the same text; no base. */
export function bodyThreeTextsBreaks(resolve: typeof resolveBody = resolveBody): string[] {
  const u = [bodyCell("n3", 3, "丙的內文\n"), bodyCell("n2", 2, "乙的內文\n"), bodyCell("n1", 1, "甲的內文\n"), bodyCell("n4", 1, "乙的內文\n")];
  const res = resolve(u, null, mergeBody);
  const kept = [res.text, ...("offered" in res ? res.offered.map((c) => String(c.value)) : [])];
  return [...["甲的內文\n", "乙的內文\n", "丙的內文\n"].filter((t) => !kept.includes(t)).map(() => "(3) 4.12 without a base, three texts: one of them is neither shown nor offered back"), ...offeredOnce(res)];
}

/** The README's name of a value from before stamps, and two different values never share one. `name` is unit.ts genesisName unless a test passes a copy. */
export function genesisNamingBreaks(name: (c: Cell) => string = genesisName): string[] {
  const out: string[] = [];
  const g = (value: Json): Cell => ({ stamp: { origin: "genesis", seq: 0, wall: 0, counter: 0, author: null, device: null }, saw: {}, deleted: false, value });
  const values: Json[] = ["a", "b", "1", 1, "null", null, "{}", {}, { a: 1 }, true, "true", ""];
  for (const v of values) {
    const want = `genesis:${sha256Hex(typeof v === "string" ? `s:${v}` : `j:${canonical(v)}`)}`;
    if (name(g(v)) !== want) out.push(`(1) the value ${typeof v} ${JSON.stringify(v)} from before stamps is not named the way migration 205 names it`);
  }
  const names = [...values.map((v) => name(g(v))), name({ ...g(null), deleted: true })];
  if (new Set(names).size !== names.length) out.push("(1) two different values from before stamps share one name: one of them would be lost as a head");
  return out;
}

/** A malformed copy of a write that was sent is refused and changes nothing, on a node that holds the unit and on one that holds nothing (see the file header). */
export function checkMalformedRefused(w: StampedWorld, rng: Rng, trials = 8): string[] {
  const out: string[] = [];
  const sent = w.sent.flatMap((m) => m.items).filter(([, u]) => u.some((c) => !isGenesis(c)));
  const node = w.honest[0];
  if (!node || !sent.length) return out;
  const breakers: ((c: Cell) => Cell)[] = [
    (c) => ({ ...c, stamp: { ...c.stamp, seq: -1 } }),
    (c) => ({ ...c, deleted: true, value: "still a value" }),
    (c) => ({ ...c, saw: { ...c.saw, [c.stamp.origin]: c.stamp.seq } }),
    (c) => ({ ...c, stamp: { ...c.stamp, wall: 1.5 } }),
  ];
  for (let i = 0; i < trials; i++) {
    const [key, unit] = sent[rng.int(sent.length)]!;
    const k = unit.findIndex((c) => !isGenesis(c));
    const bad: Unit = unit.map((c, j) => (j === k ? breakers[i % breakers.length]!(c) : c));
    for (const local of [new Map<string, Unit>(), node.store]) {
      const r = mergeStore(local, new Map([[key, bad]]));
      if (!r.rejected.some((x) => addressKey(x.address) === key)) out.push(`(5) a malformed write of ${parseAddress(key).table} was not refused (${local.size ? "on a node that holds it" : "on a node that holds nothing"})`);
      if (canonical(r.store.get(key)) !== canonical(local.get(key)) || (local.size && storeText(r.store) !== storeText(local))) out.push(`(5) a refused write of ${parseAddress(key).table} changed what the node holds`);
    }
  }
  return out;
}

/** Rule 4.10, replayed fix by fix: each move undone is, at that moment, part of a loop (see the file header). */
export function checkMoveFixes(w: StampedWorld): string[] {
  const s = w.honest[0]?.store;
  return s ? moveFixBreaks(linksOf(s)) : [];
}
/** The same over given parent links (a fixed case: the simulator rarely makes a move that leads into a loop AND is the latest). */
export function moveFixBreaks(links: Parameters<typeof resolveMoveCycles>[0]): string[] {
  const r = resolveMoveCycles(links);
  const parents = new Map(links.map((l) => [l.note, l.parent]));
  const onLoop = (n: string) => { const seen = new Set<string>(); for (let x = parents.get(n); x; x = parents.get(x)) { if (x === n) return true; if (seen.has(x)) return false; seen.add(x); } return false; };
  const out: string[] = [];
  for (const f of r.fixes) { if (!onLoop(f.note)) out.push("(6) 4.10: a move that is not part of a loop was undone"); parents.set(f.note, f.parent); }
  return out;
}

/**
 * Permanent deletes, both ways: README 「刪除之後再建立」 — a field write the deleter HAD seen ends with the delete once the row is made again by someone who
 * held that delete (it is not a head any more); a write the deleter had NOT seen stays (as a head, or seen by one). "Seen" here is the log (what each node held when it wrote, as checkAgainstOracle
 * builds it), never `saw`. checkNoLoss and checkAgainstOracle do not know about deletes ending writes, so on rows made again over a delete with fields the creation
 * does not set they report losses that are the rule (see stampedMergePlanted.test.ts).
 */
export function checkAcrossDeletes(w: StampedWorld): string[] {
  if (!(w instanceof AccountedWorld)) throw new Error("checkAcrossDeletes needs a world made by runAccounted");
  const ref = w.honest[0];
  if (!ref) return [];
  const honest = new Set(w.honest.map((n) => n.id));
  const parents = new Map<string, string[]>();
  for (const x of w.writes) parents.set(`${stampKey(x.cell.stamp)}@${addressKey(x.address)}`, x.sawHeads);
  const closure = (dots: Iterable<string>, a: string): Set<string> => {
    const out = new Set<string>(), todo = [...dots];
    while (todo.length) { const d = todo.pop()!; if (out.has(d)) continue; out.add(d); todo.push(...(parents.get(`${d}@${a}`) ?? [])); }
    return out;
  };
  const waiting = new Set(w.nodes.flatMap((n) => [...n.refused.map((r) => `${stampKey(r.stamp)}|${addressKey(r.address)}`), ...[...n.deferred].flatMap(([k, cells]) => cells.map((c) => `${stampKey(c.stamp)}|${k}`))]));
  const out: string[] = [];
  for (const x of w.writes) {
    if (!honest.has(x.node) || x.address.field === STAR) continue;
    const a = addressKey(x.address), dot = stampKey(x.cell.stamp);
    const heads = (effectiveUnit(ref.store, x.address) ?? []).map((c) => stampKey(c.stamp));
    if (closure(heads, a).has(dot) || waiting.has(`${dot}|${a}`)) continue;
    if (endedByDelete(w, ref.store, x, closure) === false) out.push(`(3) ${x.kind} by ${x.node} #${x.cell.stamp.seq} is lost: not kept, not seen by a later write, and no delete that had seen it was made again`);
  }
  // and the other way: a head of a field that a delete had ended (its deleter held it, and the row was made again by someone who held that delete) came back
  for (const x of w.writes) {
    if (!honest.has(x.node) || x.address.field === STAR) continue;
    const heads = (effectiveUnit(ref.store, x.address) ?? []).map((c) => stampKey(c.stamp));
    if (heads.includes(stampKey(x.cell.stamp)) && endedByDelete(w, ref.store, x, closure) === true) out.push(`(3) ${x.kind} by ${x.node} #${x.cell.stamp.seq} is a head again although a delete that had seen it was made again`);
  }
  return out;
}

/**
 * `x` was ended by a delete: some permanent delete's node held it (or a later write to that field that had seen it), and a creation of the row that is live now
 * (a head of `*`, or one a live head was made after) was made by a node that held that delete AS A HEAD of `*` (the delete it made the row again over). Two
 * cases the README does not settle are left alone (the PR lists them under "the spec does not say"): the row deleted again after the re-creation (does what it
 * ended stay ended?), and a delete that a later delete had covered before the re-creation (does what the FIRST deleter had seen still end?).
 */
function endedByDelete(w: AccountedWorld, store: Store, x: StampedWorld["writes"][number], closure: (dots: Iterable<string>, a: string) => Set<string>): boolean | "unsettled" {
  const a = addressKey(x.address), dot = stampKey(x.cell.stamp), starKey = addressKey({ ...x.address, field: STAR });
  const live = closure((store.get(starKey) ?? []).filter((c) => !c.deleted).map((c) => stampKey(c.stamp)), starKey);
  const heldBy = w.purges.filter((p) => p.row === x.address.row && closure([...p.held].filter((h) => h.endsWith(`@${x.address.field}`)).map((h) => h.slice(0, h.lastIndexOf("@"))), a).has(dot));
  const remakes = w.remakes.filter((r) => r.row === x.address.row && live.has(r.dot));
  if (heldBy.some((p) => remakes.some((r) => r.held.has(p.dot)))) return true;
  // a delete that held it, behind a later delete the re-creation was made over: the README does not say whether the first deleter's knowledge still ends it
  if (heldBy.some((p) => remakes.some((r) => closure(r.held, starKey).has(p.dot)))) return "unsettled";
  return false;
}
