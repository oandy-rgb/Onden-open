// The negative control of the ending every bundle test has (helpers/stampedEnding.ts; issue #1976). Each check of the ending is shown to turn red on a fault only it sees:
// a refusal; a resend that reports a write; one more round that stores; a test that says it was quiet and was not; a merge that rewrites quietly on both nodes alike
// (only the before/after fingerprint sees it); a difference in the stamps only, in the heads only, in the values only; a pinned finding whose ending passes, or finds
// another difference only, or its own and one more (a value, a stamp across nodes, or a row only the fingerprint sees on the node that stored); a store the report does
// not name, named by the stamp it wrote; a pinned test of two groups, judged over both (the finding in the second only: found; in neither: passes now); units taken from
// no node; an exchange in another process with no entry. The faults are a TEST DOUBLE of applyChangeBundle (vi.mock below; the engine is not edited) or a write made with
// the stamp triggers off (no product path can do that). The real merge ends clean. Both engines.
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { q, withTransaction } from "../db.js";
import type { ChangeBundle } from "../spine/snapshotSql.js";
import { RealNode, currentNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, capture, fillFrom, openNode } from "./helpers/stampedWorld.js";
import { admit, exchange, peerOf, type Peer } from "./helpers/stampedBundleWorld.js";
import { endExchange, endedByTheTest, groupsEnded, runningTestName, sameEverywhere, takeEndingError } from "./helpers/stampedEnding.js";
import { ENDING_FAILS } from "./helpers/stampedEndingExceptions.js";
import type { Difference } from "./helpers/stampedEndingNames.js";

/** What the double does. On a bundle sent with an empty `have` (a full resend): `reportsStored` reports one more write than it made (`…AndValue`, `…AndUnseenStamp`,
 *  `…AndStamps`: and on the second, the last bundle of a two-node ending, it also changes the receiver's title, or adds a stamp of a label no unit carries, or adds
 *  field stamps of the note (`stampFields`), with the stamp triggers off; nothing is sent after it, so no refusal hides what the comparison finds), `refuses` refuses it, `rewritesOnBoth`
 *  moves the target's updated_at (no unit) on the receiver with the stamp triggers off and reports nothing, `movesHeld` adds to how far the receiver says it holds an origin
 *  (sync_origins.have) and reports nothing, `writesZero` adds a label held up to 0 there (what a snapshot's `broughtOf` reads as an origin it brings) and reports nothing. On the other bundles: `liesOnce` reports one write on the first after it is armed, `liesOnThird` on the third,
 *  `liesFourTimes` on each of the first four (two rounds of two). */
let double: "off" | "reportsStored" | "reportsStoredAndValue" | "reportsStoredAndUnseenStamp" | "reportsStoredAndStamps" | "refuses" | "rewritesOnBoth" | "movesHeld" | "writesZero" | "liesOnce" | "liesOnThird" | "liesFourTimes" = "off";
let takenSinceArmed = 0;
/** The note the two nodes wrote (twoPeers), which the faults change. */
let target = "";
const AGAIN = `UPDATE content_nodes SET title = title || ' again' WHERE id = $1`;
/** A column that is no unit (README: a note's updated_at follows its stamps; nothing sends it): what the stamps, heads and values comparisons cannot see. */
const TOUCH = `UPDATE content_nodes SET updated_at = updated_at + interval '1 second' WHERE id = $1`;
/** A write the stamp triggers do not see (session_replication_role = replica): what no product path can do, so only the ending's own checks can find it. */
const unstamped = (sql: string, params: unknown[]) => withTransaction(async () => { await q(`SET LOCAL session_replication_role = replica`); await q(sql, params); });
/** A stamp row of the target under a label no unit carries (a copy of its `*`): no comparison across nodes reads it, only a node's own before/after fingerprint does. */
const UNSEEN_STAMP = `INSERT INTO sync_stamps SELECT (jsonb_populate_record(NULL::sync_stamps, to_jsonb(s) || '{"table_name": "control_no_unit"}'::jsonb)).* FROM sync_stamps s
  WHERE s.workspace_id = $1 AND s.table_name = 'content_nodes' AND s.row_key = $2 AND s.field = '*'`;
/** A field stamp of the target (a copy of its `*` under field $3): a unit's label, so the receiver's own stamps and the comparison across nodes both read it. */
const FIELD_STAMP = `INSERT INTO sync_stamps SELECT (jsonb_populate_record(NULL::sync_stamps, to_jsonb(s) || jsonb_build_object('field', $3::text))).* FROM sync_stamps s
  WHERE s.workspace_id = $1 AND s.table_name = 'content_nodes' AND s.row_key = $2 AND s.field = '*'`;
/** The fields `reportsStoredAndStamps` writes a stamp of. */
let stampFields: string[] = [];
/** The nodes the double acts on when it receives (null: every node): a fault in one group of a test that has two. */
let doubleOn: Set<RealNode> | null = null;

vi.mock("../spine/stampedImport.js", async (original) => {
  const real = await original<typeof import("../spine/stampedImport.js")>();
  const ending = () => import("./helpers/stampedEnding.js");
  const isResend = (b: ChangeBundle) => Object.values(b.base ?? {}).every((per) => Object.keys(per ?? {}).length === 0);
  const doubled = async (ws: string, bundle: ChangeBundle) => {
    if (doubleOn && !doubleOn.has(currentNode()!)) return real.applyChangeBundle(ws, bundle);
    if (double === "refuses" && isResend(bundle)) throw Object.assign(new Error("refused by the double"), { code: "bundle_refused_by_double", status: 409 });
    const report = await real.applyChangeBundle(ws, bundle);
    if ((double === "reportsStored" || double === "reportsStoredAndValue" || double === "reportsStoredAndUnseenStamp" || double === "reportsStoredAndStamps") && isResend(bundle)) {
      if (double !== "reportsStored" && ++takenSinceArmed === 2) {
        if (double === "reportsStoredAndValue") await unstamped(AGAIN, [target]);
        else if (double === "reportsStoredAndUnseenStamp") await unstamped(UNSEEN_STAMP, [ws, target]);
        else for (const f of stampFields) await unstamped(FIELD_STAMP, [ws, target, f]);
      }
      return { ...report, stored: report.stored + 1 };
    }
    if (double === "rewritesOnBoth" && isResend(bundle)) { await unstamped(TOUCH, [target]); return report; }
    if (double === "writesZero" && isResend(bundle)) { await q(`UPDATE sync_origins SET have = have || '{"control": 0}'::jsonb WHERE workspace_id = $1`, [ws]); return report; }
    if (double === "movesHeld" && isResend(bundle)) { await q(`UPDATE sync_origins SET have = have || '{"control": 1}'::jsonb WHERE workspace_id = $1`, [ws]); return report; }
    if (!isResend(bundle) && (double === "liesOnce" || double === "liesOnThird" || double === "liesFourTimes")) {
      takenSinceArmed++;
      if ((double === "liesOnce" && takenSinceArmed === 1) || (double === "liesOnThird" && takenSinceArmed === 3) || (double === "liesFourTimes" && takenSinceArmed <= 4)) {
        return { ...report, stored: report.stored + 1 };
      }
    }
    return report;
  };
  // recorded like every other test's calls (this file's mock takes the place of test/stampedEndingSetup.ts's)
  return {
    ...real,
    applyChangeBundle: async (ws: string, bundle: ChangeBundle) => (await ending()).engineCall("bundle", ws, bundle.sender, bundle, () => doubled(ws, bundle)),
    mergeUnitsIntoWorkspace: async (ws: string, ...rest: [Parameters<typeof real.mergeUnitsIntoWorkspace>[1]]) =>
      (await ending()).engineCall("units", ws, null, null, () => real.mergeUnitsIntoWorkspace(ws, ...rest)),
  };
});

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const open: RealNode[] = [];
afterEach(async () => { double = "off"; stampFields = []; doubleOn = null; for (const n of open.splice(0)) await n.close().catch(() => undefined); });

/** A and B (B joined from A's snapshot, each admits the other); A makes a note, B renames it and adds a line, A renames it again, and they exchange both ways. */
async function twoPeers(): Promise<[Peer, Peer]> {
  const [na, nb] = [await openNode("a"), await openNode("b")];
  open.push(na, nb);
  const world = await buildSourceWorld(na);
  const a = peerOf("A", na, world);
  await fillFrom(nb, world, await capture(na, world, 1_000_000));
  const b = peerOf("B", nb, world);
  await admit(a, b);
  target = randomUUID();
  await onNode(a.node, () => a.call("POST", "/api/nodes", { id: target, title: "Control", markdown: "first", space_id: a.space }));
  await exchange(a, b);
  await onNode(b.node, () => b.call("PATCH", `/api/nodes/${target}`, { title: "Control (B)", markdown: "first\nsecond" }));
  await onNode(a.node, () => a.call("PATCH", `/api/nodes/${target}`, { title: "Control (A)" }));
  await exchange(a, b); await exchange(b, a);
  return [a, b];
}
/** A pair of its own with no writes (B joined from A's snapshot, A admits B, one bundle A to B: this file's double records bundles, not joins): one group of the
 *  ending. Lighter than twoPeers, for a test that needs two groups. */
async function barePair(): Promise<[Peer, Peer]> {
  const [na, nb] = [await openNode("a"), await openNode("b")];
  open.push(na, nb);
  const world = await buildSourceWorld(na);
  await fillFrom(nb, world, await capture(na, world, 1_000_000));
  const a = peerOf("A", na, world), b = peerOf("B", nb, world);
  await admit(a, b);
  await exchange(a, b);
  return [a, b];
}
/** A pin for the `writesZero` double's row: a sync_origins row that changed. */
const zeroRow = (d: Difference) => d.kind === "row" && d.table === "sync_origins";
const arm = (d: typeof double) => { double = d; takenSinceArmed = 0; };
/** Close the nodes in the test body (the ending runs then) and return what it found. */
const closeAndTake = async () => { for (const n of open.splice(0)) await n.close(); return String(takeEndingError()); };

describe.skipIf(!isTestDb)("the ending of every bundle test: each check turns red on a fault only it sees", () => {
  it("the real merge ends clean", async () => {
    const before = groupsEnded;
    await endExchange(await twoPeers());
    expect(groupsEnded).toBe(before + 1);
    endedByTheTest();
  }, 300_000);

  it("a refusal anywhere in the ending (here: the full resend)", async () => {
    const peers = await twoPeers();
    arm("refuses");
    await expect(endExchange(peers)).rejects.toThrow(/full resend: .* refused \(bundle_refused_by_double\)/);
    endedByTheTest();
  }, 300_000);

  it("a full resend that reports a write", async () => {
    const peers = await twoPeers();
    arm("reportsStored");
    await expect(endExchange(peers)).rejects.toThrow(/sending everything again stored [12]/);
    endedByTheTest();
  }, 300_000);

  it("one more round, after the nodes were quiet, that stores", async () => {
    const peers = await twoPeers();
    arm("liesOnThird"); // the first round (two bundles) is quiet; the third bundle is the first of one more round
    await expect(endExchange(peers)).rejects.toThrow(/one more exchange round stored 1/);
    endedByTheTest();
  }, 300_000);

  it("a test that exchanged to quiet itself, after which one more round stores: the test was not quiet when it said so", async () => {
    const [a, b] = await twoPeers();
    await exchange(a, b); await exchange(b, a); // both directions store nothing now: the test says it is quiet
    arm("liesOnce");
    expect(await closeAndTake()).toMatch(/the test was not quiet when it said so/);
  }, 300_000);

  it("a merge that rewrites quietly on every node alike: the same everywhere, reported as nothing, but each node's own state changed", async () => {
    const peers = await twoPeers();
    arm("rewritesOnBoth");
    await expect(endExchange(peers)).rejects.toThrow(/reported nothing stored, but .*content_nodes.* changed/);
    endedByTheTest();
  }, 300_000);

  it("a take that moves how far the receiver holds an origin, storing nothing: the fingerprint sees sync_origins (only the clock's own columns are left out)", async () => {
    const peers = await twoPeers();
    arm("movesHeld");
    await expect(endExchange(peers)).rejects.toThrow(/reported nothing stored, but A.s sync_origins \(before only/);
    endedByTheTest();
  }, 300_000);

  it("a full resend that writes only a label held up to 0, storing nothing: red (a 0 is not read as nothing held: the snapshot's broughtOf brings that origin)", async () => {
    const peers = await twoPeers();
    arm("writesZero");
    await expect(endExchange(peers)).rejects.toThrow(/reported nothing stored, but A.s sync_origins \(before only .*after only \[.*\\"control\\":0/);
    endedByTheTest();
  }, 300_000);

  // a pinned test is judged over all its groups (helpers/stampedEnding.ts endGroups): judged per group, the clean group ended first said "passes now" and kept the
  // group that holds the finding from being ended (the five nodeRenewal ZEROS_WRITTEN_OUT pins, red every run before b6fd112b0)
  it("a pinned test with two groups, the first ending clean and the second holding the pinned difference: found as pinned, not \"passes now\"", async () => {
    await barePair();
    const second = await barePair();
    arm("writesZero");
    doubleOn = new Set(second.map((p) => p.node!)); // the fault only in the group ended second (the nodes are closed in the order they were opened)
    const name = runningTestName()!;
    ENDING_FAILS[name] = { why: "the control pins itself for a zero its second group writes", allows: zeroRow };
    try {
      expect(await closeAndTake()).toBe("null");
      expect((globalThis as { __ondenPinnedFailed?: Set<string> }).__ondenPinnedFailed?.has(name)).toBe(true); // found as pinned (in the second group), not merely silent
    } finally { delete ENDING_FAILS[name]; }
  }, 300_000);

  it("a pinned test with two groups that both end clean: \"passes now\", red", async () => {
    await barePair();
    await barePair();
    const name = runningTestName()!;
    ENDING_FAILS[name] = { why: "the control pins itself for a zero no group writes", allows: zeroRow };
    try { expect(await closeAndTake()).toMatch(/passes now: take it out of ENDING_FAILS .*none of its 2 group\(s\) found it/); } finally { delete ENDING_FAILS[name]; }
  }, 300_000);

  it("a merge that needs more rounds to settle than the group calls for (two nodes: 2), with no entry: red", async () => {
    await twoPeers();
    arm("liesFourTimes"); // the first two rounds store; the third is quiet
    expect(await closeAndTake()).toMatch(/needed 3 exchange rounds to settle, more than the 2 /);
  }, 300_000);

  /** A pin for what the `reportsStored` double makes: the full resend reports a write it names no unit of. */
  const resendReportsMore = (d: Difference) => d.kind === "stored" && d.step === "full resend" && d.unit === null;

  it("a pinned finding whose ending finds another difference only: red", async () => {
    await twoPeers();
    arm("reportsStored");
    const name = runningTestName()!;
    ENDING_FAILS[name] = { why: "the control pins itself for a difference in stamps", allows: (d) => d.kind === "stamp" };
    try { expect(await closeAndTake()).toMatch(/pinned in ENDING_FAILS .*but it found differences that are not that finding: sending everything again stored/); } finally { delete ENDING_FAILS[name]; }
  }, 300_000);

  it("a pinned finding whose ending finds it: green", async () => {
    await twoPeers();
    arm("reportsStored");
    const name = runningTestName()!;
    ENDING_FAILS[name] = { why: "the control pins itself for a full resend that stores", allows: resendReportsMore };
    try {
      expect(await closeAndTake()).toBe("null");
      expect((globalThis as { __ondenPinnedFailed?: Set<string> }).__ondenPinnedFailed?.has(name)).toBe(true); // found as pinned (in the second group), not merely silent
    } finally { delete ENDING_FAILS[name]; }
  }, 300_000);

  it("a pinned finding whose ending finds it and one more difference (a value only one node holds): red, every step runs whatever the pin takes out", async () => {
    await twoPeers();
    arm("reportsStoredAndValue");
    const name = runningTestName()!;
    ENDING_FAILS[name] = { why: "the control pins itself for a full resend that stores", allows: resendReportsMore };
    try { expect(await closeAndTake()).toMatch(/not that finding: .*hold different values/); } finally { delete ENDING_FAILS[name]; }
  }, 300_000);

  it("a pinned finding whose ending finds it and one more stamp row on the node that said it stored (no node compares that label): red, the store waives only its own unit's rows", async () => {
    await twoPeers();
    arm("reportsStoredAndUnseenStamp");
    const name = runningTestName()!;
    ENDING_FAILS[name] = { why: "the control pins itself for a full resend that stores", allows: resendReportsMore };
    try { expect(await closeAndTake()).toMatch(/not that finding: one more round and a full resend reported nothing stored, but [AB]'s sync_stamps \(before only \[\], after only \["/); } finally { delete ENDING_FAILS[name]; }
  }, 300_000);

  it("a pinned finding whose ending finds it and one more stamp across nodes (two field stamps only the receiver holds): red; a report naming fewer units than it stored names none by more stamps than that", async () => {
    await twoPeers();
    arm("reportsStoredAndStamps");
    stampFields = ["hidden", "hidden2"];
    const name = runningTestName()!;
    ENDING_FAILS[name] = { why: "the control pins itself for a full resend that stores a unit it does not name", allows: resendReportsMore };
    try {
      const found = await closeAndTake();
      expect(found).toMatch(/not that finding: .*hold different stamps: only [AB] \[.*"field":"hidden2?"/);
      expect(found).toMatch(/[AB]'s sync_stamps \(before only \[\], after only \["/); // two stamps for one unnamed store: neither names it, both stay rows the node did not report
    } finally { delete ENDING_FAILS[name]; }
  }, 300_000);

  it("a store the report does not name is named by the unit stamp it wrote on that node (a pin for an unnamed store does not take it), and the stamp stays red across nodes", async () => {
    await twoPeers();
    arm("reportsStoredAndStamps");
    stampFields = ["hidden"];
    const name = runningTestName()!;
    ENDING_FAILS[name] = { why: "the control pins itself for a full resend that stores a unit it does not name", allows: resendReportsMore };
    try {
      const found = await closeAndTake();
      expect(found).toMatch(new RegExp(`not that finding: sending everything again stored 1 \\["[AB]: content_nodes ${target} hidden"\\]`));
      expect(found).toMatch(/hold different stamps: only [AB] \[.*"field":"hidden"/);
      expect(found).not.toMatch(/sync_stamps \(before only/); // the named unit's own stamp row on the node that stored it is that store, not a row it did not report
    } finally { delete ENDING_FAILS[name]; }
  }, 300_000);

  it("a difference in the stamps only (a field stamp A holds and B does not, the value the same)", async () => {
    const [a, b] = await twoPeers();
    await endExchange([a, b]);
    endedByTheTest();
    await onNode(a.node, () => unstamped(`INSERT INTO sync_stamps SELECT (jsonb_populate_record(NULL::sync_stamps, to_jsonb(s) || '{"field": "hidden"}'::jsonb)).* FROM sync_stamps s
      WHERE s.workspace_id = $1 AND s.table_name = 'content_nodes' AND s.row_key = $2 AND s.field = '*'`, [a.ws, target]));
    await expect(sameEverywhere([a, b])).rejects.toThrow(/hold different stamps/);
  }, 300_000);

  it("a difference in the other heads only (a head A holds and B does not, the stamps and values the same)", async () => {
    const [a, b] = await twoPeers();
    await endExchange([a, b]);
    endedByTheTest();
    await onNode(a.node, () => unstamped(`INSERT INTO sync_stamp_heads SELECT (jsonb_populate_record(NULL::sync_stamp_heads, to_jsonb(s) || '{"content_hash": "control", "value": "\\"another title\\"", "valueless": false}'::jsonb)).*
      FROM sync_stamps s WHERE s.workspace_id = $1 AND s.table_name = 'content_nodes' AND s.row_key = $2 AND s.field = 'title'`, [a.ws, target]));
    await expect(sameEverywhere([a, b])).rejects.toThrow(/hold different heads/);
  }, 300_000);

  it("a difference in the values only (a title A holds and B does not, the stamps the same)", async () => {
    const [a, b] = await twoPeers();
    await endExchange([a, b]);
    endedByTheTest();
    await onNode(a.node, () => unstamped(AGAIN, [target]));
    await expect(sameEverywhere([a, b])).rejects.toThrow(/hold different values/);
  }, 300_000);

  it("a pinned finding whose ending passes now is red, so the pin cannot outlive the fault", async () => {
    await twoPeers();
    const name = runningTestName()!;
    ENDING_FAILS[name] = { why: "the control pins itself", allows: () => true };
    try { expect(await closeAndTake()).toMatch(/passes now: take it out of ENDING_FAILS/); } finally { delete ENDING_FAILS[name]; }
  }, 300_000);

  // `it.fails`: nothing in these bodies fails but the ending's own coverage check.
  it.fails("units merged by hand (taken from no node), with no entry: the test is red", async () => {
    const [a] = await twoPeers();
    endedByTheTest();
    const { mergeUnitsIntoWorkspace } = await import("../spine/stampedImport.js");
    await onNode(a.node, () => mergeUnitsIntoWorkspace(a.ws, []));
  }, 300_000);

  it.fails("an exchange in another process, with no entry: the test is red", async () => {
    appendFileSync(process.env.ONDEN_ENDING_MARKS!, "bundle\n");
  });

  it.fails("a test that only exchanges, its nodes closed by afterEach: the ending alone turns it red when a value differs", async () => {
    const [a] = await twoPeers();
    await onNode(a.node, () => unstamped(AGAIN, [target]));
  }, 300_000);

  it("the names the exception lists use: this test's own", async () => {
    await twoPeers();
    expect(runningTestName()).toBe("stampedEndingControl.integration.test.ts > the ending of every bundle test: each check turns red on a fault only it sees > the names the exception lists use: this test's own");
  }, 300_000);
});
