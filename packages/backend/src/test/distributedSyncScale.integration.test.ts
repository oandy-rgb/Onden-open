// Distributed sync step 2a, cost at size (doc §10-3): genesis import, ops written, time to bring a second node level, and the fold.
// By default a small workspace (fast); the numbers in the design doc come from DS_SCALE_NOTES=1000 DS_SCALE_EDITS=30 (DS_SCALE_OUT=<file>
// appends the measurements as one JSON line).
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { q } from "../db.js";
import { seedQ } from "./helpers/seedQ.js";
import { updateNode } from "../services/nodeUpdate.js";
import { planGenesis } from "../distributedSync/bridge/index.js";
import { materialize } from "../distributedSync/materialize.js";
import type { ActorCtx } from "../types.js";
import { RealCluster } from "./helpers/distSim/realCluster.js";
import { onNode } from "./helpers/distSim/realNode.js";

vi.setConfig({ testTimeout: 3 * 60 * 60 * 1000 });
const enabled = process.env.ONDEN_DB_DRIVER === "pglite" && isTestDatabase();
const NOTES = Number(process.env.DS_SCALE_NOTES ?? 40);
const EDITS = Number(process.env.DS_SCALE_EDITS ?? 3);
const ms = async <T>(fn: () => Promise<T>): Promise<[T, number]> => { const t = performance.now(); const r = await fn(); return [r, Math.round(performance.now() - t)]; };

let ws: string, alice: ActorCtx, bob: ActorCtx, team: string;
const ids: string[] = [];
async function seedWorld(): Promise<string> {
  ws = (await q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Scale',$1) RETURNING id", [randomUUID()])).rows[0]!.id;
  const person = async (name: string) => (await q<ActorCtx>("INSERT INTO actors(workspace_id,name,type) VALUES($1,$2,'human') RETURNING id,name,type", [ws, name])).rows[0]!;
  alice = await person("alice"); bob = await person("bob");
  team = (await seedQ<{ id: string }>("INSERT INTO spaces (workspace_id, name, kind) VALUES ($1,'team','shared') RETURNING id", [ws])).rows[0]!.id;
  for (const a of [alice, bob]) await seedQ("INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1,$2,'edit')", [team, a.id]);
  const body = Array.from({ length: 30 }, (_, i) => `line ${i} of a note about something`).join("\n");
  for (let i = 0; i < NOTES; i++) {
    const id = randomUUID();
    ids.push(id);
    await seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, space_id, parent_id)
                 VALUES ($1::uuid,$2,'manual','content',$3,$4,$5,$6, $7::uuid)`, [id, ws, `Note ${i}`, `note-${i}`, body, team, i > 0 && i % 5 !== 0 ? ids[i - (i % 5)]! : null]);
  }
  return ws;
}

describe.skipIf(!enabled)("cost at size", () => {
  let cluster: RealCluster | null = null;
  beforeAll(() => { process.env.ONDEN_DISTRIBUTED_SYNC = "1"; });
  afterEach(async () => { await cluster?.close(); cluster = null; });

  it(`${NOTES} notes x ${EDITS} edits: genesis, writes, level-up of a second node, fold`, async () => {
    const m: Record<string, number | string> = { notes: NOTES, editsPerNote: EDITS };
    const [c, openMs] = await ms(() => RealCluster.create(["A", "B"], seedWorld));
    cluster = c;
    m.openTwoNodesWithGenesisMs = openMs;
    const [plan, planMs] = await ms(() => onNode(cluster!.node("A").node, () => planGenesis(ws)));
    m.genesisOps = plan.ops.length; m.genesisPlanMs = planMs;

    const [, writeMs] = await ms(async () => {
      for (let e = 0; e < EDITS; e++) {
        for (let i = 0; i < NOTES; i++) {
          const line = (i * 7 + e * 3) % 30;
          await cluster!.on("A", async () => {
            const body = (await q<{ markdown: string }>("SELECT markdown FROM content_nodes WHERE id = $1", [ids[i]])).rows[0]!.markdown.split("\n");
            body[line] = `edit ${e} of note ${i}`;
            await updateNode(ws, ids[i]!, { markdown: body.join("\n") }, { actor: alice });
          });
        }
        if (process.env.DS_SCALE_OUT) appendFileSync(process.env.DS_SCALE_OUT + ".progress", `edit round ${e + 1}/${EDITS} done at ${new Date().toISOString()}\n`);
      }
    });
    m.localEdits = NOTES * EDITS; m.localEditsWithCaptureMs = writeMs; m.msPerEdit = Math.round((writeMs / (NOTES * EDITS)) * 10) / 10;
    const ops = await cluster.ops("A");
    m.dsOpsAtA = ops.length; m.opsFromA = ops.filter((o) => o.origin === "A").length;

    const [, syncMs] = await ms(() => cluster!.quiesce("mesh", Math.ceil((NOTES * EDITS * 1.1) / 100) + 20));
    m.bringBLevelMs = syncMs;
    expect(await cluster.checkConverged()).toEqual([]);
    m.dsOpsAtB = (await cluster.ops("B")).length;

    const [, foldMs] = await ms(async () => materialize(ops));
    m.foldAllOpsMs = foldMs; m.foldedOps = ops.length;
    const [, coldMs] = await ms(async () => onNode(cluster!.node("B").node, async () => { const r = await (await import("../distributedSync/bridge/index.js")).Replica.open({ workspaceId: ws, nodeId: "B", directory: { A: [alice.id, bob.id] } }); return r.node.world(); }));
    m.openNodeColdFromTablesMs = coldMs;
    if (process.env.DS_SCALE_OUT) appendFileSync(process.env.DS_SCALE_OUT, JSON.stringify(m) + "\n");
    expect(m.dsOpsAtA).toBe(m.dsOpsAtB);
  });
});
