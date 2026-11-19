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
import { PROPS_SEED } from "./helpers/propsConfig.js";

const enabled = process.env.ONDEN_DB_DRIVER === "pglite" && isTestDatabase();
const SEEDS = Number(process.env.DS_REAL_SEEDS ?? 3);
const STEPS = Number(process.env.DS_REAL_STEPS ?? 40);
// Seeds are fresh every run (PROPS_SEED, PROPS_SEED+1, …; owner 2026-11-18 「種子都隨機」); counts and steps unchanged.
// One seed alone: PROPS_SEED=<seed> DS_REAL_SEEDS=1 (the star = mesh plan then uses that seed too).
const replay = (seed: number) => `replay: PROPS_SEED=${seed} DS_REAL_SEEDS=1 DS_REAL_STEPS=${STEPS} ONDEN_DB_DRIVER=pglite DATABASE_URL=postgres://x@localhost/onden_cloud_test npm -w packages/backend exec vitest -- run src/test/distributedSyncRealSim.integration.test.ts`;
// Fresh seeds found several disagreements (the FINDINGs below, for note-91). The random runs keep the full workload: leaving out
// trash, then move, still left other kinds (K3, K4), so an exclusion would have cut most of the coverage. A fresh seed can therefore
// be red until note-91's line fixes them; the pinned cases are the shrunk reproductions.
const NO_TRASH: Action[] = CONTENT_ACTIONS.filter((a) => a !== "trash");
const NO_TRASH_OR_MOVE: Action[] = NO_TRASH.filter((a) => a !== "move");
if (enabled) console.log(`[distributed sync real] seeds ${PROPS_SEED}..${PROPS_SEED + SEEDS - 1}, star = mesh plan ${PROPS_SEED}`);

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

  async function run(seed: number, topology: "mesh" | "star", actions: Action[], withMembers: boolean, steps = STEPS) {
    const rng = makeRng(seed);
    const ids = ["A", "B", "C"];
    cluster = await RealCluster.create(ids, seedWorld, { rng, faults: { drop: 0.1, duplicate: 0.1 } });
    const done: Record<string, number> = {};
    for (let step = 0; step < steps; step++) {
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

  /** Nodes converge, tables match the engine, and /api/sync ships every person the same notes on every node: what the engine says they can read. */
  async function expectAgreement(seed: number, done: Record<string, number>, why = replay(seed)) {
      const failures = await cluster!.checkConverged();
      if (failures.length && process.env.DS_DEBUG) {
        const fs = await import("node:fs");
        const id = /note ([0-9a-f-]{36})/.exec(failures[0]!)?.[1];
        const node = /\((?:tables|projection)\) (\w):/.exec(failures[0]!)?.[1] ?? "A";
        const ev = await cluster!.on(node, async () => (await q<{ id: string; event_type: string; actor_id: string; payload: unknown; tx_meta: unknown }>("SELECT id, event_type, actor_id, payload, tx_meta FROM domain_events WHERE target_id = $1 OR payload->>'parent_id' = $1 ORDER BY id", [id])).rows);
        const ops = (await cluster!.ops(node)).filter((o) => JSON.stringify(o.body).includes(id!));
        fs.writeFileSync(process.env.DS_DEBUG, JSON.stringify({ failures, ev, ops: ops.map((o) => [o.id, o.hlc, o.author.slice(0, 4), o.body]) }, null, 1));
      }
      expect(failures, `${JSON.stringify(done)}\n${why}`).toEqual([]);
      const world = await cluster!.on("A", async () => cluster!.node("A").replica.node.world());
      for (const person of cast.people) {
        const [a, b, c] = [await clientNodes(cluster!, "A", person), await clientNodes(cluster!, "B", person), await clientNodes(cluster!, "C", person)];
        expect(b, `${person.name} B vs A; ${why}`).toEqual(a);
        expect(c, `${person.name} C vs A; ${why}`).toEqual(a);
        const expected = [...world.notes.values()].filter((n) => n.kind === "content" && !n.deleted && canRead(world, n.space, person.id)).map((n) => n.id).sort();
        expect(a.map((n) => n.id), `${person.name}: what /api/sync ships vs what the engine says is readable; ${why}`).toEqual(expected);
      }
  }

  for (let i = 0; i < SEEDS; i++) {
    const seed = PROPS_SEED + i;
    it(`seed ${seed}: nodes converge, tables match the engine, /api/sync agrees (members change too)`, async () => {
      await expectAgreement(seed, await run(seed, "mesh", CONTENT_ACTIONS, true));
    });
  }

  // FINDINGs from fresh seeds (#1881, 2026-11-18; for note-91, whose line fixes the merge core). Each is the shortest prefix of a
  // 40-step run that still fails (same seed, fewer steps: the generator draws the same actions in the same order). All of them trash a note.
  //   K1 the tables of some nodes hold a trashed note as deleted while the engine holds it live ("(tables) X: note …: deleted true vs false").
  //   K2 the engine says a person can read a note whose parent was trashed, and /api/sync does not ship it.
  //   K3 (found without trash) concurrent moves, and node B's projection refuses one ("capture note.move: cycle").
  //   K4 (found without trash or move) a note is live in node C's tables but not in the engine; the run has many refused steps.
  // Each turns red once fixed: then delete it.
  const FINDINGS: Array<[string, number, number, Action[]]> = [
    ["K1 tables keep a trashed note deleted, the engine has it live", 1343469786, 7, CONTENT_ACTIONS],
    ["K1 tables keep a trashed note deleted, the engine has it live", 2109103540, 9, CONTENT_ACTIONS],
    ["K2 /api/sync leaves out a readable note under a trashed parent", 2109103542, 6, CONTENT_ACTIONS],
    ["K2 /api/sync leaves out a readable note under a trashed parent", 1343469784, 13, CONTENT_ACTIONS],
    ["K3 concurrent moves: a node's projection refuses a move as a cycle (no trash)", 1197261253, 18, NO_TRASH],
    ["K4 a note live in one node's tables is not in the engine (no trash, no move)", 1876950368, 33, NO_TRASH_OR_MOVE],
  ];
  for (const [what, seed, steps, actions] of FINDINGS) {
    it.fails(`FINDING ${what}: seed ${seed}, ${steps} steps`, async () => {
      await expectAgreement(seed, await run(seed, "mesh", actions, true, steps), `pinned case: seed ${seed}, ${steps} steps, actions ${actions.join(",")}`);
    });
  }

  /** Rounds: every node acts alone for a few steps on what it holds, then everything is exchanged. The plan (who does what) comes from its
   *  own generator and every node holds the same state at the start of a round, so the two topologies run the very same plan. */
  async function runRounds(seed: number, topology: "mesh" | "star", actions: Action[]) {
    const plan = makeRng(seed);
    const ids = ["A", "B", "C"];
    cluster = await RealCluster.create(ids, seedWorld, { rng: makeRng(seed + 1000) });
    let serial = 0;
    for (let round = 0; round < Math.max(2, Math.floor(STEPS / 12)); round++) {
      for (const id of ids) for (let i = 0; i < 4; i++) await act(cluster, cast, id, plan, serial++, actions);
      await cluster.quiesce(topology);
    }
  }

  /** One plan run twice, star then mesh: both must converge and end in the same state (modulo the ids each run minted). */
  async function expectStarIsMesh(plan: number, actions: Action[], why: string) {
    const results: string[] = [];
    for (const topology of ["star", "mesh"] as const) {
      await runRounds(plan, topology, actions);
      expect(await cluster!.checkConverged(), `${topology}; ${why}`).toEqual([]);
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
    expect(differing, why).toEqual([]);
    expect(results[0], why).toBe(results[1]);
  }

  it("star and mesh end in the same state for one plan (the server is not special)", () => expectStarIsMesh(PROPS_SEED, CONTENT_ACTIONS, replay(PROPS_SEED)));
  // FINDINGs (fresh seeds, for note-91), 3 rounds each: plan 2109103540 ends with note "seed 0" under a parent in star and at the top
  // in mesh; plan 1994406918 (no trash, no move) ends with one note's two tags in a different order (maybe order only, maybe more).
  it.fails("FINDING star and mesh end with a different parent: plan 2109103540", () => expectStarIsMesh(2109103540, CONTENT_ACTIONS, "pinned plan 2109103540"));
  it.fails("FINDING star and mesh end with a note's tags in a different order: plan 1994406918 (no trash, no move)", () => expectStarIsMesh(1994406918, NO_TRASH_OR_MOVE, "pinned plan 1994406918"));
});
