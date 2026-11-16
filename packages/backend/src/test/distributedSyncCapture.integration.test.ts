// Distributed sync step 2a, capture and projection bookkeeping: events become ops once, remote events never come back, and what the
// engine cannot carry is counted rather than lost. Doc: docs/architecture/distributed-sync.md §3.1.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { q } from "../db.js";
import { createSharedSpace, setMember, updateSpace } from "../services/spaces.js";
import { createNote } from "../services/noteCreate.js";
import { updateNode } from "../services/nodeUpdate.js";
import type { ActorCtx } from "../types.js";
import { RealCluster } from "./helpers/distSim/realCluster.js";

vi.setConfig({ testTimeout: 300_000 });
const enabled = process.env.ONDEN_DB_DRIVER === "pglite" && isTestDatabase();
let ws: string, alice: ActorCtx, bob: ActorCtx, team: string, plan: string;
async function seedWorld(): Promise<string> {
  ws = (await q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Cap',$1) RETURNING id", [randomUUID()])).rows[0]!.id;
  const person = async (name: string) => (await q<ActorCtx>("INSERT INTO actors(workspace_id,name,type) VALUES($1,$2,'human') RETURNING id,name,type", [ws, name])).rows[0]!;
  alice = await person("alice"); bob = await person("bob");
  team = (await createSharedSpace(alice, ws, "team")).id;
  await setMember(alice, ws, team, bob.id, "edit");
  plan = (await createNote({ actor: alice, workspaceId: ws, title: "Plan", markdown: "a\nb", spaceId: team, event: { uiContext: "seed" } })).node.id;
  return ws;
}

describe.skipIf(!enabled)("capture", () => {
  let cluster: RealCluster | null = null;
  beforeAll(() => { process.env.ONDEN_DISTRIBUTED_SYNC = "1"; });
  afterEach(async () => { await cluster?.close(); cluster = null; });

  it("turns each event into ops once, even if the cursor is lost, and counts what it cannot carry", async () => {
    cluster = await RealCluster.create(["A", "B"], seedWorld);
    const a = cluster.node("A").replica;
    expect((await a.unsupported()).filter((u) => !u.what.startsWith("snapshot"))).toEqual([]);

    const atGenesis = await cluster.on("A", async () => (await q<{ last_event_id: string }>("SELECT last_event_id FROM ds_capture_cursor")).rows[0]!.last_event_id);
    await cluster.on("A", async () => {
      await updateNode(ws, plan, { title: "Plan 2", markdown: "a\nb\nc" }, { actor: alice });          // carried: a title op and a body op
      await updateNode(ws, plan, { order_key: "a5" }, { actor: alice });                                 // not carried
      await createNote({ actor: alice, workspaceId: ws, title: "Board", nodeType: "canvas", spaceId: team, event: { uiContext: "t", type: "CANVAS_CREATED" } }); // not carried
      await updateSpace(alice, ws, team, { name: "team 2" });                                          // not carried
    });
    const counts = async () => (await cluster!.ops("A")).filter((o) => o.origin === "A").length;
    const first = await counts();
    expect(first).toBe(2);
    expect((await cluster.on("A", () => a.capture())).ops).toBe(0);                                    // nothing new
    await cluster.on("A", () => q("UPDATE ds_capture_cursor SET last_event_id = $1", [atGenesis])); // the cursor goes back: the per-event record still protects
    const again = await cluster.on("A", () => a.capture());
    expect(again.ops).toBe(0);
    expect(await counts()).toBe(first);
    const unsupported = Object.fromEntries((await a.unsupported()).filter((u) => !u.what.startsWith("snapshot")).map((u) => [u.what, u.count]));
    expect(unsupported).toMatchObject({ "NODE_UPDATED (changed only fields the engine does not carry)": 1, "SPACE_UPDATED": 1 });
    expect(Object.keys(unsupported).some((k) => k.startsWith("NODE_CREATED") || k.startsWith("CANVAS_CREATED"))).toBe(true);
  });

  it("an event written by projecting a remote op is never sent back", async () => {
    cluster = await RealCluster.create(["A", "B"], seedWorld);
    await cluster.on("A", () => updateNode(ws, plan, { markdown: "a\nb\nfrom A" }, { actor: alice }));
    await cluster.quiesce();
    const events = await cluster.on("B", async () => (await q<{ n: string }>("SELECT count(*) AS n FROM domain_events WHERE workspace_id = $1 AND tx_meta ? 'ds_op_id'", [ws])).rows[0]!.n);
    expect(Number(events)).toBeGreaterThan(0);
    for (const op of await cluster.ops("B")) expect(op.origin, "B wrote nothing itself").not.toBe("B");
    expect(await cluster.checkConverged()).toEqual([]);
    // the next round trip adds nothing either
    const before = (await cluster.ops("A")).length;
    await cluster.quiesce();
    expect((await cluster.ops("A")).length).toBe(before);
  });

  it("the same message delivered twice, or lost and sent again, changes nothing", async () => {
    cluster = await RealCluster.create(["A", "B"], seedWorld, { faults: { drop: 0, duplicate: 1 } });
    await cluster.on("A", () => updateNode(ws, plan, { title: "once" }, { actor: alice }));
    await cluster.quiesce();
    expect(await cluster.checkConverged()).toEqual([]);
    expect((await cluster.ops("B")).filter((o) => o.origin === "A")).toHaveLength(1);
  });
});
