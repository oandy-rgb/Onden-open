// The ending every bundle test has (helpers/stampedEnding.ts; issue #1976) reaches a test through the wrapper of test/stampedEndingSetup.ts alone. This file does not
// mock spine/stampedImport.ts (stampedEndingControl.integration.test.ts does, so it cannot show the wrapper is in place): a bundle taken here, by the helpers and by a
// direct call of the engine's own export, is recorded and ended; a pinned test whose ending never ran is red; a skipped test that no longer needs it is red. Both engines.
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getCurrentTest } from "vitest/suite";
import { randomUUID } from "node:crypto";
import { applyChangeBundle } from "../spine/stampedImport.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, capture, fillFrom, openNode } from "./helpers/stampedWorld.js";
import { admit, bundleFor, exchange, peerOf } from "./helpers/stampedBundleWorld.js";
import { groupsEnded } from "./helpers/stampedEnding.js";
import { ENDING_FAILS, ENDING_SKIPPED } from "./helpers/stampedEndingExceptions.js";
import { fullName } from "./helpers/stampedEndingNames.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });
const pinnedHere: string[] = [];
const skippedHere: string[] = [];
afterAll(() => { for (const name of pinnedHere) delete ENDING_FAILS[name]; for (const name of skippedHere) delete ENDING_SKIPPED[name]; });

describe.skipIf(!isTestDb)("the ending reaches a test that does not mock the engine", () => {
  it("a bundle taken by the helpers and one taken by a direct call of applyChangeBundle are recorded, and the ending runs when the test closes its nodes", async () => {
    const [na, nb] = [await openNode("a"), await openNode("b")];
    open.push(na, nb);
    const world = await buildSourceWorld(na);
    const a = peerOf("A", na, world);
    await fillFrom(nb, world, await capture(na, world, 1_000_000));
    const b = peerOf("B", nb, world);
    await admit(a, b);
    const note = randomUUID();
    await onNode(a.node, () => a.call("POST", "/api/nodes", { id: note, title: "Alive", markdown: "one", space_id: a.space }));
    await exchange(a, b);
    await onNode(b.node, () => b.call("PATCH", `/api/nodes/${note}`, { markdown: "one\ntwo" }));
    // the engine's own export, imported here: the wrapper is what this name is
    const bundle = await bundleFor(b, a);
    expect((await onNode(a.node, () => applyChangeBundle(a.ws, bundle))).stored).toBeGreaterThan(0);
    const before = groupsEnded;
    for (const n of open.splice(0)) await n.close();
    expect(groupsEnded).toBe(before + 1);
  }, 300_000);

  // `it.fails`: the body passes; the setup file's check after the test turns it red
  it.fails("a test pinned in ENDING_FAILS whose ending never ran (nothing recorded) is red", () => {
    const name = fullName(getCurrentTest() as never);
    ENDING_FAILS[name] = { why: "the control pins itself and exchanges nothing", allows: () => true };
    pinnedHere.push(name);
  });

  it.fails("a test in ENDING_SKIPPED that exchanges nothing is red (the line is not needed)", () => {
    const name = fullName(getCurrentTest() as never);
    ENDING_SKIPPED[name] = "the control skips itself and exchanges nothing";
    skippedHere.push(name);
  });

  it.fails("a test in ENDING_SKIPPED whose exchanges end clean is red (the line is not needed)", async () => {
    const name = fullName(getCurrentTest() as never);
    ENDING_SKIPPED[name] = "the control skips itself and exchanges as every test does";
    skippedHere.push(name);
    const [na, nb] = [await openNode("a"), await openNode("b")];
    open.push(na, nb);
    const world = await buildSourceWorld(na);
    const a = peerOf("A", na, world);
    await fillFrom(nb, world, await capture(na, world, 1_000_000));
    const b = peerOf("B", nb, world);
    await admit(a, b);
    await onNode(a.node, () => a.call("POST", "/api/nodes", { id: randomUUID(), title: "Skipped", markdown: "one", space_id: a.space }));
    await exchange(a, b);
    for (const n of open.splice(0)) await n.close();
  }, 300_000);
});
