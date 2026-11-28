// The ending every test of bundles and snapshots has (docs/agents/mistakes.md, the two 2026-11-19 entries on "one more exchange round" and "a full resend"; issue #1976).
//
// WHAT IS RECORDED. Every call a test makes into the engine's receiving side, by any route (the helpers of stampedBundleWorld.ts, a direct call, a service): a bundle taken
// (spine/stampedImport.ts applyChangeBundle), a join finished (beginJoin … markJoinDone), units merged by hand (mergeUnitsIntoWorkspace). The setup file
// test/stampedEndingSetup.ts wraps those exports for every test file (vitest.config.ts setupFiles) and calls `engineCall` here; nothing is opted into per file. Each call
// records the receiving node (helpers/distSim/realNode.ts currentNode), the workspace, the sending node's id (a bundle's sender, a join's source; none for units), whether it
// was taken, what it stored, and what the sender said it holds of itself.
//
// WHO ENDS. At the end, a taken call links its receiver to its sender when the sender is a node open in this process; each set of linked nodes is a group (a test that builds
// several worlds has several). A taken call whose sender is no node of the test (units merged by hand, a bundle signed by a node id nobody has) cannot be ended: the test then
// fails unless it is in ENDING_SKIPPED with its reason. So "every test that takes a bundle or a snapshot has the ending or a named reason" is checked by what ran, not by a list.
// A test whose every call was refused took nothing and has nothing to end. Exchanges in another process (the two-process tests) are reported by their workers through
// ONDEN_ENDING_MARKS (stampedEndingSetup.ts) and need an entry too.
//
// THE ENDING, per group, over every pair that exchanged in the test, both directions:
//   0. the pairing step for a direction the test never sent in (a node that joined from another's snapshot is admitted by it): `admit`. A direction the test did send in
//      is never admitted here (a refusal there is the test's own and fails the ending);
//   1. if the test's own last exchange on every one of those directions stored nothing and nobody wrote since (the sender says it holds of itself what it said then), the
//      test claimed quiet: the first round must store nothing. Otherwise the group is exchanged until nothing is stored (at most SETTLE_ROUNDS, or it fails);
//   2. one more round: nothing stored, nothing refused;
//   3. a full resend (`resendAll`, the receiver as if it held nothing): nothing stored, nothing refused;
//   4. every node's own state did not change through 2 and 3 (`fingerprint`: every table of the workspace, the stamps and heads too, before and after; not what the engine
//      reports), and the stamps (saw, meta, kept values), the other heads (values) and every unit's value are the same on every node, in the owner's scope (`sameUnits`).
//      Not whole rows across nodes: some columns are no unit and are each node's own or worked out later on purpose (README).
// A test is left out only by ENDING_SKIPPED (meant to stay different: say why) or pinned by ENDING_FAILS (a finding with a README line: its ending must still fail) in
// stampedEndingExceptions.ts, two lists that each only shrink.
//
// WHEN. In the test body (in `finally`, or one world of a loop), a group ends when the LAST of its nodes is closed; a node of it closed earlier stays open till then
// (the others go on: an ending run then would change them under the test). A node closed by an `afterEach` (the test passed) is closed after the ending, which runs in
// the test's onTestFinished with its own timeout (an afterEach hook has 10 s locally). A failed test has no ending. Errors fail the test from onTestFinished (the closes
// swallow theirs).
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
import { q } from "../../db.js";
import type { ChangeBundle } from "../../spine/snapshotSql.js";
import { UNIT_SOURCES, labelsOf, quote, rowMatchOf, unitTextsSql } from "../../spine/stampedMerge/dbUnits.js";
import { SNAPSHOT_SPECS, wholeWorkspace } from "../../spine/snapshotTables.js";
import { localNodeId } from "../../spine/stamps.js";
import { snapshotScopeFor } from "../../services/readPolicy.js";
import { withActorReadSnapshot } from "../../services/actorReadSnapshot.js";
import type { ActorCtx } from "../../types.js";
import { RealNode, currentNode, onNode } from "./distSim/realNode.js";
import { admit, bundleFor, peerStateOf, resendAll, take, type Peer } from "./stampedBundleWorld.js";
import { makeCaller } from "./stampedWorld.js";
import { ENDING_FAILS, ENDING_LONG_SETTLE, ENDING_SKIPPED } from "./stampedEndingExceptions.js";
import { exceptionEntryFor, fullName, type Difference, type Test } from "./stampedEndingNames.js";

type Kind = "bundle" | "join" | "units";
/** One call into the receiving side. `sender`: the sending node's id (null: units merged by hand). `senderHolds`: what a bundle's sender said it holds of itself. */
type Event = { kind: Kind; ws: string; receiver: RealNode | null; sender: string | null; taken: boolean; stored: number; senderHolds: string | null; consumed: boolean; from?: Peer; to?: Peer };
/** `pinned`: of a test in ENDING_FAILS, how many of its groups were ended and whether any found the finding. The finding is judged over every group of the test, once
 *  every group of it is ended (endGroups): a clean group of a test whose other group holds the finding is no "passes now". */
type Record_ = { test: Test; name: string; named: Peer[]; events: Event[]; error: unknown; deferred: Map<RealNode, () => Promise<void>>; settled: number[]; pinned: { ended: number; found: boolean } };

(globalThis as { __ondenEndingLoaded?: boolean }).__ondenEndingLoaded = true; // test/stampedEndingSetup.ts: this file reached the engine
let current: Record_ | null = null;
let ending = false;
const patched = new WeakSet<RealNode>();
/** How many groups were ended (the negative control reads it). */
export let groupsEnded = 0;
/** Quiet within this many rounds, or the ending fails: a merge that does not settle is a finding of its own. Fewer than that is checked too (`allowedRounds`). */
const SETTLE_ROUNDS = 6;
/** The names of the tests whose ending failed as their ENDING_FAILS entry says (test/stampedEndingSetup.ts reads it: a pinned test whose ending never ran is red). */
const pinnedFailed = ((globalThis as { __ondenPinnedFailed?: Set<string> }).__ondenPinnedFailed ??= new Set<string>());
/** The names of the skipped tests that still needed it (their ending found something, could not go on, or had nothing to end with): stampedEndingSetup.ts reads it. */
const skippedNeeded = ((globalThis as { __ondenSkippedNeeded?: Set<string> }).__ondenSkippedNeeded ??= new Set<string>());

async function currentTest(): Promise<Test | null> {
  if (!("__vitest_worker__" in globalThis)) return null;
  const { getCurrentTest } = await import("vitest/suite");
  return (getCurrentTest() as unknown as Test | undefined) ?? null;
}

export { fullName, exceptionEntryFor };

/** Calls made outside every test (a file's beforeAll): one record for the file, ended by the setup file's afterAll (`finishFile`). Its name is "<file> > (outside a test)". */
let fileRecord: Record_ | null = null;
const OUTSIDE = "(outside a test)";

async function recordFor(): Promise<Record_ | null> {
  if (ending) return null;
  const test = await currentTest();
  if (!test) {
    const file = (globalThis as { __vitest_worker__?: { filepath?: string } }).__vitest_worker__?.filepath;
    if (!file) return null;
    fileRecord ??= { test: { name: OUTSIDE, file: { name: file }, result: { state: "outside" } }, name: `${basename(file)} > ${OUTSIDE}`, named: [], events: [], error: null, deferred: new Map(), settled: [], pinned: { ended: 0, found: false } };
    for (const node of RealNode.openNodes()) patchClose(node);
    return fileRecord;
  }
  if (current?.test !== test) {
    current = { test, name: fullName(test), named: [], events: [], error: null, deferred: new Map(), settled: [], pinned: { ended: 0, found: false } };
    const rec = current;
    const { onTestFinished } = await import("vitest");
    onTestFinished(async () => finish(rec), 900_000);
  }
  for (const node of RealNode.openNodes()) patchClose(node);
  return current;
}

/** Called by test/stampedEndingSetup.ts after a file's last test: the calls its beforeAll made are ended (then the nodes it closed meanwhile are closed). */
export async function finishFile(): Promise<void> {
  const rec = fileRecord;
  fileRecord = null;
  // no test comes after: the file's shared nodes are ended themselves, not copies of them
  (globalThis as { __ondenFirstNodeOfTest?: number }).__ondenFirstNodeOfTest = 0;
  if (rec) await finish(rec);
}

/** In a process that is no vitest test (a two-process test's worker), an exchange is reported to the test that started it (test/stampedEndingSetup.ts). */
export function markIfOtherProcess(kind: "bundle" | "join"): void {
  const file = process.env.ONDEN_ENDING_MARKS;
  if (file && !("__vitest_worker__" in globalThis)) appendFileSync(file, `${kind}\n`);
}

/** Every peer stampedBundleWorld.ts's `peerOf` made, by its node (a node is opened by one test, so its peers are that test's). */
const PEERS_OF = new WeakMap<RealNode, Peer[]>();
export function knownPeer(p: Peer): void {
  if (p.node) PEERS_OF.set(p.node, [...(PEERS_OF.get(p.node) ?? []), p]);
}

/** Called by the helpers of stampedBundleWorld.ts with the peers they know by name (the ending then uses those names and owners). */
export async function exchanged(from: Peer | null, to: Peer): Promise<void> {
  const rec = await recordFor();
  if (!rec) return;
  for (const p of from ? [from, to] : [to]) if (!rec.named.includes(p)) rec.named.push(p);
}

/** Called by test/stampedEndingSetup.ts around the engine's receiving calls. */
export async function engineCall<T>(kind: Kind, ws: string, sender: string | null, bundle: ChangeBundle | null, run: () => Promise<T>): Promise<T> {
  const rec = await recordFor();
  if (!rec) return run();
  const event: Event = { kind, ws, receiver: currentNode(), sender, taken: false, stored: 0, senderHolds: bundle ? holdsOf(bundle) : null, consumed: false };
  rec.events.push(event);
  const result = await run();
  event.taken = true;
  event.stored = Number((result as { stored?: number } | undefined)?.stored ?? 0);
  return result;
}

const joining = new Map<RealNode | null, Map<string, string>>();
/** Called by test/stampedEndingSetup.ts when a join starts: where the snapshot came from (the join is recorded when it finishes, `engineCall("join")`). */
export function joinStarted(ws: string, source: string): void {
  const n = currentNode();
  if (!joining.has(n)) joining.set(n, new Map());
  joining.get(n)!.set(ws, source);
}
/** The source of the join of `ws` on the running node, as `joinStarted` heard it. */
export const joinSource = (ws: string): string | null => joining.get(currentNode())?.get(ws) ?? null;

/** What a bundle's sender says it holds of its own writes, label by label: equal for two bundles of one sender when it wrote nothing in between. */
function holdsOf(bundle: ChangeBundle): string {
  const own = Object.entries(bundle.holds ?? {}).map(([label, of]) => [label, (of as Record<string, number>)[bundle.sender] ?? 0] as const);
  return JSON.stringify(own.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function patchClose(node: RealNode): void {
  if (patched.has(node)) return;
  patched.add(node);
  const close = node.close.bind(node);
  node.close = async () => {
    const live = (r: Record_ | null) => r && r.events.some((e) => e.taken && !e.consumed) ? r : null;
    const rec = live(current) ?? live(fileRecord);
    if (!rec || rec.error || rec.test.result?.state === "fail") return close();
    rec.deferred.set(node, close);
    // an afterEach hook of a test that passed: everything waits for the ending, in onTestFinished
    if (rec.test.result?.state !== "run") return;
    // in the test body: the group ends when the last of its nodes is closed (a node closed earlier stays open till then: the others go on, and an ending run now would
    // change them under the test), and then its nodes are closed
    const group = (await groupsOf(rec)).groups.find((g) => g.peers.some((p) => p.node === node));
    if (!group) { rec.deferred.delete(node); return close(); }
    if (group.peers.some((p) => p.node === null || (!rec.deferred.has(p.node) && RealNode.openNodes().includes(p.node)))) return;
    await endGroups(rec, node);
    for (const p of group.peers) { const c = p.node && rec.deferred.get(p.node); if (c) { rec.deferred.delete(p.node!); await c().catch(() => undefined); } }
  };
}

type Group = { peers: Peer[]; pairs: (readonly [Peer, Peer])[]; events: Event[] };

/** The groups of the taken, not yet ended calls, and the taken calls whose sender is no node of this process. */
async function groupsOf(rec: Record_): Promise<{ groups: Group[]; orphans: Event[] }> {
  const live = rec.events.filter((e) => !e.consumed);
  if (!live.some((e) => e.taken)) return { groups: [], orphans: [] };
  // every open node (and this process's own database when a call landed there), by its node id
  const nodes: (RealNode | null)[] = [...RealNode.openNodes(), ...(live.some((e) => e.receiver === null) ? [null] : [])];
  const byId = new Map<string, RealNode | null>();
  for (const n of nodes) byId.set(await onNode(n, () => localNodeId()), n);
  const peers = new Map<string, Peer>();
  const key = (n: RealNode | null, ws: string) => `${n ? n.name + "#" + RealNode.openNodes().indexOf(n) : "own"}|${ws}`;
  const peerOf = async (n: RealNode | null, ws: string): Promise<Peer> => {
    const k = key(n, ws);
    const named = (p: Peer) => p.ws === ws && p.node === n;
    if (!peers.has(k)) peers.set(k, rec.named.find(named) ?? (n ? PEERS_OF.get(n)?.find(named) : undefined) ?? await synthesize(n, ws, rec.named.find((p) => p.ws === ws)?.owner));
    return peers.get(k)!;
  };
  const links = new Map<Peer, Set<Peer>>();
  const orphans: Event[] = [];
  for (const e of live) {
    const senderNode = e.sender === null ? undefined : byId.get(e.sender);
    if (senderNode === undefined || (e.receiver !== null && !RealNode.openNodes().includes(e.receiver))) { if (e.taken) orphans.push(e); continue; }
    const [to, from] = [await peerOf(e.receiver, e.ws), await peerOf(senderNode, e.ws)];
    if (to === from) { if (e.taken) orphans.push(e); continue; }
    e.from = from; e.to = to;
    // only what was taken joins two nodes into a group (a refused call wrote nothing: the node it was refused on may be one nobody can read, mid-join); a refused call
    // between two nodes of a group still counts as a direction the test sent in (the ending admits nothing there)
    if (!e.taken) continue;
    for (const [x, y] of [[from, to], [to, from]] as const) { if (!links.has(x)) links.set(x, new Set()); links.get(x)!.add(y); }
  }
  const groups: Group[] = [], seen = new Set<Peer>();
  for (const start of links.keys()) {
    if (seen.has(start)) continue;
    const members = new Set<Peer>([start]);
    for (const queue = [start]; queue.length;) for (const p of links.get(queue.shift()!)!) if (!members.has(p)) { members.add(p); queue.push(p); }
    for (const p of members) seen.add(p);
    const list = [...members];
    const pairs = list.flatMap((x) => [...links.get(x)!].map((y) => [x, y] as const));
    const events = live.filter((e) => e.from && members.has(e.from) && members.has(e.to!)); // in the order they happened
    groups.push({ peers: list, pairs, events });
  }
  return { groups, orphans };
}

/** A peer for a node the helpers did not name, read as `as` (the person the test's other peers of that workspace read as), else as the workspace's owner on that node. */
async function synthesize(node: RealNode | null, ws: string, as?: ActorCtx): Promise<Peer> {
  // only a person this node has (two worlds of one test start from one template and share a workspace id, not their people)
  if (as && (await onNode(node, () => q(`SELECT 1 FROM actors WHERE id::text = $1 AND workspace_id = $2`, [as.id, ws]))).rows.length) {
    return { name: node?.name ?? "own", node, ws, owner: as, space: "", call: makeCaller(as) };
  }
  const owner = await onNode(node, async () => (await q<{ id: string; name: string }>(
    `SELECT a.id::text, a.name FROM actors a JOIN workspaces w ON w.id = a.workspace_id AND w.owner_actor_id = a.id WHERE a.workspace_id = $1`, [ws])).rows[0]);
  if (!owner) throw new Error(`the workspace on node ${node?.name ?? "(this process's own)"} has no owner to read its bundles as`);
  const actor: ActorCtx = { id: owner.id, name: owner.name, type: "human" };
  return { name: node?.name ?? "own", node, ws, owner: actor, space: "", call: makeCaller(actor) };
}

/** End the groups of `node` (or, null, every group). Then, at the end of the test, the calls that could not be ended. */
async function endGroups(rec: Record_, node: RealNode | null | undefined): Promise<void> {
  const { groups, orphans } = await groupsOf(rec);
  // calls refused between nodes that no taken call joined: nothing was taken there, nothing to end
  if (node === null) for (const e of rec.events) if (!e.taken && !groups.some((g) => g.events.includes(e))) e.consumed = true;
  const pinned = exceptionEntryFor(ENDING_FAILS, rec.name), skippedWhy = exceptionEntryFor(ENDING_SKIPPED, rec.name);
  for (const g of groups) {
    if (node !== undefined && node !== null && !g.peers.some((p) => p.node === node)) continue;
    for (const e of g.events) e.consumed = true;
    if (rec.error) continue;
    const copies: RealNode[] = [];
    try {
      // a node the file's other tests share (opened before this test began) is not changed by the ending: the ending works on a copy of it (the same database, the same id)
      const first = (globalThis as { __ondenFirstNodeOfTest?: number }).__ondenFirstNodeOfTest ?? 0;
      const peers = await Promise.all(g.peers.map(async (p) => {
        if (!p.node || p.node.serial >= first) return p;
        const copy = await RealNode.open(`${p.node.name} (copy for the ending)`, p.node);
        copies.push(copy);
        return { ...p, node: copy };
      }));
      const at = (x: Peer) => peers[g.peers.indexOf(x)]!;
      const pairs = g.pairs.map(([x, y]) => [at(x), at(y)] as const);
      const claimed = claimedQuiet(g), exercised = new Set(g.events.map((e) => direction(g.peers, e.from!, e.to!)));
      const { settleRounds, differences, resent } = await runEnding(peers, pairs, claimed, exercised);
      rec.settled.push(settleRounds);
      if (skippedWhy !== undefined) {
        // a skipped test must still need it: its ending finds something (or, below, a call of it came from no node); test/stampedEndingSetup.ts turns a skipped test
        // that needed none of it red ("take the line out"), once every group and call of it is known
        if (differences.length) skippedNeeded.add(rec.name);
        continue;
      }
      const allowed = allowedRounds(peers, pairs, resent), long = exceptionEntryFor(ENDING_LONG_SETTLE, rec.name);
      if (settleRounds > allowed && long === undefined) {
        rec.error = new Error(`the ending needed ${settleRounds} exchange rounds to settle, more than the ${allowed} a group of ${peers.length} nodes needs to deliver what was written (one pair a round, then a round that stores nothing): a merge answered its own merge. Find out why, or give the test an entry in ENDING_LONG_SETTLE (stampedEndingExceptions.ts) saying why`);
        continue;
      }
      // a pinned finding takes out the differences that are it, and nothing else: every other difference of every step and every node stays red
      const its = pinned ? differences.filter((d) => pinned.allows(d, differences)) : [];
      const others = differences.filter((d) => !its.includes(d));
      if (pinned) rec.pinned.ended++;
      if (its.length) {
        rec.pinned.found = true;
        pinnedFailed.add(rec.name);
        if (process.env.ONDEN_ENDING_LOG) appendFileSync(process.env.ONDEN_ENDING_LOG, `${rec.name}\tpinned, found as pinned: ${describeDifferences(its).replace(/\s+/g, " ").slice(0, 300)}\n`);
      }
      if (others.length) rec.error = new Error(pinned ? `the ending of "${rec.name}" is pinned in ENDING_FAILS (${pinned.why}), but it found differences that are not that finding: ${describeDifferences(others)}` : describeDifferences(others));
    } catch (e) {
      // a step that could not go on (a refusal, a group that does not settle) is no pinned finding
      if (skippedWhy !== undefined) skippedNeeded.add(rec.name);
      else rec.error = e;
    } finally {
      for (const c of copies) await c.close().catch(() => undefined);
    }
  }
  // a pinned test passes now only when NONE of its groups found the finding: judged once every group of it is ended (at the end of the test, or in its body when the
  // last of its groups was ended by a close). Judged per group, a clean group ended first (the nodeRenewal pins: the pair the test built before its restore, which
  // holds the test's first call) said "passes now", and that error kept the group that holds the finding (the restored server and the node that joined it) from
  // being ended at all
  const allEnded = node === null || !rec.events.some((e) => e.taken && !e.consumed && !orphans.includes(e));
  if (allEnded && pinned && rec.pinned.ended > 0 && !rec.pinned.found && !rec.error) {
    rec.error = new Error(`the ending of "${rec.name}" passes now: take it out of ENDING_FAILS (stampedEndingExceptions.ts) and its README line (none of its ${rec.pinned.ended} group(s) found it)`);
  }
  if (node === null && orphans.length && skippedWhy !== undefined) skippedNeeded.add(rec.name);
  if (node === null && orphans.length && skippedWhy === undefined && !rec.error) {
    rec.error = new Error(`${orphans.length} call(s) of this test were taken from no node of the test (${[...new Set(orphans.map((e) => e.kind))].join(", ")}), so nothing could end them: give the test a node to exchange with, or an entry in ENDING_SKIPPED (stampedEndingExceptions.ts) saying why`);
  }
  for (const e of orphans) e.consumed = true;
}

/** For every direction of the group, what its sender said it held of itself in the test's own last exchange, when that exchange stored nothing and no call after the first
 *  of those last exchanges stored anything; null when the test did not exchange to quiet (some direction never sent, or the last one stored something). */
function claimedQuiet(g: Group): Map<string, string> | null {
  const last = new Map<string, Event>();
  for (const e of g.events) if (e.kind === "bundle") last.set(direction(g.peers, e.from!, e.to!), e);
  const claimed = new Map<string, string>();
  for (const [x, y] of g.pairs) {
    const e = last.get(direction(g.peers, x, y));
    if (!e || !e.taken || e.stored !== 0 || e.senderHolds === null) return null;
    claimed.set(direction(g.peers, x, y), e.senderHolds);
  }
  const firstFinal = Math.min(...[...last.values()].map((e) => g.events.indexOf(e)));
  if (g.events.slice(firstFinal).some((e) => e.stored !== 0 || (e.taken && e.kind !== "bundle"))) return null;
  return claimed;
}
/** How many rounds a group may take to settle: a write crosses one pair a round, so it reaches every node within the group's widest gap (the longest of the shortest
 *  paths between two of its nodes, over the pairs that exchanged), and one more round stores nothing. Two nodes: 2. A holder's re-send (`resent`: a node took a note
 *  made again over a delete it had not seen, and sent what hangs on it again, README of spine/stampedMerge 「筆記以同一個 id 重建時」) is a write made while taking a
 *  bundle: it leaves the latest within the first wave and crosses the group in a second one, and makes no node send anything (only a creation that is not a re-send
 *  does), so a group with one takes at most twice the widest gap, and one more round. More than that is still a merge answering its own merge. */
function allowedRounds(peers: Peer[], pairs: readonly (readonly [Peer, Peer])[], resent = false): number {
  let widest = 0;
  for (const start of peers) {
    const dist = new Map<Peer, number>([[start, 0]]);
    for (const queue = [start]; queue.length;) {
      const x = queue.shift()!;
      for (const [from, to] of pairs) if (from === x && !dist.has(to)) { dist.set(to, dist.get(x)! + 1); queue.push(to); }
    }
    widest = Math.max(widest, ...dist.values());
  }
  return (resent ? 2 * widest : widest) + 1;
}

/** A direction of a group, by the peers' places in it (two peers of one group can have the same name). */
const direction = (peers: Peer[], x: Peer, y: Peer): string => `${peers.indexOf(x)}>${peers.indexOf(y)}`;

async function finish(rec: Record_): Promise<void> {
  try {
    if (rec.test.result?.state !== "fail") await endGroups(rec, null);
  } finally {
    for (const close of [...rec.deferred.values()]) await close().catch(() => undefined);
    rec.deferred.clear();
    if (current === rec) current = null;
  }
  if (rec.error && rec.test.result?.state !== "fail") {
    const e = rec.error as Error;
    // ONDEN_ENDING_LOG=<file>: one line per test whose ending failed, written when it fails (a long run that is stopped keeps what it found)
    if (process.env.ONDEN_ENDING_LOG) appendFileSync(process.env.ONDEN_ENDING_LOG, `${rec.name}\t${e.message.replace(/\s+/g, " ").slice(0, 1500)}\n`);
    throw new Error(`the ending (one more exchange round and a full resend, helpers/stampedEnding.ts) failed: ${e.message}`, { cause: e });
  }
}

/** The ending itself, for `peers` connected by `pairs` (default every pair, both ways); `claimed`: the test's own last exchanges were quiet (see `claimedQuiet`).
 *  Every step runs and every node is compared, whatever an earlier one found: what it returns is every difference (helpers/stampedEndingNames.ts `Difference`).
 *  It throws only when a step cannot go on (a refusal, a group that does not settle). */
async function runEnding(peers: Peer[], pairs: (readonly [Peer, Peer])[], claimed: Map<string, string> | null, exercised: ReadonlySet<string>): Promise<{ settleRounds: number; differences: Difference[]; resent: boolean }> {
  ending = true;
  try {
    const differences: Difference[] = [];
    let resent = false;
    const refusal = (what: string, x: Peer, y: Peer, e: unknown) => new Error(`${what}: ${x.name} → ${y.name} refused (${(e as { code?: string }).code ?? (e as Error).message})`, { cause: e });
    /** The units a take stored, as differences of `step` (a report that says more than it names: the rest without a unit). */
    const storedBy = (step: StoredStep, y: Peer, report: TakeReport): Difference[] => {
      const units = (report.events ?? []).map((e) => ({ table: e.address.table, row: e.address.row, field: e.address.field }));
      const extra = Math.max(0, report.stored - units.length);
      return report.stored ? [...units.map((unit) => ({ kind: "stored" as const, step, peer: y.name, unit })), ...Array.from({ length: extra }, () => ({ kind: "stored" as const, step, peer: y.name, unit: null }))] : [];
    };
    const step = async (what: string, send: (x: Peer, y: Peer) => Promise<TakeReport>, as: StoredStep | null): Promise<number> => {
      let stored = 0;
      for (const [x, y] of pairs) {
        let report: TakeReport;
        try { report = await send(x, y); } catch (e) { throw refusal(what, x, y, e); }
        stored += report.stored;
        if (report.resent) resent = true;
        if (as) differences.push(...storedBy(as, y, report));
      }
      return stored;
    };
    for (const [x, y] of pairs) if (!exercised.has(direction(peers, x, y))) await admit(y, x);
    const exchangeOnce = (x: Peer, y: Peer) => bundleFor(x, y).then((b) => take(y, b));
    // the first round: its bundles are read before any is taken, to see whether a sender wrote since the test's own last exchange
    const first = [] as { x: Peer; y: Peer; bundle: ChangeBundle }[];
    for (const [x, y] of pairs) first.push({ x, y, bundle: await bundleFor(x, y) });
    const stillClaimed = claimed !== null && first.every(({ x, y, bundle }) => claimed.get(direction(peers, x, y)) === holdsOf(bundle));
    let stored = 0;
    for (const { x, y, bundle } of first) {
      let report: TakeReport;
      try { report = await take(y, bundle); } catch (e) { throw refusal("settling", x, y, e); }
      stored += report.stored;
      if (report.resent) resent = true;
      if (stillClaimed) differences.push(...storedBy("claimed quiet", y, report));
    }
    // the rounds until one stores nothing, that one included (a test that left the nodes quiet: 1)
    let settleRounds = 1;
    for (; stored > 0; settleRounds++) {
      if (settleRounds >= SETTLE_ROUNDS) throw new Error(`still storing after ${SETTLE_ROUNDS} rounds`);
      stored = await step("settling", exchangeOnce, null);
    }
    const before = await Promise.all(peers.map((p) => fingerprint(p)));
    await step("one more round", exchangeOnce, "one more round");
    const middle = await Promise.all(peers.map((p) => fingerprint(p)));
    await step("full resend", resendAll, "full resend");
    const after = await Promise.all(peers.map((p) => fingerprint(p)));
    peers.forEach((p, i) => {
      nameUnnamedStores(differences, "one more round", p.name, changedRows(p.name, before[i]!, middle[i]!));
      nameUnnamedStores(differences, "full resend", p.name, changedRows(p.name, middle[i]!, after[i]!));
      // a unit a node stored in these two steps wrote its own row and that row's stamps and heads, as it said: those rows are the store above (red already, or what a
      // pin takes), not something it did not report. Only those rows: the rest of that table, sync_origins and every other row of the node are compared as on any node
      const storedHere = differences.flatMap((d) => (d.kind === "stored" && d.step !== "claimed quiet" && d.peer === p.name && d.unit ? [d.unit] : []));
      for (const d of changedRows(p.name, before[i]!, after[i]!)) if (!storedHere.some((u) => isRowOfUnit(d, u))) differences.push(d);
    });
    differences.push(...(await differencesBetween(peers)));
    groupsEnded++;
    return { settleRounds, differences, resent };
  } finally {
    ending = false;
  }
}
/** `resent`: rows the receiver sent again while taking it (a note made again over a delete it had not seen: stampedMerge/dbRows.ts resendRowsOnRemadeNotes). */
type TakeReport = { stored: number; resent?: number; events?: { address: { table: string; row: string; field: string } }[] };
type StoredStep = "claimed quiet" | "one more round" | "full resend";
/** The tables holding the stamps and other heads of a unit (`table_name` = the unit's label, `row_key` = its row). */
const STAMP_TABLES = new Set(["sync_stamps", "sync_stamp_heads"]);
/** `d` is a row a store of `unit` writes: the unit's own row (its source's table, its key as the row key text, dbUnits.ts rowKeySql), or a stamp or head of that row. */
function isRowOfUnit(d: Difference, unit: { table: string; row: string }): boolean {
  if (d.kind !== "row") return false;
  if (STAMP_TABLES.has(d.table)) return d.row.table_name === unit.table && d.row.row_key === unit.row;
  const src = UNIT_SOURCES.find((s) => labelsOf(s).includes(unit.table));
  return src !== undefined && src.table === d.table && src.key.map((k) => String(d.row[k.column])).join("/") === unit.row;
}

/** A take's report names a unit it stored only when the merge has something to say of it (dbUnits.ts / dbRows.ts `report.events`); a unit stored without that is
 *  named here by the stamps and heads of a unit's label that changed on that node in that step (`table_name`, `row_key`, `field`). Only when there are no more of
 *  them than unnamed stores: otherwise none is named (each stays a store without a unit, and the changed rows stay rows the node did not report). */
function nameUnnamedStores(differences: Difference[], step: StoredStep, peer: string, changed: readonly Difference[]): void {
  const mine = differences.filter((d): d is Extract<Difference, { kind: "stored" }> => d.kind === "stored" && d.step === step && d.peer === peer);
  const unnamed = mine.filter((d) => d.unit === null);
  if (!unnamed.length) return;
  const key = (table: unknown, row: unknown, field: unknown) => JSON.stringify([String(table), String(row), String(field)]);
  const named = new Set(mine.flatMap((d) => (d.unit ? [key(d.unit.table, d.unit.row, d.unit.field)] : [])));
  const found = new Set<string>();
  for (const d of changed) {
    if (d.kind !== "row" || !STAMP_TABLES.has(d.table) || !UNIT_LABELS.has(String(d.row.table_name))) continue;
    const k = key(d.row.table_name, d.row.row_key, d.row.field);
    if (!named.has(k)) found.add(k);
  }
  if (found.size > unnamed.length) return;
  [...found].forEach((k, j) => { const [table, row, field] = JSON.parse(k) as [string, string, string]; unnamed[j]!.unit = { table, row, field }; });
}
const UNIT_LABELS = new Set(UNIT_SOURCES.flatMap((s) => labelsOf(s)));

/** The ending (`runEnding`), throwing every difference it found as one error. Exported for the negative control. */
export async function endExchange(peers: Peer[], pairs: (readonly [Peer, Peer])[] = peers.flatMap((x) => peers.filter((y) => y !== x).map((y) => [x, y] as const)),
  claimed: Map<string, string> | null = null, exercised: ReadonlySet<string> = new Set(pairs.map(([x, y]) => direction(peers, x, y)))): Promise<{ settleRounds: number }> {
  const { settleRounds, differences } = await runEnding(peers, pairs, claimed, exercised);
  if (differences.length) throw new Error(describeDifferences(differences));
  return { settleRounds };
}

/** Step 4 of the ending on its own: the stamps, other heads and unit values of every node against the first's, every difference of all three. Exported for the
 *  negative control (which makes a difference only one of the three can see), which reads it as an error. */
export async function sameEverywhere(peers: Peer[]): Promise<void> {
  const differences = await differencesBetween(peers);
  if (differences.length) throw new Error(describeDifferences(differences));
}

async function differencesBetween(peers: Peer[]): Promise<Difference[]> {
  const out: Difference[] = [];
  const states = await Promise.all(peers.map((p) => sameUnits(p)));
  const [firstPeer, first] = [peers[0]!, states[0]!];
  peers.slice(1).forEach((p, i) => {
    const other = states[i + 1]!;
    for (const what of ["stamps", "heads", "values"] as const) {
      const [x, y] = [new Set(first[what]), new Set(other[what])];
      const sides: [Peer, string[], Peer, string[]][] = [[firstPeer, first[what].filter((v) => !y.has(v)), p, other[what]], [p, other[what].filter((v) => !x.has(v)), firstPeer, first[what]]];
      for (const [on, only, against, theirs] of sides) for (const v of only) {
        if (what === "values") {
          const [label, row, ...text] = v.split(" ");
          out.push({ kind: "value", onlyOn: on.name, other: against.name, label: label!, row: row!, text: text.join(" ") });
          continue;
        }
        const item = JSON.parse(v) as Record<string, unknown>;
        const mine = on === firstPeer ? first.stamps : other.stamps;
        out.push({ kind: what === "stamps" ? "stamp" : "head", onlyOn: on.name, other: against.name, item, copyOfCreation: what === "stamps" && isCopyOfCreation(item, mine, theirs) });
      }
    }
  });
  return out;
}
/** A field stamp that repeats the row's creation stamp (the same origin, number, clock and writer as its `*`), where the other node holds that same `*`. */
function isCopyOfCreation(stamp: Record<string, unknown>, mine: string[], theirs: string[]): boolean {
  if (stamp.field === "*") return false;
  const creation = mine.map((v) => JSON.parse(v) as Record<string, unknown>).find((s) => s.table_name === stamp.table_name && s.row_key === stamp.row_key && s.field === "*");
  if (!creation) return false;
  const same = ["origin", "seq", "hlc_wall", "hlc_counter", "author", "device"].every((k) => creation[k] === stamp[k]);
  return same && theirs.includes(JSON.stringify(creation));
}

/** The differences as one message: each kind in the words the negative control reads, a few of each. */
export function describeDifferences(differences: readonly Difference[]): string {
  const lines: string[] = [];
  const few = (xs: unknown[]) => JSON.stringify(xs.slice(0, 3));
  const stored = (step: StoredStep) => differences.filter((d): d is Extract<Difference, { kind: "stored" }> => d.kind === "stored" && d.step === step);
  const unitsOf = (ds: Extract<Difference, { kind: "stored" }>[]) => few(ds.map((d) => `${d.peer}: ${d.unit ? `${d.unit.table} ${d.unit.row} ${d.unit.field}` : "(no unit named)"}`));
  const quiet = stored("claimed quiet"), again = stored("one more round"), resent = stored("full resend");
  if (quiet.length) lines.push(`the test's own last exchanges stored nothing and nobody wrote since, but one more round stored ${quiet.length}: the test was not quiet when it said so ${unitsOf(quiet)}`);
  if (again.length) lines.push(`one more exchange round stored ${again.length} ${unitsOf(again)}`);
  if (resent.length) lines.push(`sending everything again stored ${resent.length} ${unitsOf(resent)}`);
  const rows = differences.filter((d): d is Extract<Difference, { kind: "row" }> => d.kind === "row");
  for (const key of new Set(rows.map((d) => `${d.peer}\u0000${d.table}`))) {
    const [peer, table] = key.split("\u0000") as [string, string];
    const of = (side: "before" | "after") => rows.filter((d) => d.peer === peer && d.table === table && d.side === side).slice(0, 2).map((d) => JSON.stringify(d.row).slice(0, 500));
    lines.push(`one more round and a full resend reported nothing stored, but ${peer}'s ${table} (before only ${JSON.stringify(of("before"))}, after only ${JSON.stringify(of("after"))}) changed`);
  }
  for (const kind of ["stamp", "head", "value"] as const) {
    const ds = differences.filter((d) => d.kind === kind) as Extract<Difference, { kind: "stamp" | "head" | "value" }>[];
    for (const pair of new Set(ds.map((d) => [d.onlyOn, d.other].sort().join("\u0000")))) {
      const [x, y] = pair.split("\u0000") as [string, string];
      const only = (on: string) => ds.filter((d) => d.onlyOn === on && d.other === (on === x ? y : x)).map((d) => (d.kind === "value" ? `${d.label} ${d.row} ${d.text}` : d.item));
      lines.push(`after the ending ${x} and ${y} hold different ${kind}s: only ${x} ${few(only(x))}, only ${y} ${few(only(y))}`);
    }
  }
  return lines.join("; ");
}

/** Columns of the workspace's tables a take may write while storing nothing, and why. Every other column of every table with the workspace's rows is in the fingerprint
 *  (the clock's write number and its counters of writes, how far each origin is held: a take that stores nothing moves none of them). */
const FINGERPRINT_LEAVES_OUT: Record<string, Record<string, string>> = {
  sync_clock: {
    hlc_wall: "the receiver's clock moves past every stamp it reads (advanceClockFor), stored or not",
    hlc_counter: "the receiver's clock moves past every stamp it reads (advanceClockFor), stored or not",
    merge_batches: "counts the bundles merged, whatever they stored (a diagnostic)",
  },
};

/** Every table holding the workspace's rows on `p`, each as its rows (whole rows, every column, as text, sorted), the stamps and heads too: what a take wrote, whatever it reported. */
async function fingerprint(p: Peer): Promise<Record<string, string[]>> {
  return onNode(p.node, async () => {
    const out: Record<string, string[]> = {};
    const withWs = (await q<{ t: string }>(`SELECT c.table_name AS t FROM information_schema.columns c JOIN information_schema.tables x ON x.table_schema = c.table_schema AND x.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'workspace_id' AND x.table_type = 'BASE TABLE' ORDER BY 1`)).rows.map((r) => r.t);
    const rows = async (table: string, where: string, params: unknown[]) => {
      const without = Object.keys(FINGERPRINT_LEAVES_OUT[table] ?? {}).map((c) => ` - '${c}'`).join("");
      return (await q<{ r: string }>(`SELECT (to_jsonb(t)${without})::text AS r FROM ${quote(table)} t WHERE ${where} ORDER BY 1`, params)).rows.map((x) => x.r);
    };
    for (const t of withWs) out[t] = await rows(t, "t.workspace_id = $1", [p.ws]);
    // the carried tables without a workspace column, by the snapshot's own selection of the whole workspace
    for (const spec of SNAPSHOT_SPECS) if (!(spec.table in out)) out[spec.table] = await rows(spec.table, spec.where(wholeWorkspace()), [p.ws]);
    return out;
  });
}
/** The rows of `peer` that one fingerprint has and the other not, table by table. */
function changedRows(peer: string, before: Record<string, string[]>, after: Record<string, string[]>): Difference[] {
  const out: Difference[] = [];
  for (const table of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const [b, a] = [before[table] ?? [], after[table] ?? []];
    const [bs, as] = [new Set(b), new Set(a)];
    for (const r of b) if (!as.has(r)) out.push({ kind: "row", peer, table, side: "before", row: JSON.parse(r) as Record<string, unknown> });
    for (const r of a) if (!bs.has(r)) out.push({ kind: "row", peer, table, side: "after", row: JSON.parse(r) as Record<string, unknown> });
  }
  return out;
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
      // the rows a snapshot of the owner carries (what the digest is made of): not the rows a node derives for itself, not rows out of the owner's scope
      const spec = SNAPSHOT_SPECS.find((s) => s.table === src.table);
      if (!spec) throw new Error(`${src.table} has units (UNIT_SOURCES) but no snapshot selection (SNAPSHOT_SPECS): the ending cannot say which of its rows the owner holds`);
      const m = rowMatchOf(src, []), params: unknown[] = [p.ws];
      const rows = (await q<{ k: string; v: string }>(`SELECT ${m.idSql("t")} AS k, (${unitTextsSql(src, "t")})::text AS v FROM ${quote(src.table)} t WHERE ${spec.where(scopeOf(params))}`, params)).rows;
      for (const r of rows) out.push(`${src.label} ${r.k} ${r.v}`);
    }
    return out.sort();
  }));
  const texts = (xs: unknown) => (xs as unknown[]).map((x) => JSON.stringify(x)).sort();
  return { stamps: texts(state.stamps), heads: texts(state.heads), values };
}

/** The running test ran the ending itself (endExchange) on what it exchanged: nothing more is run after it (the negative control, whose nodes are left different on purpose). */
export function endedByTheTest(): void {
  if (current) for (const e of current.events) e.consumed = true;
}

/** The error the ending of the running test found so far, taken (the negative control asserts it instead of failing). */
export function takeEndingError(): unknown {
  const e = current?.error ?? null;
  if (current) current.error = null;
  return e;
}

/** The running test's name as the exception lists key it (the negative control pins itself). */
export const runningTestName = (): string | null => current?.name ?? null;
