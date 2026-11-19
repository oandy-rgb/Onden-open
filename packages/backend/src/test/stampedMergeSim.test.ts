// The proof that the merge core converges: nodes make random local changes to stamped rows (spine/stampedMerge), exchange
// them over the engine's faulty network (drop, duplicate, delay, reorder, partition), and the checks of the brief run on
// what every node holds once everything has been delivered. Pure memory; no database.
//
//   STAMPED_SIM_SEEDS  seeds per scenario (default 5; the long run for the PR used 200)
//   STAMPED_SIM_STEPS  steps per run (default 100)
//   PROPS_SEED         the first seed (default: a fresh one every run, printed; the seeds are PROPS_SEED, PROPS_SEED+1, …).
//                      One failing seed alone: PROPS_SEED=<seed> STAMPED_SIM_SEEDS=1; the failure message prints the command.
//
// A failing run is cut down (halves, then one by one) and printed as the list of operations: structure only, never a
// note's text. Which invariant has how many seeds and steps, and how long it took, is printed at the end.
import { afterAll, describe, expect, it } from "vitest";
import { makeRng } from "./helpers/distSim/rng.js";
import { ADVERSARIAL, UNIFORM, generateStampedSteps, type Scenario } from "./helpers/stampedSim/scenarios.js";
import { ruleActivity, checkAgainstOracle, checkAlgebra, checkCausality, checkConvergence, checkGenesisValues, checkNoLoss, checkSystemLeavesConflicts, checkOrderFree, checkRules, checkSkew, describe as describeSteps, runStampedSim, shrinkFailing, type Checks, type RunOptions } from "./helpers/stampedSim/runner.js";
import type { StampedWorld } from "./helpers/stampedSim/world.js";
import type { Step } from "./helpers/stampedSim/domain.js";
import { INCLUDE_KNOWN, PROPS_SEED } from "./helpers/propsConfig.js";

const SEEDS = Number(process.env.STAMPED_SIM_SEEDS ?? 5), STEPS = Number(process.env.STAMPED_SIM_STEPS ?? 100);
const replay = (seed: number) => `replay: PROPS_SEED=${seed} STAMPED_SIM_SEEDS=1 STAMPED_SIM_STEPS=${STEPS} npm -w packages/backend exec vitest -- run src/test/stampedMergeSim.test.ts`;
console.info(`[stampedSim] seeds ${PROPS_SEED}..${PROPS_SEED + SEEDS - 1} per scenario (replay the set: PROPS_SEED=${PROPS_SEED})`);
/** The fixed follow-up checks below are cases chosen by hand (named seeds), not the random runs: those are `prove`'s fresh seeds. */
const fixedCase = (seed: number) => makeRng(seed);
const stats = new Map<string, { runs: number; steps: number; ms: number; failures: number }>();
const note = (key: string, steps: number, ms: number, failures: number) => {
  const s = stats.get(key) ?? { runs: 0, steps: 0, ms: 0, failures: 0 };
  stats.set(key, { runs: s.runs + 1, steps: s.steps + steps, ms: s.ms + ms, failures: s.failures + failures });
};
afterAll(() => {
  const lines = [...stats].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, s]) => `  ${k.padEnd(44)} seeds ${String(s.runs).padStart(4)}  steps ${String(s.steps).padStart(7)}  ${String(Math.round(s.ms)).padStart(7)} ms  failures ${s.failures}`);
  console.info(`[stampedSim] per invariant (seeds, total steps, time)\n${lines.join("\n")}`);
});

type Check = { key: string; run: (w: StampedWorld, seed: number) => string[]; which: Checks };
const CHECKS: Check[] = [
  { key: "1 convergence (all nodes identical)", which: "convergence", run: (w) => checkConvergence(w) },
  { key: "1 conflicts = writes nobody had seen (oracle)", which: "oracle", run: (w) => checkAgainstOracle(w) },
  { key: "1 values from before stamps are kept unless seen", which: "genesis", run: (w) => checkGenesisValues(w) },
  { key: "5 the system leaves a conflict to a person", which: "system", run: (w) => checkSystemLeavesConflicts(w) },
  { key: "1 convergence (any delivery order)", which: "orderFree", run: (w, seed) => checkOrderFree(w, makeRng(seed ^ 11)) },
  { key: "2 idempotent/commutative/associative", which: "algebra", run: (w, seed) => checkAlgebra(w, makeRng(seed ^ 22)) },
  { key: "3 no input lost", which: "noLoss", run: (w) => checkNoLoss(w) },
  { key: "4 causality", which: "causality", run: (w) => checkCausality(w) },
  { key: "5 clock skew", which: "skew", run: (w) => checkSkew(w) },
  { key: "6 cross-row rules", which: "rules", run: (w, seed) => checkRules(w, makeRng(seed ^ 33)) },
];

/** Run `SEEDS` seeds of a scenario and every check; on a failure cut the run down and put the structure in the message. */
async function prove(sc: Scenario, opts: Partial<RunOptions> = {}, scenarioKey = sc.name): Promise<Record<string, number>> {
  const activity: Record<string, number> = {};
  const o: RunOptions = { nodes: sc.nodes, authors: sc.authors, ...opts };
  for (let i = 0; i < SEEDS; i++) {
    const seed = PROPS_SEED + i;
    const steps = generateStampedSteps(makeRng(seed * 7919), sc, STEPS);
    const world = runStampedSim(seed, steps, o);
    for (const [k, n] of Object.entries(ruleActivity(world))) activity[k] = (activity[k] ?? 0) + n;
    for (const c of CHECKS) {
      const t = performance.now();
      const failures = c.run(world, seed);
      note(c.key, steps.length, performance.now() - t, failures.length);
      if (failures.length) {
        const small = await shrinkFailing(seed, steps, o, [c.which]);
        throw new Error(`${scenarioKey}, seed ${seed}, invariant ${c.key}:\n  ${small.failures.slice(0, 4).join("\n  ")}\n  smallest run (${small.steps.length} of ${steps.length} steps): ${describeSteps(small.steps)}\n  ${replay(seed)}`);
      }
    }
  }
  const row = [...Object.entries(activity)].filter(([, n]) => n > 0).map(([k, n]) => `${k}: ${n}`).join(", ");
  console.info(`[stampedSim] ${scenarioKey}: ${SEEDS} seeds; what the rules had to do: ${row || "nothing"}`);
  return activity;
}

describe("the merge converges (invariants 1–4, 6) under a faulty network", () => {
  it("uniform mix of every kind of change", () => prove(UNIFORM), 600_000);
  for (const sc of ADVERSARIAL) {
    it(`built to make one conflict: ${sc.name}`, async () => {
      const activity = await prove(sc);
      // The scenario is only evidence if it made the conflict it is named for.
      const key = Object.keys(activity).find((k) => sc.name.startsWith(k.split(" ")[0]!)) ?? "";
      // Known: "4.10 move cycles" makes no cycle in about half of all seeds, so 5 fresh seeds sometimes make none (the FINDING below).
      // Its invariants are still checked by `prove`; only this "did it make its conflict" check leaves it out (PROPS_INCLUDE_KNOWN=1 puts it back).
      const known = sc.name === "4.10 move cycles" && !INCLUDE_KNOWN;
      if (key && !known) expect(activity[key], `${sc.name} never produced its conflict in ${SEEDS} seeds (PROPS_SEED=${PROPS_SEED})`).toBeGreaterThan(0);
    }, 600_000);
  }
  // FINDING (#1881, fresh seeds; for note-91): the scenario built to make move cycles made none in 5 seeds in a row. Each seed makes a
  // cycle only about half the time (492 of 1000 seeds made none), so the old seeds 1..4 (each made one) hid it. Every invariant held:
  // this is a weak scenario, not a merge bug. Turns red once the scenario reliably makes its cycle; then drop `known` above.
  it.fails("FINDING 4.10 move cycles: seeds 1459829168..1459829172 (100 steps) make no move cycle", () => {
    const sc = ADVERSARIAL.find((x) => x.name === "4.10 move cycles")!;
    let cycles = 0;
    for (const seed of [1459829168, 1459829169, 1459829170, 1459829171, 1459829172]) {
      const world = runStampedSim(seed, generateStampedSteps(fixedCase(seed * 7919), sc, 100), { nodes: sc.nodes, authors: sc.authors });
      cycles += ruleActivity(world)["4.10 move cycle"] ?? 0;
    }
    expect(cycles).toBeGreaterThan(0);
  });
  it("heavy loss and duplication (40% / 30%)", () => prove(UNIFORM, { drop: 0.4, duplicate: 0.3 }, "uniform, heavy loss"), 600_000);
});

describe("clock skew (invariant 5)", () => {
  const sc: Scenario = { ...UNIFORM, nodes: 4, name: "skew" };
  const MIN = 60_000;
  it("nodes whose clocks differ by up to 9 minutes still converge, and nothing is refused", async () => {
    await prove(sc, { skewsMs: [0, 9 * MIN, 4 * MIN, 8 * MIN] }, "skew within the limit");
    const w = runStampedSim(3, generateStampedSteps(fixedCase(3), sc, STEPS), { nodes: 4, skewsMs: [0, 9 * MIN, 4 * MIN, 8 * MIN] });
    expect(w.nodes.flatMap((n) => [...n.refused, ...n.deferred.values()])).toEqual([]);
  }, 600_000);
  it("a node whose clock runs 30 minutes ahead is deferred by the others: they converge without it, and its writes wait (kept, not applied)", async () => {
    await prove({ ...sc }, { skewsMs: [0, 2 * MIN, 5 * MIN, 30 * MIN], rogue: [3] }, "skew over the limit (one node)");
    const w = runStampedSim(5, generateStampedSteps(fixedCase(5), sc, STEPS), { nodes: 4, skewsMs: [0, 2 * MIN, 5 * MIN, 30 * MIN], rogue: [3] });
    const waiting = w.nodes.filter((n) => n.honest).flatMap((n) => [...n.deferred.values()].flat());
    expect(waiting.length).toBeGreaterThan(0);
    expect(w.nodes.flatMap((n) => n.refused)).toEqual([]); // nothing is refused for good
  }, 600_000);
  it("a receiver whose clock is slow catches up: what was deferred is then taken, and every node ends the same, the fast one's writes included", async () => {
    const skews = [0, 25 * MIN, 3 * MIN, 12 * MIN];
    await prove({ ...sc }, { skewsMs: skews, catchUpMs: 40 * MIN }, "skew over the limit, receiver catches up");
    const w = runStampedSim(7, generateStampedSteps(fixedCase(7), sc, STEPS), { nodes: 4, skewsMs: skews, catchUpMs: 40 * MIN });
    expect(w.nodes.flatMap((n) => [...n.deferred.values()].flat())).toEqual([]);
    expect(w.writes.some((x) => x.node === "n1")).toBe(true);
  }, 600_000);
  it("the limit is a parameter: with 1 minute allowed, a 5-minute difference is refused", () => {
    const steps = generateStampedSteps(fixedCase(9), sc, STEPS) as Step[];
    const w = runStampedSim(9, steps, { nodes: 4, skewsMs: [0, 5 * MIN, 0, 0], maxSkewMs: MIN, rogue: [1] });
    expect(w.nodes.filter((n) => n.honest).some((n) => n.deferred.size > 0)).toBe(true);
  });
});
