// The negative control of the ending every bundle test has (helpers/stampedEnding.ts; issue #1976): a merge that is not idempotent on a resend, as a TEST DOUBLE of
// applyChangeBundle (the engine is not edited), turns the ending red, both when it is called and when a test closes its nodes; the real merge ends clean. Both engines.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { q, withTransaction } from "../db.js";
import type { ChangeBundle } from "../spine/snapshotSql.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, capture, fillFrom, openNode } from "./helpers/stampedWorld.js";
import { admit, exchange, peerOf, writeAsOwner, type Peer } from "./helpers/stampedBundleWorld.js";
import { endExchange, endedByTheTest, groupsEnded, takeEndingError } from "./helpers/stampedEnding.js";

/** What the double does to a bundle sent with an empty `have` (a full resend): nothing (the real merge), report a write it did not make, make a write (on A), or change
 *  a value with no stamp at all (on A: the stamp triggers are off for that one statement, which no product path can do; it is what only the value comparison sees). */
let double: "off" | "reportsStored" | "rewrites" | "rewritesValue" = "off";
const receivers = new Map<string, Peer>();
/** The note the two nodes wrote (twoPeers) and the double writes again. */
let target = "";
const AGAIN = `UPDATE content_nodes SET title = title || ' again' WHERE id = $1`;
vi.mock("../spine/stampedImport.js", async (original) => {
  const real = await original<typeof import("../spine/stampedImport.js")>();
  const isResend = (b: ChangeBundle) => Object.values(b.base ?? {}).every((per) => Object.keys(per ?? {}).length === 0);
  return {
    ...real,
    applyChangeBundle: async (ws: string, bundle: ChangeBundle) => {
      const report = await real.applyChangeBundle(ws, bundle);
      if (double === "off" || !isResend(bundle)) return report;
      if (double === "reportsStored") return { ...report, stored: report.stored + 1 };
      // a rule that writes again what it already holds: the title of the receiver's first note changes on a resend, and the report says nothing. Only on A, which
      // takes the last resend of the ending (pairs A→B, then B→A): nothing sends it on, so what catches it is that the nodes no longer hold the same values
      const me = receivers.get(String((await import("../spine/stamps.js").then((m) => m.localNodeId()))))!;
      if (me.name !== "A") return report;
      if (double === "rewrites") await writeAsOwner(me, AGAIN, [target]);
      else await withTransaction(async () => { await q(`SET LOCAL session_replication_role = replica`); await q(AGAIN, [target]); });
      return report;
    },
  };
});

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const open: RealNode[] = [];
afterEach(async () => { double = "off"; for (const n of open.splice(0)) await n.close().catch(() => undefined); });

async function twoPeers(): Promise<[Peer, Peer]> {
  const [na, nb] = [await openNode("a"), await openNode("b")];
  open.push(na, nb);
  const world = await buildSourceWorld(na);
  const a = peerOf("A", na, world);
  await fillFrom(nb, world, await capture(na, world, 1_000_000));
  const b = peerOf("B", nb, world);
  await admit(a, b);
  const { nodeIdOf } = await import("./helpers/stampedBundleWorld.js");
  for (const p of [a, b]) receivers.set(await nodeIdOf(p), p);
  // fixed writes, so the note the double writes is there: A makes it, B renames it and adds a line, A renames it again
  target = randomUUID();
  await onNode(a.node, () => a.call("POST", "/api/nodes", { id: target, title: "Control", markdown: "first", space_id: a.space }));
  await exchange(a, b);
  await onNode(b.node, () => b.call("PATCH", `/api/nodes/${target}`, { title: "Control (B)", markdown: "first\nsecond" }));
  await onNode(a.node, () => a.call("PATCH", `/api/nodes/${target}`, { title: "Control (A)" }));
  await exchange(a, b); await exchange(b, a);
  return [a, b];
}

describe.skipIf(!isTestDb)("the ending of every bundle test: one more round and a full resend store nothing, every node the same", () => {
  it("the real merge ends clean", async () => {
    const before = groupsEnded;
    await endExchange(await twoPeers());
    expect(groupsEnded).toBe(before + 1);
    endedByTheTest();
  }, 300_000);

  it("a merge that reports a write on a resend is caught by the full resend", async () => {
    const peers = await twoPeers();
    double = "reportsStored";
    await expect(endExchange(peers)).rejects.toThrow(/sending everything again stored/);
    endedByTheTest();
  }, 300_000);

  it("a merge that writes again on a resend (and says nothing) is caught: the nodes no longer hold the same stamps", async () => {
    const peers = await twoPeers();
    double = "rewrites";
    await expect(endExchange(peers)).rejects.toThrow(/hold different stamps/);
    endedByTheTest();
  }, 300_000);

  it("a merge that changes a value on a resend without a stamp is caught: the nodes no longer hold the same values", async () => {
    const peers = await twoPeers();
    double = "rewritesValue";
    await expect(endExchange(peers)).rejects.toThrow(/hold different values/);
    endedByTheTest();
  }, 300_000);

  it("closing the nodes in the test runs the ending without being asked: the double turns it red", async () => {
    await twoPeers();
    double = "rewrites";
    for (const n of open.splice(0)) await n.close();
    expect(String(takeEndingError())).toMatch(/hold different stamps/);
  }, 300_000);

  // Nothing in this test fails but the ending that runs after it (its nodes are closed by the afterEach above, so the ending runs from onTestFinished): `it.fails`
  // passes only because the ending turned it red. The body changes a value on A with no stamp, once (what a merge that is not idempotent leaves behind).
  it.fails("a test that only exchanges, its nodes closed by afterEach: the ending alone turns it red when a value differs", async () => {
    const [a] = await twoPeers();
    await onNode(a.node, () => withTransaction(async () => {
      await q(`SET LOCAL session_replication_role = replica`);
      await q(AGAIN, [target]);
    }));
  }, 300_000);
});
