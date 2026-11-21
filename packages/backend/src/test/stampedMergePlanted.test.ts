// Does the simulator catch bugs? (owner, 2026-11-19: "a simulator only tests what its invariants say; plant known bugs and see whether it catches them.")
// Each test switches ONE known bug into the pure merge core (helpers/stampedPlanted/plants.ts, through vitest's module mock: no production code is changed),
// runs the simulator's own worlds and every check of stampedMergeSim.test.ts, plus the checks this file's PR added (helpers/stampedPlanted/checks.ts),
// with fresh seeds, and REQUIRES a check to fail within the stated number of seeds. With no bug switched on, the same file checks the real code.
//
//   STAMPED_PLANT_SEED  the first seed (default: a fresh random one, printed; give it back to replay a run)
//   STAMPED_SIM_STEPS   steps per run (default 100, as the simulator)
//   STAMPED_PLANT_BUDGET  seeds per bug instead of each one's own number (the PR's long run used 200 to say "not caught" with some weight)
//
// Which check caught which bug after how many seeds is printed at the end. Pure memory; no database.
import { randomInt } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type PlantId, headsWith, moveCycleCopy } from "./helpers/stampedPlanted/plants.js";

const plant = vi.hoisted(() => ({ bug: null as PlantId | null }));
vi.mock("../spine/stampedMerge/unit.js", async (original) => {
  const { plantedUnit } = await import("./helpers/stampedPlanted/plants.js");
  return plantedUnit(await original(), plant);
});
vi.mock("../spine/stampedMerge/store.js", async (original) => {
  const { plantedStore } = await import("./helpers/stampedPlanted/plants.js");
  return plantedStore(await original(), await import("../spine/stampedMerge/unit.js"), plant);
});
vi.mock("../spine/stampedMerge/rules/moveCycle.js", async (original) => {
  const { plantedMoveCycle } = await import("./helpers/stampedPlanted/plants.js");
  return plantedMoveCycle(await original(), plant, await import("../spine/stampedMerge/unit.js"));
});
vi.mock("../spine/stampedMerge/body.js", async (original) => {
  const { plantedBody } = await import("./helpers/stampedPlanted/plants.js");
  return plantedBody(await original(), plant);
});

import { makeRng } from "./helpers/distSim/rng.js";
import { ADVERSARIAL, UNIFORM, generateStampedSteps, type Scenario } from "./helpers/stampedSim/scenarios.js";
import { checkAgainstOracle, checkAlgebra, checkCausality, checkConvergence, checkGenesisValues, checkNoLoss, checkOrderFree, checkRules, checkSkew, checkSystemLeavesConflicts, type RunOptions } from "./helpers/stampedSim/runner.js";
import type { StampedWorld } from "./helpers/stampedSim/world.js";
import { linksOf } from "./helpers/stampedSim/domain.js";
import { bodyThreeTextsBreaks, checkArrivals, checkBodyNoBase, checkMalformedRefused, checkMoveFixes, moveFixBreaks, checkAcrossDeletes, genesisNamingBreaks, runAccounted } from "./helpers/stampedPlanted/checks.js";
import { sha256Hex } from "../utils.js";
import { canonical, type Cell } from "../spine/stampedMerge/unit.js";

const BASE = Number(process.env.STAMPED_PLANT_SEED ?? randomInt(1, 2 ** 30));
const STEPS = Number(process.env.STAMPED_SIM_STEPS ?? 100);
const BUDGET = process.env.STAMPED_PLANT_BUDGET ? Number(process.env.STAMPED_PLANT_BUDGET) : null;
console.info(`[stampedPlanted] first seed ${BASE} (STAMPED_PLANT_SEED=${BASE} replays this run)`);

type Check = { key: string; run: (w: StampedWorld, seed: number) => string[] };
/** The checks of stampedMergeSim.test.ts, with the same names. */
const EXISTING: Check[] = [
  { key: "convergence", run: (w) => checkConvergence(w) },
  { key: "oracle", run: (w) => checkAgainstOracle(w) },
  { key: "genesis", run: (w) => checkGenesisValues(w) },
  { key: "system", run: (w) => checkSystemLeavesConflicts(w) },
  { key: "orderFree", run: (w, seed) => checkOrderFree(w, makeRng(seed ^ 11)) },
  { key: "algebra", run: (w, seed) => checkAlgebra(w, makeRng(seed ^ 22)) },
  { key: "noLoss", run: (w) => checkNoLoss(w) },
  { key: "causality", run: (w) => checkCausality(w) },
  { key: "skew", run: (w) => checkSkew(w) },
  { key: "rules", run: (w, seed) => checkRules(w, makeRng(seed ^ 33)) },
];
/** The checks this file's PR added (helpers/stampedPlanted/checks.ts). */
const ADDED: Check[] = [
  { key: "arrivals (added)", run: (w) => checkArrivals(w) },
  { key: "bodyNoBase (added)", run: (w) => checkBodyNoBase(w) },
  { key: "malformedRefused (added)", run: (w, seed) => checkMalformedRefused(w, makeRng(seed ^ 44)) },
  { key: "moveFixes (added)", run: (w) => checkMoveFixes(w) },
  { key: "acrossDeletes (added)", run: (w) => checkAcrossDeletes(w) },
];
type Added = "arrivals (added)" | "bodyNoBase (added)" | "malformedRefused (added)" | "moveFixes (added)";

const MIN = 60_000;
/** Not in the simulator's list: a row made again over a permanent delete, with writes to fields the creation does not set (slug, published, trash). In the
 *  simulator's "row made again" scenario the creation sets every field it writes, so its own field writes cover what came before and `seen` never decides.
 *  Here it does, and the existing oracle and noLoss report "lost" for writes the README says a delete ends (they do not model deletes): on the real code they
 *  fail every few seeds. checkAcrossDeletes is the no-loss check for this scenario; oracle and noLoss are set aside for it. */
const REMADE_OTHER_FIELDS: Scenario = { name: "made again, fields the creation does not set", nodes: 4, burst: 4, meet: 0.1, mix: [["note.derived", 5], ["note.slug", 4], ["note.publish", 2], ["note.trash", 2], ["note.purge", 3], ["note.title", 1]] };
const byName = (name: string): Scenario => ADVERSARIAL.find((s) => s.name === name)!;
const SKEW: Scenario = { ...UNIFORM, nodes: 4, name: "skew" };
const ROGUE: Partial<RunOptions> = { skewsMs: [0, 2 * MIN, 5 * MIN, 30 * MIN], rogue: [3] };
const CATCH_UP: Partial<RunOptions> = { skewsMs: [0, 25 * MIN, 3 * MIN, 12 * MIN], catchUpMs: 40 * MIN };

type Found = { bug: string; seeds: number; existing: string[]; added: string[]; firstFailure: string };
const found: Found[] = [];
afterAll(() => {
  const lines = found.map((f) => `  ${f.bug.padEnd(40)} after ${String(f.seeds).padStart(3)} seed(s): ${f.existing.length ? `existing ${f.existing.join(", ")}` : "NOT caught by an existing check"}${f.added.length ? `; added ${f.added.join(", ")}` : ""}`);
  console.info(`[stampedPlanted] first seed ${BASE}\n${lines.join("\n")}`);
});

/** Run fresh seeds until an existing check fails (or `budget` seeds have run); say which checks failed, existing and added, on the first seed that failed. */
/** Run fresh seeds until an existing check fails (or, with `stopAt`, until that added check fails, unless STAMPED_PLANT_BUDGET asks for the whole budget). */
function hunt(bug: PlantId, sc: Scenario, opts: Partial<RunOptions>, budget: number, stopAt?: string): Found {
  plant.bug = bug;
  try {
    const o: RunOptions = { nodes: sc.nodes, authors: sc.authors, ...opts };
    let first: Found | null = null;
    for (let k = 0; k < budget; k++) {
      const seed = BASE + k;
      const w = runAccounted(seed, generateStampedSteps(makeRng(seed * 7919), sc, STEPS), o);
      const fails = (cs: Check[], world: StampedWorld) => cs.map((c) => ({ key: c.key, out: c.run(world, seed) })).filter((r) => r.out.length);
      let existing = fails(EXISTING, w), added = fails(ADDED, w);
      if (existing.length || added.length) {
        // a check counts only if the REAL code passes it on the same seed: checkNoLoss fails on the real code for about 1 uniform seed in 50 (a write a permanent
        // delete ended is not "lost"; the README's rule, which noLoss does not model; checkAcrossDeletes does), and such a seed proves nothing about the bug
        plant.bug = null;
        const real = runAccounted(seed, generateStampedSteps(makeRng(seed * 7919), sc, STEPS), o);
        const failsOnReal = new Set(fails([...EXISTING, ...ADDED], real).map((r) => r.key));
        plant.bug = bug;
        existing = existing.filter((r) => !failsOnReal.has(r.key)); added = added.filter((r) => !failsOnReal.has(r.key));
      }
      if (!first && (existing.length || added.length)) first = { bug, seeds: k + 1, existing: existing.map((r) => r.key), added: added.map((r) => r.key), firstFailure: [...existing, ...added][0]!.out[0]! };
      if (stopAt) {
        // a case that must be caught by an added check: an existing check that fires first (e and i2, rarely) does not end the hunt; the added one must fire within the budget
        if (added.some((r) => r.key === stopAt)) {
          const f: Found = { bug, seeds: k + 1, existing: [...new Set([...(first?.existing ?? []), ...existing.map((r) => r.key)])], added: added.map((r) => r.key), firstFailure: added.find((r) => r.key === stopAt)!.out[0]! };
          if (BUDGET === null) { found.push(f); return f; }
          first = first && first.added.includes(stopAt) ? first : f;
        } else if (existing.length && first) first = { ...first, existing: [...new Set([...first.existing, ...existing.map((r) => r.key)])] };
        continue;
      }
      if (existing.length) {
        const f = { bug, seeds: k + 1, existing: existing.map((r) => r.key), added: added.map((r) => r.key), firstFailure: existing[0]!.out[0]! };
        found.push(f);
        return f;
      }
    }
    const f = first ?? { bug, seeds: budget, existing: [], added: [], firstFailure: "" };
    found.push(f);
    return f;
  } finally { plant.bug = null; }
}

/** Run the checks on the REAL code over `seeds` fresh seeds: every failure is a finding. */
function realCode(sc: Scenario, opts: Partial<RunOptions>, seeds: number, checks: Check[]): string[] {
  const o: RunOptions = { nodes: sc.nodes, authors: sc.authors, ...opts };
  const out: string[] = [];
  for (let k = 0; k < seeds; k++) {
    const seed = BASE + 1000 + k;
    const w = runAccounted(seed, generateStampedSteps(makeRng(seed * 7919), sc, STEPS), o);
    for (const c of checks) for (const f of c.run(w, seed).slice(0, 2)) out.push(`seed ${seed}, ${c.key}: ${f}`);
  }
  return out;
}

describe("planted bugs: the simulator's checks must catch each one", () => {
  // `caughtBy`: the check that must be among those failing. "existing" = any check of stampedMergeSim.test.ts; a named added check = the existing checks
  // catch this bug rarely or never, which is why that check was added. The PR's long run (200 seeds each): e is first caught by an existing check (noLoss) on
  // the 32nd seed, i2 (by oracle) on the 50th, the malformed write (909) and the body copy dropped without a base not at all;
  // (an earlier count said 157 and 7: those were seeds where the REAL code fails noLoss too, which `hunt` now leaves out). These run their whole
  // budget only in the long run (STAMPED_PLANT_BUDGET); a normal run stops at the first seed the added check fails on.
  const cases: { bug: PlantId; promise: string; sc: Scenario; opts?: Partial<RunOptions>; budget: number; caughtBy: "existing" | Added }[] = [
    { bug: "a-only-winning-head", promise: "no value lost, a conflict is always shown", sc: byName("4.11 same field both sides"), budget: 10, caughtBy: "existing" },
    { bug: "b-saw-what-it-did-not", promise: "a conflict is never silently closed", sc: byName("4.11 same field both sides"), budget: 10, caughtBy: "existing" },
    { bug: "c-equal-content-asymmetric", promise: "the same writes give the same state on every node", sc: byName("4.5 derived ids made twice"), budget: 15, caughtBy: "existing" },
    { bug: "d-gate-after-take", promise: "a stamp too far ahead is deferred, not applied", sc: SKEW, opts: ROGUE, budget: 10, caughtBy: "existing" },
    { bug: "e-deferred-counted-received", promise: "a deferred write is offered again, never counted as received", sc: SKEW, opts: CATCH_UP, budget: 5, caughtBy: "arrivals (added)" },
    { bug: "f-system-settles-conflict", promise: "only a person's write ends a conflict", sc: byName("system writes beside a conflict"), budget: 15, caughtBy: "existing" },
    { bug: "g-recreate-drops-unseen", promise: "a write the deleter had not seen is never lost", sc: byName("row made again over a row that is there (purged, or only partly held)"), budget: 20, caughtBy: "existing" },
    { bug: "i1-real-write-replaces-every-genesis", promise: "a value from before stamps is kept unless seen", sc: byName("genesis values that differ"), budget: 10, caughtBy: "existing" },
    { bug: "i2-whole-unit-deferred", promise: "only the write that is too far ahead waits; the others of its unit are taken now", sc: SKEW, opts: ROGUE, budget: 5, caughtBy: "arrivals (added)" },
    { bug: "body-conflict-drops-offered", promise: "every line either side wrote is in the body or offered back", sc: byName("4.12 body on both sides"), budget: 15, caughtBy: "existing" },
    // the surviving mutants of the Stryker run judged real holes in the pure core, planted the same way (plants.ts names each by its mutant id)
    { bug: "m909-malformed-admitted-when-new", promise: "a malformed write is refused and changes nothing", sc: UNIFORM, budget: 5, caughtBy: "malformedRefused (added)" },
    { bug: "body-no-base-drops-copy", promise: "with no base, both copies are kept", sc: byName("4.12 body on both sides"), budget: 5, caughtBy: "bodyNoBase (added)" },
  ];
  for (const c of cases) {
    it(`${c.bug} (breaks: ${c.promise}): ${c.caughtBy === "existing" ? "an existing check" : c.caughtBy} fails within ${c.budget} seeds`, () => {
      const budget = BUDGET ?? c.budget;
      const f = hunt(c.bug, c.sc, c.opts ?? {}, budget, c.caughtBy === "existing" ? undefined : c.caughtBy);
      expect([...f.existing, ...f.added], `${c.bug}: no check failed in ${budget} seeds from ${BASE}`).not.toEqual([]);
      if (c.caughtBy === "existing") expect(f.existing, `${c.bug}: only the added checks failed in ${budget} seeds from ${BASE}`).not.toEqual([]);
      else expect(f.added, `${c.bug}: ${c.caughtBy} did not fail in ${budget} seeds from ${BASE}`).toContain(c.caughtBy);
    }, 300_000);
  }
});

describe("the deterministic checks this PR added catch their mutant, and pass on the real code", () => {
  it("values from before stamps: named as migration 205 names them, never two values with one name (mutants 1127–1132)", () => {
    expect(genesisNamingBreaks()).toEqual([]);
    // unit.ts genesisContent as mutant 1130 leaves it: every string has the same text
    const m1130 = (c: Cell) => `genesis:${sha256Hex(c.deleted ? "\u0000tombstone" : typeof c.value === "string" ? "" : `j:${canonical(c.value)}`)}`;
    // mutant 1128: strings named by their JSON
    const m1128 = (c: Cell) => `genesis:${sha256Hex(c.deleted ? "\u0000tombstone" : `j:${canonical(c.value)}`)}`;
    expect(genesisNamingBreaks(m1130).length).toBeGreaterThan(0);
    expect(genesisNamingBreaks(m1128).length).toBeGreaterThan(0);
  });
  it("rule 4.10 on a fixed case: a note that only leads INTO a loop keeps its place (mutant 388)", () => {
    const s = (n: number) => ({ origin: "n", seq: n, wall: 1_700_000_000_000 + n, counter: 0, author: "u", device: null });
    // b and c were moved under each other (a loop); a, which sorts first, was moved under b last of all: it is not part of the loop
    const links = [{ note: "a", parent: "b", from: null, stamp: s(9) }, { note: "b", parent: "c", from: null, stamp: s(2) }, { note: "c", parent: "b", from: null, stamp: s(3) }];
    expect(moveFixBreaks(links)).toEqual([]);
    plant.bug = "m388-move-undone-off-the-loop";
    try { expect(moveFixBreaks(links)).not.toEqual([]); } finally { plant.bug = null; }
  });
  it("a body with three different texts and no base: every text kept once (mutants 8 and 31)", () => {
    expect(bodyThreeTextsBreaks()).toEqual([]);
    for (const bug of ["m31-body-no-base-offers-oldest-only", "m8-body-equal-texts-offered"] as const) {
      plant.bug = bug;
      try { expect(bodyThreeTextsBreaks(), bug).not.toEqual([]); } finally { plant.bug = null; }
    }
  });
});

describe("the copies agree with the real functions (plants.ts copies a few lines where a mock cannot reach inside a module)", () => {
  it("headsWith with the real `covers` is unit.ts maximalHeads: on every unit the simulator sent, and on copies of one write with and without its value", async () => {
    const unit = await vi.importActual<typeof import("../spine/stampedMerge/unit.js")>("../spine/stampedMerge/unit.js");
    const units: Cell[][] = [];
    for (const sc of [UNIFORM, byName("genesis values that differ"), byName("4.11 same field both sides")]) {
      const w = runAccounted(BASE + 2000, generateStampedSteps(makeRng((BASE + 2000) * 7919), sc, STEPS), { nodes: sc.nodes, authors: sc.authors });
      for (const m of w.sent) for (const [, u] of m.items) units.push([...u]);
      for (const n of w.nodes) for (const u of n.store.values()) units.push([...u]);
    }
    const c = units.find((u) => u.some((x) => !unit.isGenesis(x)))!.find((x) => !unit.isGenesis(x))!;
    const bare: Cell = { ...c, valueless: true, value: null };
    units.push([c, bare], [bare, c], [bare]);
    expect(units.length).toBeGreaterThan(100);
    for (const u of units) expect(canonical(headsWith(unit, u, unit.covers))).toBe(canonical(unit.maximalHeads(u)));
  }, 120_000);
  it("moveCycleCopy without the mutant is rules/moveCycle.ts resolveMoveCycles, on the simulator's links and on random link sets", async () => {
    const unit = await vi.importActual<typeof import("../spine/stampedMerge/unit.js")>("../spine/stampedMerge/unit.js");
    const real = await vi.importActual<typeof import("../spine/stampedMerge/rules/moveCycle.js")>("../spine/stampedMerge/rules/moveCycle.js");
    const sets: Parameters<typeof real.resolveMoveCycles>[0][] = [];
    for (let k = 0; k < 3; k++) { const seed = BASE + 3000 + k; sets.push(linksOf(runAccounted(seed, generateStampedSteps(makeRng(seed * 7919), byName("4.10 move cycles"), STEPS), { nodes: 4 }).honest[0]!.store)); }
    const rng = makeRng(BASE + 4000), ids = ["a", "b", "c", "d", "e", "f"];
    for (let k = 0; k < 300; k++) sets.push(ids.slice(0, 2 + rng.int(5)).map((note, i, xs) => ({ note, parent: rng.chance(0.2) ? null : rng.pick(xs.filter((x) => x !== note)), ...(rng.chance(0.3) ? {} : { from: rng.chance(0.5) ? null : rng.pick(xs) }), stamp: { origin: `n${rng.int(3)}`, seq: i + 1, wall: 1_700_000_000_000 + rng.int(50), counter: 0, author: `u${rng.int(2)}`, device: null } })));
    for (const links of sets) expect(JSON.stringify(moveCycleCopy(unit, links, false), (_, v) => (v instanceof Map ? [...v] : v))).toBe(JSON.stringify(real.resolveMoveCycles(links), (_, v) => (v instanceof Map ? [...v] : v)));
  }, 120_000);
});

describe("the checks this PR added, on the real code (no bug planted)", () => {
  it("every arrival is accounted for: uniform, a fast node deferred for good, a slow receiver that catches up", () => {
    // checkAcrossDeletes is left out of every run on the real code: finding 1 (stampedMergeFindings.test.ts) fails it wherever permanent deletes and re-creations meet,
    // also in the simulator's own re-creation scenario (5 of 600 seeds measured; the existing oracle and noLoss fail on those seeds too). It is used to judge planted bugs,
    // where `hunt` only counts a check that the real code passes on the same seed, and in the findings themselves.
    const notAcross = ADDED.filter((c) => c.key !== "acrossDeletes (added)");
    const failures = [
      ...realCode(UNIFORM, {}, 2, notAcross),
      ...realCode(SKEW, ROGUE, 2, notAcross),
      ...realCode(SKEW, CATCH_UP, 2, notAcross),
      ...realCode(byName("row made again over a row that is there (purged, or only partly held)"), {}, 2, notAcross),
      ...realCode(byName("4.10 move cycles"), {}, 3, notAcross),
    ];
    expect(failures).toEqual([]);
  }, 300_000);
  // On this scenario the real code fails orderFree, algebra, causality (now and then: an overwritten value comes back) and acrossDeletes ("lost"):
  // stampedMergeFindings.test.ts, findings 1 and 2. oracle and noLoss report
  // losses there that the README calls the rule (see REMADE_OTHER_FIELDS). Every other check must hold.
  it("the scenario this PR added (made again over a delete, fields the creation does not set): every check that does not name a finding holds", () => {
    const notHere = ["oracle", "noLoss", "orderFree", "algebra", "causality", "acrossDeletes (added)"];
    expect(realCode(REMADE_OTHER_FIELDS, {}, 4, [...EXISTING, ...ADDED].filter((c) => !notHere.includes(c.key)))).toEqual([]);
  }, 300_000);
  it("a body on both sides with no base keeps both copies", () => {
    expect(realCode(byName("4.12 body on both sides"), {}, 3, ADDED.filter((c) => c.key !== "acrossDeletes (added)"))).toEqual([]);
  }, 300_000);
});
