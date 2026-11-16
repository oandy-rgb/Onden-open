// Run a step list, bring the world to rest, and check what must hold. Every check returns what failed, as structure only
// (node ids, kinds, sequence numbers): never a note's text.
import { shrinkList } from "../distSim/run.js";
import { makeRng, type Rng } from "../distSim/rng.js";
import { canonical, type Unit, compareStamps, conflictsOf, genesisName, isGenesis, sameContent, stampKey } from "../../../spine/stampedMerge/unit.js";
import { type Store, effectiveUnit, fieldsOf, mergeStore, parseAddress, rowKeys, rowOf, storeText } from "../../../spine/stampedMerge/store.js";
import { resolveBody } from "../../../spine/stampedMerge/body.js";
import { resolveNameClashes, resolveSlugs, resolveTagNames, resolveViewNames } from "../../../spine/stampedMerge/rules/names.js";
import { resolveRunningFocus } from "../../../spine/stampedMerge/rules/focus.js";
import { noticesForEditedDeletes, recoverLateEdits, trashOrphanedChildren } from "../../../spine/stampedMerge/rules/trash.js";
import { resolveMoveCycles } from "../../../spine/stampedMerge/rules/moveCycle.js";
import { mergeDuplicateRefs } from "../../../spine/stampedMerge/rules/functionRefs.js";
import { mergeBody } from "../../../services/eventLog/bodyMergeMoves.js";
import { StampedWorld, type WorldOptions } from "./world.js";
import { BASE_BODY, NOTE, applyStampedOp, editsOf, focusOf, linksOf, purgedOf, refsOf, resetUnique, slugsOf, tagsOf, treeOf, viewsOf, type Step } from "./domain.js";

export type RunOptions = WorldOptions & { nodes: number; /** after everything is delivered, move every clock on by this much and offer the deferred writes again */ catchUpMs?: number };

export function runStampedSim(seed: number, steps: readonly Step[], o: RunOptions): StampedWorld {
  resetUnique();
  const rng = makeRng(seed ^ 0x9e3779b9);
  const w = new StampedWorld(o.nodes, rng, o);
  for (const s of steps) {
    if (s.t === "op") applyStampedOp(w, w.nodes[s.node % w.nodes.length]!, s.kind, s.p);
    else if (s.t === "deliver") w.deliver(s.n);
    else if (s.t === "tick") w.tick(s.ms);
    else { const a = w.nodes[s.a % w.nodes.length]!, b = w.nodes[s.b % w.nodes.length]!; if (a !== b) { w.ingest(b, [...a.store]); w.ingest(a, [...b.store]); } }
  }
  w.settle(o.catchUpMs ?? 0);
  return w;
}

const dots = (u: Unit | undefined) => (u ?? []).map((c) => stampKey(c.stamp));

/** 1. Convergence: every honest node holds exactly the same writes (heads, stamps, conflicts), byte for byte. */
export function checkConvergence(w: StampedWorld): string[] {
  const [first, ...rest] = w.honest;
  if (!first) return [];
  const want = storeText(first.store);
  return [...rest.filter((n) => storeText(n.store) !== want).map((n) => `(1) ${n.id} differs from ${first.id}`), ...w.eventMismatches.map((m) => `(1) ${m}`)];
}

/** 1 again, from the other side: the same messages, delivered whole in other orders and twice over, give the same stores as the run did. */
export function checkOrderFree(w: StampedWorld, rng: Rng, orders = 3): string[] {
  const out: string[] = [];
  const want = w.honest[0] ? storeText(w.honest[0].store) : "";
  for (let k = 0; k < orders; k++) {
    const msgs = [...w.sent, ...w.sent.filter(() => rng.chance(0.3))];
    for (let i = msgs.length - 1; i > 0; i--) { const j = rng.int(i + 1); [msgs[i], msgs[j]] = [msgs[j]!, msgs[i]!]; }
    const probe = new StampedWorld(1, rng, { drop: 0, duplicate: 0, skewsMs: [Math.max(...w.nodes.map((n) => n.skewMs))], maxSkewMs: Number.MAX_SAFE_INTEGER });
    for (const m of msgs) if (w.honest.some((n) => n.id === m.from)) probe.ingest(probe.nodes[0]!, m.items);
    if (storeText(probe.nodes[0]!.store) !== want) out.push(`(1) replaying ${msgs.length} messages in order #${k} gives a different result`);
  }
  return out;
}

/** 2. Idempotent, commutative, associative: on stores built from random parts of what was sent. */
export function checkAlgebra(w: StampedWorld, rng: Rng, trials = 6): string[] {
  const out: string[] = [];
  const part = (): Store => { let s: Store = new Map(); for (const m of w.sent) if (rng.chance(0.4)) s = mergeStore(s, new Map(m.items)).store; return s; };
  const m = (a: Store, b: Store) => mergeStore(a, b).store;
  for (let i = 0; i < trials; i++) {
    const a = part(), b = part(), c = part();
    if (storeText(m(a, a)) !== storeText(a)) out.push("(2) merge(a, a) differs from a");
    if (storeText(m(a, b)) !== storeText(m(b, a))) out.push("(2) merge(a, b) differs from merge(b, a)");
    if (storeText(m(m(a, b), c)) !== storeText(m(a, m(b, c)))) out.push("(2) merge is not associative");
    if (storeText(m(m(a, b), b)) !== storeText(m(a, b))) out.push("(2) merging b twice differs from once");
  }
  return out;
}

const addr = (a: { table: string; row: string; field: string }) => `${a.table}\u0001${a.row}\u0001${a.field}`;
/** What every honest node's local changes say about each other: for each write, the writes its node held when it made it. */
function truthGraph(w: StampedWorld) {
  const honest = new Set(w.honest.map((n) => n.id));
  const parents = new Map<string, string[]>();
  const own = new Map<string, string[]>();
  for (const wr of w.writes) {
    if (!honest.has(wr.node)) continue;
    const dot = stampKey(wr.cell.stamp);
    parents.set(`${dot}@${addr(wr.address)}`, wr.sawHeads);
    own.set(addr(wr.address), [...(own.get(addr(wr.address)) ?? []), dot]);
  }
  const memo = new Map<string, Set<string>>();
  const ancestors = (unit: string, dot: string): Set<string> => {
    const k = `${dot}@${unit}`;
    const hit = memo.get(k);
    if (hit) return hit;
    const set = new Set<string>();
    memo.set(k, set);
    for (const p of parents.get(k) ?? []) { set.add(p); for (const x of ancestors(unit, p)) set.add(x); }
    return set;
  };
  return { own, ancestors };
}

/**
 * An oracle that does not use `covers` or `saw`: every local change recorded which writes its node held when it made it,
 * so "B was made after seeing A" is known from that log, not from the stamps under test. Once everything is delivered the
 * heads of each unit must be exactly the writes no later write had seen (3: nothing is lost; 1: the conflicts are the same everywhere).
 */
export function checkAgainstOracle(w: StampedWorld): string[] {
  const out: string[] = [];
  const ref = w.honest[0];
  if (!ref) return out;
  const { own, ancestors } = truthGraph(w);
  for (const { table, row } of rowKeys(ref.store)) {
    for (const field of ["*", ...fieldsOf(ref.store, table, row)]) {
      const a = { table, row, field };
      const mine = own.get(addr(a)) ?? [];
      // A field also follows the creation values it has not been written over (their dots appear in the `sawHeads` of later writes).
      const star = field === "*" ? [] : (effectiveUnit(ref.store, { table, row, field: "*" }) ?? []).filter((h) => !h.deleted && h.value !== null && typeof h.value === "object" && field in (h.value as object)).map((h) => stampKey(h.stamp));
      const all = [...new Set([...mine, ...star])];
      const covered = (d: string) => all.some((o) => o !== d && mine.includes(o) && ancestors(addr(a), o).has(d));
      const want = all.filter((d) => !covered(d)).sort();
      const got = (effectiveUnit(ref.store, a) ?? []).filter((c) => !isGenesis(c)).map((c) => stampKey(c.stamp)).sort(); // values from before stamps are checked by checkGenesisValues
      if (all.length && JSON.stringify(want) !== JSON.stringify(got)) out.push(`(1) the heads of a ${field === "*" ? "row" : field.startsWith("key:") ? "key" : "field"} in ${table} are not the writes nobody had seen: want ${want.length}, got ${got.length}`);
    }
  }
  return out;
}

/**
 * A value that was there before stamps (a genesis value) is never lost unseen: after everything is delivered, each such value is still a head of
 * its unit unless some write was made by a node that held that value (the write's `saw` names it). A real write over a different genesis value does not replace it.
 */
export function checkGenesisValues(w: StampedWorld): string[] {
  const out: string[] = [];
  const ref = w.honest[0];
  if (!ref) return out;
  for (const [key, names] of w.genesisSeeds) {
    const address = parseAddress(key);
    const seen = new Set(w.writes.filter((x) => addr(x.address) === addr(address) && w.nodes.find((n) => n.id === x.node)!.honest).flatMap((x) => x.sawGenesis));
    const want = [...names].filter((n) => !seen.has(n)).sort();
    const got = (effectiveUnit(ref.store, address) ?? []).filter(isGenesis).map(genesisName).sort();
    if (JSON.stringify(want) !== JSON.stringify(got)) out.push(`(1) a value from before stamps was ${want.length > got.length ? "replaced by a write that never saw it" : "kept after a write that saw it"}: want ${want.length} of them left, got ${got.length}`);
  }
  return out;
}

/** 5 (the system never settles a conflict): no write of kind "system" was made on a unit that had a conflict; the person's write is the only way out. */
export function checkSystemLeavesConflicts(w: StampedWorld): string[] {
  return w.writes.filter((x) => x.kind === "note.system" && x.conflictedBefore).map((x) => `(5) ${x.node} #${x.cell.stamp.seq}: a system write was made on a unit in conflict`);
}

/** 3. No input lost: each local change is a head of its unit now, or an ancestor of one (a later write had seen it), or the gate set it aside and kept it. */
export function checkNoLoss(w: StampedWorld): string[] {
  const out: string[] = [];
  const ref = w.honest[0];
  if (!ref) return out;
  const { ancestors } = truthGraph(w);
  const refused = new Set(w.nodes.flatMap((n) => [...n.refused.map((r) => `${stampKey(r.stamp)}|${addr(r.address)}`), ...[...n.deferred].flatMap(([k, cells]) => cells.map((c) => `${stampKey(c.stamp)}|${k}`))]));
  for (const wr of w.writes) {
    if (!w.nodes.find((n) => n.id === wr.node)!.honest) continue;
    const dot = stampKey(wr.cell.stamp);
    const heads = (effectiveUnit(ref.store, wr.address) ?? []).map((c) => stampKey(c.stamp));
    if (!heads.some((h) => h === dot || ancestors(addr(wr.address), h).has(dot)) && !refused.has(`${dot}|${addr(wr.address)}`)) out.push(`(3) ${wr.kind} by ${wr.node} #${wr.cell.stamp.seq} is neither kept nor replaced by a write that saw it`);
  }
  return out;
}

/** 4. Causality: a node's every change sorts after everything it had seen, and after the values it replaced there is nothing left of them. */
export function checkCausality(w: StampedWorld): string[] {
  const out = [...w.causalityBreaks.map((b) => `(4) ${b}`)];
  const ref = w.honest[0];
  if (!ref) return out;
  for (const wr of w.writes) {
    if (!w.nodes.find((n) => n.id === wr.node)!.honest) continue;
    const unit = effectiveUnit(ref.store, wr.address) ?? [];
    for (const old of wr.sawHeads) if (dots(unit).includes(old)) out.push(`(4) ${wr.node} #${wr.cell.stamp.seq} replaced ${old} after seeing it, yet ${old} is still a head`);
  }
  return out;
}

/** 5. Skew: nothing from a node whose clock ran too far ahead is in an honest store, and no stamp there is later than the honest clocks allow. */
export function checkSkew(w: StampedWorld): string[] {
  const out: string[] = [];
  const limit = Math.max(...w.honest.map((n) => w.physical(n))) + 0;
  const rogue = new Set(w.nodes.filter((n) => !n.honest).map((n) => n.id));
  for (const n of w.honest) for (const [key, unit] of n.store) for (const c of unit) {
    if (rogue.has(c.stamp.origin)) out.push(`(5) ${n.id} holds a write of the node with the fast clock at ${parseAddress(key).table}`);
    else if (c.stamp.wall > limit + 0) out.push(`(5) ${n.id} holds a stamp from the future at ${parseAddress(key).table}`);
  }
  return out;
}

/** The rules of §4 over the converged data: the same with the input in any order, no further fix after the fix, and the rule's own promise. */
export function checkRules(w: StampedWorld, rng: Rng): string[] {
  const out: string[] = [];
  const s = w.honest[0]?.store;
  if (!s) return out;
  const shuffled = <T,>(xs: readonly T[]): T[] => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = rng.int(i + 1); [a[i], a[j]] = [a[j]!, a[i]!]; } return a; };
  const same = (label: string, f: (xs: never) => unknown, xs: readonly unknown[]) => {
    if (JSON.stringify(f(xs as never), replacer) !== JSON.stringify(f(shuffled(xs) as never), replacer)) out.push(`${label}: the answer depends on the order of the rows`);
  };
  // 4.2 / 4.8 names
  const tags = tagsOf(s), views = viewsOf(s);
  same("(6) 4.2", resolveTagNames as never, tags); same("(6) 4.8", resolveViewNames as never, views);
  for (const [label, items, resolve] of [["4.2", tags.map((t) => ({ ...t, owner: t.parent ?? "" })), (xs: typeof tags) => resolveTagNames(xs)], ["4.8", views, (xs: typeof views) => resolveViewNames(xs)]] as const) {
    const r = (resolve as (x: never) => ReturnType<typeof resolveTagNames>)(items as never);
    const after = items.map((i) => ({ ...i, name: r.shown.get(i.id) ?? i.name }));
    const scope = (i: { parent?: string | null; owner?: string }) => (i.parent ?? i.owner ?? "");
    const seen = new Set<string>();
    for (const i of after) { const k = `${scope(i)}\u0000${i.name.normalize("NFC")}`; if (seen.has(k)) out.push(`(6) ${label}: two items still share a name after the fix`); seen.add(k); }
    if ((resolve as (x: never) => ReturnType<typeof resolveTagNames>)(after as never).clashes.length) out.push(`(6) ${label}: another fix is needed after the fix`);
    for (const c of r.clashes) {
      const group = items.filter((i) => c.keeper === i.id || c.others.includes(i.id));
      const earliest = [...group].sort((a, b) => compareStamps(a.created, b.created) || (a.id < b.id ? -1 : 1))[0]!.id;
      if (earliest !== c.keeper) out.push(`(6) ${label}: the name was not left with the earliest`);
    }
  }
  // 4.3 slugs
  const slugs = slugsOf(s);
  same("(6) 4.3", resolveSlugs as never, slugs);
  { const r = resolveSlugs(slugs); const names = slugs.map((x) => r.shown.get(x.id) ?? x.slug); if (new Set(names).size !== names.length) out.push("(6) 4.3: two pages still share a slug");
    for (const c of r.clashes) {
      const group = slugs.filter((x) => x.id === c.keeper || c.others.includes(x.id)), published = group.filter((x) => x.published);
      const want = (published.length ? published.sort((x, y) => compareStamps(x.published!, y.published!)) : [...group].sort((x, y) => compareStamps(x.created, y.created) || (x.id < y.id ? -1 : 1)))[0]!;
      if (want.id !== c.keeper) out.push("(6) 4.3: the address was not left with the page that was published first (or made first)");
    } }
  // 4.4 focus
  const focus = focusOf(s);
  same("(6) 4.4", resolveRunningFocus as never, focus);
  { const fixes = new Map(resolveRunningFocus(focus).map((f) => [f.id, f.endedAt])); const after = focus.map((f) => ({ ...f, endedAt: fixes.get(f.id) ?? f.endedAt }));
    if (resolveRunningFocus(after).length) out.push("(6) 4.4: two sessions are still running after the fix");
    for (const f of resolveRunningFocus(focus)) if (f.endedAt < focus.find((x) => x.id === f.id)!.startedAt) out.push("(6) 4.4: a session ends before it began"); }
  // 4.9
  const tree = treeOf(s);
  same("(6) 4.9b", ((xs: typeof tree) => trashOrphanedChildren(xs)) as never, tree);
  { const r = trashOrphanedChildren(tree); const fixed = new Set(r.fixes.map((f) => f.note));
    const after = tree.map((n) => (fixed.has(n.id) ? { ...n, deleted: tree.find((t) => t.id === r.fixes.find((f) => f.note === n.id)!.trashedWith)!.deleted } : n));
    if (trashOrphanedChildren(after).fixes.length) out.push("(6) 4.9b: a child is still outside the trash after the fix");
    for (const n of r.notices) if (n.to === tree.find((t) => t.id === n.note)!.created.author && tree.some((t) => t.deleted?.stamp.author === n.to && r.fixes.some((f) => f.note === n.note && f.trashedWith === t.id))) out.push("(6) 4.9b: a person was told about their own deletion"); }
  same("(6) 4.9a", noticesForEditedDeletes as never, editsOf(s));
  same("(6) 4.9c", recoverLateEdits as never, purgedOf(s));
  for (const p of purgedOf(s)) if (p.purged) {
    const copies = recoverLateEdits([p]);
    for (const wr of p.writes) if (wr.stamp.author !== null && wr.stamp.seq > (p.purged.seen[wr.stamp.origin] ?? -1) && !copies.some((c) => c.to === wr.stamp.author && c.fields.some((f) => stampKey(f.stamp) === stampKey(wr.stamp) && f.field === wr.field))) out.push("(3) 4.9c: a late edit to a deleted note has no recovery copy");
  }
  // 4.10
  const links = linksOf(s);
  same("(6) 4.10", resolveMoveCycles as never, links);
  { const r = resolveMoveCycles(links);
    for (const start of r.parents.keys()) { const seen = new Set<string>(); for (let n: string | null | undefined = start; n; n = r.parents.get(n)) { if (seen.has(n)) { out.push("(6) 4.10: a loop is left after the fix"); break; } seen.add(n); } }
    for (const f of r.fixes) if (!links.find((l) => l.note === f.note)) out.push("(6) 4.10: fixed a note that is not there"); }
  // function_refs
  const refs = refsOf(s);
  same("(6) refs", mergeDuplicateRefs as never, refs);
  for (const g of mergeDuplicateRefs(refs)) { const ids = [g.keepId, ...g.dropIds]; const rows = refs.filter((r) => ids.includes(r.id)); if (rows.length !== ids.length) out.push("(6) refs: a row is missing");
    if (compareStamps(rows.find((r) => r.id === g.keepId)!.created, rows.find((r) => r.id === g.dropIds[0])!.created) > 0) out.push("(6) refs: the kept row is not the earliest");
    for (const r of rows) for (const [k, u] of Object.entries(r.config)) for (const c of u) {
      const m = g.config[k]!;
      if (![m.winner, ...m.conflicts].some((h) => stampKey(h.stamp) === stampKey(c.stamp)) && !sameContent(m.winner, c)) out.push("(3) refs: a config write of a row that was folded in is neither the winner nor kept as a conflict");
    } }
  // 4.12 bodies
  for (const { row } of rowKeys(s, NOTE)) {
    const u = effectiveUnit(s, { table: NOTE, row, field: "body" });
    if (!u || u.length < 2) continue;
    const res = resolveBody(u, BASE_BODY, mergeBody);
    const text = res.kind === "single" ? res.text : res.text, offered = "offered" in res ? res.offered.map((c) => String(c.value)).join("\n") : "";
    for (const c of u) for (const line of String(c.value).split("\n")) if (/加的句子|改寫/.test(line) && !(text + "\n" + offered).includes(line)) out.push("(3) 4.12: a line one writer added is neither in the body nor offered back");
  }
  return out;
}
/** How often each rule had something to do in this run: the adversarial scenarios must make this happen, or they prove nothing. */
export function ruleActivity(w: StampedWorld): Record<string, number> {
  const s = w.honest[0]!.store;
  const heads = (field: string) => rowKeys(s, NOTE).filter(({ row }) => (effectiveUnit(s, { table: NOTE, row, field })?.length ?? 0) > 1).length;
  const tree = treeOf(s), purged = purgedOf(s);
  const orphan = trashOrphanedChildren(tree);
  return {
    "4.2 same-name tags": resolveTagNames(tagsOf(s)).clashes.length,
    "4.8 same-name views": resolveViewNames(viewsOf(s)).clashes.length,
    "4.3 same slug": resolveSlugs(slugsOf(s)).clashes.length,
    "4.4 running focus": resolveRunningFocus(focusOf(s)).length,
    "4.9a edit after delete": noticesForEditedDeletes(editsOf(s)).length,
    "4.9b orphan child": orphan.fixes.length,
    "4.9c late edit of purged": recoverLateEdits(purged).length,
    "4.10 move cycle": resolveMoveCycles(linksOf(s)).fixes.length,
    "function_refs twice": mergeDuplicateRefs(refsOf(s)).length,
    "4.11 field conflicts": [...s.keys()].filter((k) => conflictsOf(s.get(k)!).length > 0).length,
    "4.12 body on both sides": heads("body"),
    "genesis values that differ": [...s.keys()].filter((k) => (s.get(k) ?? []).some(isGenesis) && (s.get(k) ?? []).length > 1).length, // a value from before stamps left as a conflict, beside another genesis value or a write that never saw it
    "system writes beside a conflict": w.systemBlocked,
    "4.5 same id made twice": rowKeys(s, NOTE).filter(({ row }) => (rowOf(s, NOTE, row).star?.length ?? 0) > 1).length,
  };
}
const replacer = (_: string, v: unknown) => (v instanceof Map ? [...v].sort(([a], [b]) => (String(a) < String(b) ? -1 : 1)) : v);

export type Checks = "genesis" | "system" | "oracle" | "convergence" | "orderFree" | "algebra" | "noLoss" | "causality" | "skew" | "rules";
export function checkAll(w: StampedWorld, seed: number, which: Checks[] = ["convergence", "oracle", "genesis", "system", "orderFree", "algebra", "noLoss", "causality", "skew", "rules"]): string[] {
  const rng = makeRng(seed ^ 0x51ed270b);
  const out: string[] = [];
  if (which.includes("convergence")) out.push(...checkConvergence(w));
  if (which.includes("oracle")) out.push(...checkAgainstOracle(w));
  if (which.includes("genesis")) out.push(...checkGenesisValues(w));
  if (which.includes("system")) out.push(...checkSystemLeavesConflicts(w));
  if (which.includes("orderFree")) out.push(...checkOrderFree(w, rng));
  if (which.includes("algebra")) out.push(...checkAlgebra(w, rng));
  if (which.includes("noLoss")) out.push(...checkNoLoss(w));
  if (which.includes("causality")) out.push(...checkCausality(w));
  if (which.includes("skew")) out.push(...checkSkew(w));
  if (which.includes("rules")) out.push(...checkRules(w, rng));
  return out;
}

/** Cut a failing step list down (halves, then one by one) and say what is left, as structure. */
export async function shrinkFailing(seed: number, steps: Step[], o: RunOptions, which?: Checks[]): Promise<{ steps: Step[]; failures: string[] }> {
  const fails = (xs: Step[]) => checkAll(runStampedSim(seed, xs, o), seed, which).length > 0;
  const smallest = await shrinkList(steps, fails, 200);
  return { steps: smallest, failures: checkAll(runStampedSim(seed, smallest, o), seed, which) };
}
export const describe = (steps: readonly Step[]): string => steps.map((s) => (s.t === "op" ? `n${s.node}:${s.kind}` : s.t === "deliver" ? `deliver${s.n}` : s.t === "gossip" ? `gossip${s.a}-${s.b}` : `tick${s.ms}`)).join(" ");
