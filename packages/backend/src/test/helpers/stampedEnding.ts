// The ending every test of bundles has (docs/agents/mistakes.md, the two 2026-11-19 entries on "one more exchange round" and "a full resend"; issue #1976).
//
// Every test that exchanges bundles through the helpers of stampedBundleWorld.ts (`bundleFor`, `exchange`, `take`, `resendAll`) is recorded here: which peers took part
// and which exchanged with which. Before the first of those peers' nodes is closed (or, when none is, when the test is finished), the peers that exchanged with each other
// (one group per set of connected peers: a test that builds several worlds ends each) admit each other both ways, are brought to quiet, and then:
//   1. one more exchange round between every pair that exchanged in the test (both directions) stores nothing and is refused nowhere,
//   2. everything each one holds, sent again along those pairs as if the receiver held nothing (`resendAll`), stores nothing and is refused nowhere,
//   3. the stamps (with saw, meta and kept values), the other heads (with their values) and the value of every unit of every row are the same on every node, in the
//      owner's scope (`sameUnits`). Not whole rows: a row also has columns that are not units and are this node's own or worked out later on purpose (an anchor's
//      `moved_how`／`moved_at`, a paragraph row's `label`／`text_cache`, `updated_at` of the tables other than notes: spine/stampedMerge/README.md); a test about those compares them itself.
// No test opts in: a test is left out only by ENDING_EXCEPTIONS (stampedEndingExceptions.ts), with its reason; one pinned as `fails` must still fail its ending.
//
// When: a node closed inside the test body (a test that closes its nodes in `finally`, or each world of a loop) ends the group there; a node closed by an `afterEach`
// hook (the test already passed) is closed only after the ending, which runs in the test's onTestFinished with its own long timeout (an afterEach hook has 10 s locally).
// A test that failed has no ending (its nodes are closed at once). Errors of the ending fail the test from onTestFinished (the closes swallow theirs: `.catch(() => undefined)`).
// Outside a vitest test (the worker processes of the two-process tests) nothing is recorded.
import { basename } from "node:path";
import type { RealNode } from "./distSim/realNode.js";
import { q } from "../../db.js";
import { UNIT_SOURCES, quote, rowMatchOf, unitTextsSql } from "../../spine/stampedMerge/dbUnits.js";
import { onNode } from "./distSim/realNode.js";
import { admit, bundleFor, peerStateOf, resendAll, take, type Peer } from "./stampedBundleWorld.js";
import type { StampRow } from "./stampedWorld.js";
import { SNAPSHOT_SPECS } from "../../spine/snapshotTables.js";
import { snapshotScopeFor } from "../../services/readPolicy.js";
import { withActorReadSnapshot } from "../../services/actorReadSnapshot.js";
import { ENDING_EXCEPTIONS } from "./stampedEndingExceptions.js";

type Test = { name: string; suite?: { name: string; suite?: unknown } | undefined; file?: { name: string }; result?: { state?: string } };
type Record_ = { test: Test; name: string; peers: Peer[]; links: Map<Peer, Set<Peer>>; error: unknown; ended: Set<Peer>; deferred: (() => Promise<void>)[] };

let current: Record_ | null = null;
let ending = false;
const patched = new WeakSet<RealNode>();
/** How many groups were ended (the negative control reads it). */
export let groupsEnded = 0;

/** Quiet within this many rounds, or the ending fails: a merge that does not settle is a finding of its own. */
const SETTLE_ROUNDS = 6;

async function currentTest(): Promise<Test | null> {
  if (!("__vitest_worker__" in globalThis)) return null;
  const { getCurrentTest } = await import("vitest/suite");
  return (getCurrentTest() as unknown as Test | undefined) ?? null;
}

/** "file > describe > … > test", the key of ENDING_EXCEPTIONS. */
function fullName(test: Test): string {
  const parts = [test.name];
  for (let s = test.suite as { name: string; suite?: unknown } | undefined; s && s.name; s = s.suite as typeof s) parts.unshift(s.name);
  return [basename(test.file?.name ?? "?"), ...parts].join(" > ");
}

/** Called by the helpers: `from` (null when the bundle was made by hand) sent `to` a bundle in the running test. */
export async function exchanged(from: Peer | null, to: Peer): Promise<void> {
  if (ending) return;
  const test = await currentTest();
  if (!test) return;
  if (current?.test !== test) {
    current = { test, name: fullName(test), peers: [], links: new Map(), error: null, ended: new Set(), deferred: [] };
    const rec = current;
    const { onTestFinished } = await import("vitest");
    onTestFinished(async () => finish(rec), 900_000);
  }
  for (const p of from ? [from, to] : [to]) {
    if (!current.peers.includes(p)) { current.peers.push(p); current.links.set(p, new Set()); }
    if (p.node) patchClose(p.node);
  }
  if (from && from !== to) { current.links.get(from)!.add(to); current.links.get(to)!.add(from); }
}

function patchClose(node: RealNode): void {
  if (patched.has(node)) return;
  patched.add(node);
  const close = node.close.bind(node);
  node.close = async () => {
    const rec = current;
    if (!rec || rec.error || !groupOf(rec, node).length) return close();
    const state = rec.test.result?.state;
    if (state === "fail") return close();
    if (state === "run") { await endGroups(rec, node); return close(); } // inside the test body: the group ends here, the test's own timeout applies
    rec.deferred.push(close); // an afterEach hook of a test that passed: after the ending, in onTestFinished
  };
}

/** The peers connected to `start` (by exchanges of this test) that have not ended yet. */
function groupFrom(rec: Record_, start: Peer): Peer[] {
  const seen = new Set<Peer>([start]);
  for (const queue = [start]; queue.length;) for (const q of rec.links.get(queue.shift()!)!) if (!seen.has(q)) { seen.add(q); queue.push(q); }
  return rec.peers.filter((p) => seen.has(p) && !rec.ended.has(p));
}
const groupOf = (rec: Record_, node: RealNode): Peer[] => {
  const start = rec.peers.find((p) => p.node === node && !rec.ended.has(p));
  return start ? groupFrom(rec, start) : [];
};

/** End the group of `node`, or (null) every group not ended yet. */
async function endGroups(rec: Record_, node: RealNode | null): Promise<void> {
  const groups: Peer[][] = [];
  if (node) groups.push(groupOf(rec, node));
  else for (const p of rec.peers) if (!rec.ended.has(p) && !groups.some((g) => g.includes(p))) groups.push(groupFrom(rec, p));
  for (const g of groups) {
    for (const p of g) rec.ended.add(p);
    if (g.length < 2 || rec.error) continue;
    const exception = ENDING_EXCEPTIONS[rec.name];
    if (exception?.ending === "skipped") continue;
    try {
      await endExchange(g, g.flatMap((x) => [...rec.links.get(x)!].filter((y) => g.includes(y)).map((y) => [x, y] as const)));
      if (exception?.ending === "fails") rec.error = new Error(`the ending of "${rec.name}" passes now: take it out of ENDING_EXCEPTIONS (stampedEndingExceptions.ts) and its README line`);
    } catch (e) {
      if (exception?.ending !== "fails") rec.error = e;
    }
  }
}

async function finish(rec: Record_): Promise<void> {
  try {
    if (rec.test.result?.state !== "fail") await endGroups(rec, null);
  } finally {
    for (const close of rec.deferred.splice(0)) await close().catch(() => undefined);
    if (current === rec) current = null;
  }
  if (rec.error && rec.test.result?.state !== "fail") {
    const e = rec.error as Error;
    throw new Error(`the ending (one more exchange round and a full resend, helpers/stampedEnding.ts) failed: ${e.message}`, { cause: e });
  }
}

/** The ending itself, for `peers` connected by `pairs` (both directions of every pair that exchanged in the test: a star exchanges with its centre only; default every
 *  pair): throws what it found. Exported for the negative control. */
export async function endExchange(peers: Peer[], pairs: (readonly [Peer, Peer])[] = peers.flatMap((x) => peers.filter((y) => y !== x).map((y) => [x, y] as const))): Promise<void> {
  ending = true;
  try {
    const step = async (what: string, send: (x: Peer, y: Peer) => Promise<{ stored: number }>): Promise<number> => {
      let stored = 0;
      for (const [x, y] of pairs) {
        try { stored += (await send(x, y)).stored; } catch (e) { throw new Error(`${what}: ${x.name} → ${y.name} refused (${(e as { code?: string }).code ?? (e as Error).message})`, { cause: e }); }
      }
      return stored;
    };
    // the pairing step, both ways (a node that joined from another's snapshot sends to it only once that one admitted it; a test of one direction often leaves it out).
    // Admitting again changes nothing (spine/stampedImport.ts admitSyncNode)
    for (const [x, y] of pairs) await admit(y, x);
    const exchangeOnce = (x: Peer, y: Peer) => bundleFor(x, y).then((b) => take(y, b));
    let rounds = 0;
    while ((await step("settling", exchangeOnce)) > 0) if (++rounds >= SETTLE_ROUNDS) throw new Error(`still storing after ${SETTLE_ROUNDS} rounds`);
    const again = await step("one more round", exchangeOnce);
    if (again) throw new Error(`one more exchange round stored ${again}`);
    const resent = await step("full resend", resendAll);
    if (resent) throw new Error(`sending everything again stored ${resent}`);
    const first = await sameUnits(peers[0]!);
    for (const p of peers.slice(1)) {
      const other = await sameUnits(p);
      for (const what of ["stamps", "heads", "values"] as const) {
        const [x, y] = [new Set(first[what]), new Set(other[what])];
        const onlyFirst = first[what].filter((v) => !y.has(v)).slice(0, 3), onlyOther = other[what].filter((v) => !x.has(v)).slice(0, 3);
        if (onlyFirst.length || onlyOther.length) {
          // and, for stamps, everything each node holds of those rows: what the row looks like on both sides
          const rowsNamed = new Set([...onlyFirst, ...onlyOther].map((v) => { try { return String((JSON.parse(v) as { row_key?: string }).row_key); } catch { return ""; } }));
          const ofRows = (xs: string[]) => xs.filter((v) => [...rowsNamed].some((r) => r && v.includes(`"row_key":${JSON.stringify(r)}`))).slice(0, 8);
          const around = what === "stamps" ? ` — of those rows ${peers[0]!.name} holds ${JSON.stringify(ofRows(first.stamps))}, ${p.name} holds ${JSON.stringify(ofRows(other.stamps))}` : "";
          throw new Error(`after the ending ${peers[0]!.name} and ${p.name} hold different ${what}: only ${peers[0]!.name} ${JSON.stringify(onlyFirst)}, only ${p.name} ${JSON.stringify(onlyOther)}${around}`);
        }
      }
    }
    groupsEnded++;
  } finally {
    ending = false;
  }
}

/** What must be the same on every node after the ending, as sorted texts: the stamps and other heads of the carried labels (peerStateOf), and every unit's value of every
 *  row by the engine's own reading of it (dbUnits.ts unitTextsSql, the texts the stamps name values by), all in the owner's scope. */
async function sameUnits(p: Peer): Promise<{ stamps: string[]; heads: string[]; values: string[] }> {
  const state = await peerStateOf(p);
  // read as the digest is read (helpers/stampedWorld.ts digestAs): the owner's scope at that moment, inside its read snapshot
  const values = await onNode(p.node, () => withActorReadSnapshot(p.owner, p.ws, async (actor) => {
    const scopeOf = await snapshotScopeFor(actor);
    const out: string[] = [];
    for (const src of UNIT_SOURCES) {
      // the rows a snapshot of the owner carries (what the digest is made of): not the rows a node derives for itself (links worked out from the text), not rows out of the owner's scope
      const spec = SNAPSHOT_SPECS.find((s) => s.table === src.table);
      if (!spec) continue;
      const m = rowMatchOf(src, []), params: unknown[] = [p.ws];
      const rows = (await q<{ k: string; v: string }>(`SELECT ${m.idSql("t")} AS k, (${unitTextsSql(src, "t")})::text AS v FROM ${quote(src.table)} t WHERE ${spec.where(scopeOf(params))}`, params)).rows;
      for (const r of rows) out.push(`${src.label} ${r.k} ${r.v}`);
    }
    return out.sort();
  }));
  const texts = (xs: unknown) => (xs as unknown[]).map((x) => JSON.stringify(x)).sort();
  return { stamps: texts(withoutCopiesOfCreation(state.stamps as StampRow[])), heads: texts(state.heads), values };
}

/** The running test ran the ending itself (endExchange) on every peer it exchanged with: nothing more is run after it (the negative control, whose nodes are left
 *  different on purpose). */
export function endedByTheTest(): void {
  if (current) for (const p of current.peers) current.ended.add(p);
}

/**
 * The one known difference the ending sets aside (pinned by its own test, stampedFieldCopyOfCreation.integration.test.ts, and README 「接上傳輸前必須完成」): a FIELD stamp
 * that is a copy of its row's creation stamp (`*`: the same origin, number, clock, author, device, saw and meta; the field was written in the transaction that made the row).
 * It says nothing the creation does not (a field without a stamp of its own follows `*`), and which node keeps such a copy depends on the order of the writes in that
 * transaction, so it lands on whichever test of a file happens to run the exchange first: no per-test pin can hold it. Dropped on every node before comparing, and only that.
 */
function withoutCopiesOfCreation(stamps: StampRow[]): StampRow[] {
  const sameAs = (a: StampRow, b: StampRow) => a.origin === b.origin && a.seq === b.seq && a.hlc_wall === b.hlc_wall && a.hlc_counter === b.hlc_counter && a.author === b.author
    && a.device === b.device && a.deleted === b.deleted && JSON.stringify(a.saw) === JSON.stringify(b.saw) && JSON.stringify(a.meta) === JSON.stringify(b.meta);
  const creation = new Map(stamps.filter((x) => x.field === "*").map((x) => [`${x.table_name} ${x.row_key}`, x] as const));
  return stamps.filter((x) => { const c = creation.get(`${x.table_name} ${x.row_key}`); return x.field === "*" || !c || !sameAs(x, c); });
}

/** The error the ending of the running test found so far, taken (the negative control asserts it instead of failing). */
export function takeEndingError(): unknown {
  const e = current?.error ?? null;
  if (current) current.error = null;
  return e;
}
