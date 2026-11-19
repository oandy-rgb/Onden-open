// Distributed sync (beta): the simulation bench. N nodes, each with its own PGlite, a network that drops, duplicates,
// delays and reorders, nodes that lose power, and random edits. Doc: docs/architecture/distributed-sync.md §8.
//   npm test -- distributedSyncSimulator                      12 fresh seeds (PROPS_SEED, PROPS_SEED+1, …; new every run, printed)
//   DS_SEEDS=200 DS_STEPS=250 npm test -- distributedSyncSimulator   a longer soak
//   DS_SEED=17 …                                             replay one seed (prints the shrunk step list on failure)
//   PROPS_SEED=<first> …                                     replay the whole set of a run
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cluster } from "./helpers/distSim/cluster.js";
import { compareTopologies } from "./helpers/distSim/invariants.js";
import { makeRng } from "./helpers/distSim/rng.js";
import { describeStep, runScript, shrinkSteps } from "./helpers/distSim/run.js";
import { generateSteps } from "./helpers/distSim/workload.js";
import { PROPS_SEED } from "./helpers/propsConfig.js";

// Seeds are fresh every run (owner 2026-11-18 「種子都隨機」; note-91's conditions on #1881): counts and steps are unchanged.
const SEEDS = process.env.DS_SEED ? [Number(process.env.DS_SEED)] : Array.from({ length: Number(process.env.DS_SEEDS ?? 12) }, (_, i) => PROPS_SEED + i);
const STEPS = Number(process.env.DS_STEPS ?? 160);
const replay = (seed: number) => `replay: DS_SEED=${seed} DS_STEPS=${STEPS} npm -w packages/backend exec vitest -- run src/test/distributedSyncSimulator.test.ts`;
console.log(`[distributed sync] seeds ${SEEDS.join(", ")} (whole set: PROPS_SEED=${SEEDS[0]}; one: DS_SEED=<seed>)`);
const kinds: Record<string, number> = {}, invalid: Record<string, number> = {};
const totals = { conflicts: 0, seeds: 0, steps: 0, ops: 0, valid: 0, messages: 0, dropped: 0, duplicated: 0, crashes: 0, refusedLocally: 0, uncheckedInvalid: 0 };

let mesh: Cluster, star: Cluster;
beforeAll(() => { mesh = new Cluster("mesh"); star = new Cluster("star"); });
afterAll(async () => {
  await mesh.close(); await star.close();
  console.log(`[distributed sync] ${JSON.stringify(totals)}\n valid ops by kind ${JSON.stringify(kinds)}\n refused as invalid ${JSON.stringify(invalid)}`);
});

describe("convergence, history and permissions under a hostile network", () => {
  it.each(SEEDS)("seed %i (mesh)", async (seed) => {
    const steps = generateSteps(makeRng(seed), STEPS);
    const result = await runScript(mesh, seed, steps);
    if (result.failures.length) {
      const small = await shrinkSteps(mesh, seed, steps, {});
      throw new Error(`seed ${seed} failed:\n${result.failures.slice(0, 8).join("\n")}\nshrunk to ${small.length} of ${steps.length} steps:\n${small.map(describeStep).join("\n")}\n${replay(seed)}`);
    }
    totals.seeds += 1; totals.steps += steps.length; totals.ops += result.report!.opCount; totals.valid += result.report!.validCount;
    totals.messages += result.net.sent; totals.dropped += result.net.dropped; totals.duplicated += result.net.duplicated;
    totals.crashes += result.counts.crash ?? 0; totals.refusedLocally += result.counts.refused_locally ?? 0; totals.uncheckedInvalid += result.counts.unchecked_invalid ?? 0;
    totals.conflicts += result.report!.conflicts;
    for (const [k, n] of Object.entries(result.report!.byKind)) kinds[k] = (kinds[k] ?? 0) + n;
    for (const [k, n] of Object.entries(result.report!.invalid)) invalid[k] = (invalid[k] ?? 0) + n;
    expect(result.failures, replay(seed)).toEqual([]);
  }, 300_000);
});

// 業主 2026-11-01：「如果分散式的測試都沒問題，那有主伺服器就更沒問題了。」主伺服器是分散式的特例：
// the same plan, once with every device talking only to the server (star), once with devices talking to each other (mesh),
// must leave every node in exactly the same state. Phased: edits are made in groups with a full sync between groups, and clocks
// agree, so both runs make the same concurrent edits (what a node edits does not depend on how fast the network happened to be).
describe("the server is just one more node: star = mesh", () => {
  const STAR_SEEDS = SEEDS.slice(0, Number(process.env.DS_STAR_SEEDS ?? 8));
  let starTotals = 0;
  it.each(STAR_SEEDS)("seed %i", async (seed) => {
    const steps = generateSteps(makeRng(seed + 1000), STEPS);
    const opts = { phased: true, skew: false, drop: 0.2, duplicate: 0.15 };
    const a = await runScript(star, seed, steps, opts);
    const b = await runScript(mesh, seed, steps, opts);
    const why = `star = mesh, seed ${seed}; ${replay(seed)}`;
    expect([...a.failures, ...b.failures], why).toEqual([]);
    expect(compareTopologies(a.report!.digests, b.report!.digests), why).toEqual([]);
    // Not vacuous: something was actually merged, and both runs agree on the whole op set too.
    expect(a.report!.opCount, why).toBe(b.report!.opCount);
    expect(a.report!.validCount, why).toBeGreaterThan(20);
    starTotals += a.report!.validCount;
  }, 300_000);
  afterAll(() => console.log(`[star = mesh] ${STAR_SEEDS.length} plans, ${starTotals} valid ops compared`));
});
