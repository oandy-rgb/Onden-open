// Distributed sync step 2a, the shadow comparison: several COMPLETE backends, random activity through their real services, lossy
// network between them, then quiet. Every node's real tables must say what the engine derived, all nodes must agree, and what each
// person would be shipped by /api/sync's bootstrap must be the same on every node and be exactly what the engine says they can read.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 300_000 });
import { randomUUID } from "node:crypto";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { q } from "../db.js";
import { createSharedSpace, setMember } from "../services/spaces.js";
import { createNote } from "../services/noteCreate.js";
import { createTag } from "../services/tagHierarchy.js";
import { buildBootstrap } from "../services/sync/index.js";
import type { ActorCtx } from "../types.js";
import { canRead } from "../distributedSync/materialize.js";
import { RealCluster } from "./helpers/distSim/realCluster.js";
import { makeRng } from "./helpers/distSim/rng.js";
import { act, CONTENT_ACTIONS, uuidFrom, type Action, type Cast } from "./helpers/distSim/realWorkload.js";

const enabled = process.env.ONDEN_DB_DRIVER === "pglite" && isTestDatabase();
const SEEDS = Number(process.env.DS_REAL_SEEDS ?? 3);
const STEPS = Number(process.env.DS_REAL_STEPS ?? 40);

let cast: Cast;
async function seedWorld(): Promise<string> {
  const ws = (await q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Sim',$1) RETURNING id", [randomUUID()])).rows[0]!.id;
  const person = async (name: string) => (await q<ActorCtx>("INSERT INTO actors(workspace_id,name,type) VALUES($1,$2,'human') RETURNING id,name,type", [ws, name])).rows[0]!;
  const alice = await person("alice"), bob = await person("bob"), carol = await person("carol");
  const space = (await createSharedSpace(alice, ws, "team")).id;
  await setMember(alice, ws, space, bob.id, "edit");
  await setMember(alice, ws, space, carol.id, "edit");
  const tags = [(await createTag({ actor: alice, workspaceId: ws, name: "red" })).id, (await createTag({ actor: alice, workspaceId: ws, name: "blue" })).id];
  for (let i = 0; i < 3; i++) await createNote({ actor: alice, workspaceId: ws, id: uuidFrom(`seed-${i}`), title: `seed ${i}`, markdown: "a\nb\nc", spaceId: space, event: { uiContext: "seed" } });
  cast = { workspaceId: ws, people: [alice, bob, carol], owner: alice, space, tags };
  return ws;
}

async function clientNodes(cluster: RealCluster, node: string, actor: ActorCtx) {
  return cluster.on(node, async () => {
    const boot = await buildBootstrap(actor, cast.workspaceId, { slimBodies: false });
    return (boot.nodes as Array<Record<string, unknown>>).filter((n) => n.node_type === "content")
      .map((n) => ({ id: n.id as string, title: n.title as string, markdown: n.markdown as string, parent: (n.parent_id ?? null) as string | null, tags: ((n.label_tag_ids ?? []) as string[]).slice().sort() }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  });
}

describe.skipIf(!enabled)("real backends under random activity", () => {
  let cluster: RealCluster | null = null;
  beforeAll(() => { process.env.ONDEN_DISTRIBUTED_SYNC = "1"; });
  afterEach(async () => { await cluster?.close(); cluster = null; });

  async function run(seed: number, topology: "mesh" | "star", actions: Action[], withMembers: boolean) {
    const rng = makeRng(seed);
    const ids = ["A", "B", "C"];
    cluster = await RealCluster.create(ids, seedWorld, { rng, faults: { drop: 0.1, duplicate: 0.1 } });
    const done: Record<string, number> = {};
    for (let step = 0; step < STEPS; step++) {
      const kind = withMembers && rng.chance(0.08) ? "member" : undefined;
      const did = await act(cluster, cast, rng.pick(ids), rng, step, kind ? [kind] : actions);
      done[did] = (done[did] ?? 0) + 1;
      if (rng.chance(0.3)) {
        const [a, b] = rng.pick(cluster.edges(topology));
        await cluster.gossip(a, b);
        for (let i = 0; i < rng.int(6) + 1; i++) await cluster.deliverOne();
      }
    }
    await cluster.quiesce(topology);
    return done;
  }

  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`seed ${seed}: nodes converge, tables match the engine, /api/sync agrees (members change too)`, async () => {
      const done = await run(seed, "mesh", CONTENT_ACTIONS, true);
      const failures = await cluster!.checkConverged();
      if (failures.length && process.env.DS_DEBUG) {
        const fs = await import("node:fs");
        const id = /note ([0-9a-f-]{36})/.exec(failures[0]!)?.[1];
        const node = /\((?:tables|projection)\) (\w):/.exec(failures[0]!)?.[1] ?? "A";
        const ev = await cluster!.on(node, async () => (await q<{ id: string; event_type: string; actor_id: string; payload: unknown; tx_meta: unknown }>("SELECT id, event_type, actor_id, payload, tx_meta FROM domain_events WHERE target_id = $1 OR payload->>'parent_id' = $1 ORDER BY id", [id])).rows);
        const ops = (await cluster!.ops(node)).filter((o) => JSON.stringify(o.body).includes(id!));
        fs.writeFileSync(process.env.DS_DEBUG, JSON.stringify({ failures, ev, ops: ops.map((o) => [o.id, o.hlc, o.author.slice(0, 4), o.body]) }, null, 1));
      }
      expect(failures, JSON.stringify(done)).toEqual([]);
      const world = await cluster!.on("A", async () => cluster!.node("A").replica.node.world());
      for (const person of cast.people) {
        const [a, b, c] = [await clientNodes(cluster!, "A", person), await clientNodes(cluster!, "B", person), await clientNodes(cluster!, "C", person)];
        expect(b, `${person.name} B vs A`).toEqual(a);
        expect(c, `${person.name} C vs A`).toEqual(a);
        const expected = [...world.notes.values()].filter((n) => n.kind === "content" && !n.deleted && canRead(world, n.space, person.id)).map((n) => n.id).sort();
        expect(a.map((n) => n.id), `${person.name}: what /api/sync ships vs what the engine says is readable`).toEqual(expected);
      }
    });
  }

  /** Rounds: every node acts alone for a few steps on what it holds, then everything is exchanged. The plan (who does what) comes from its
   *  own generator and every node holds the same state at the start of a round, so the two topologies run the very same plan. */
  async function runRounds(seed: number, topology: "mesh" | "star") {
    const plan = makeRng(seed);
    const ids = ["A", "B", "C"];
    cluster = await RealCluster.create(ids, seedWorld, { rng: makeRng(seed + 1000) });
    let serial = 0;
    for (let round = 0; round < Math.max(2, Math.floor(STEPS / 12)); round++) {
      for (const id of ids) for (let i = 0; i < 4; i++) await act(cluster, cast, id, plan, serial++, CONTENT_ACTIONS);
      await cluster.quiesce(topology);
    }
  }

  it("star and mesh end in the same state for one plan (the server is not special)", async () => {
    const results: string[] = [];
    for (const topology of ["star", "mesh"] as const) {
      await runRounds(7, topology);
      expect(await cluster!.checkConverged(), topology).toEqual([]);
      // The two runs minted their own workspace, space, people and tag ids: compare modulo those.
      const view = (await cluster!.views()).A!;
      let text = JSON.stringify({ team: view.spaces[cast.space], notes: view.notes });
      const names: Array<[string, string]> = [[cast.workspaceId, "WS"], [cast.space, "SPACE"], ...cast.people.map((p, i) => [p.id, `P${i}`] as [string, string]), ...cast.tags.map((t, i) => [t, `T${i}`] as [string, string])];
      for (const [id, name] of names) text = text.split(id).join(name);
      const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, x]) => [k, canon(x)])) : v;
      // A deleted note's text is not kept in step (it cannot be edited in the trash): compare only that it is deleted.
      const parsed = JSON.parse(text) as { notes: Record<string, { deleted: boolean; title?: unknown; body?: unknown; parent?: unknown; tags?: unknown }> };
      for (const n of Object.values(parsed.notes)) if (n.deleted) { delete n.title; delete n.body; delete n.parent; delete n.tags; }
      results.push(JSON.stringify(canon(parsed)));
      await cluster!.close(); cluster = null;
    }
    const [star, mesh] = results.map((r) => JSON.parse(r) as { notes: Record<string, unknown> });
    const differing = Object.keys({ ...star!.notes, ...mesh!.notes }).filter((id) => JSON.stringify(star!.notes[id]) !== JSON.stringify(mesh!.notes[id]))
      .map((id) => ({ id, star: star!.notes[id], mesh: mesh!.notes[id] }));
    expect(differing).toEqual([]);
    expect(results[0]).toBe(results[1]);
  });
});
