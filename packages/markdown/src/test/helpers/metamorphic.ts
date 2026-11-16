// Metamorphic testing on top of fast-check. A metamorphic test needs no model of the right answer: it
// checks a RELATION between the outputs for related inputs ("a shorter query finds at least what the
// longer one found"). Shared by the frontend and backend tests the way propsConfig is.
//
//   await metamorphic({
//     name: "MR-S1 …",
//     source: caseArbitrary,                  // what fast-check generates (and shrinks)
//     setup: async (input) => world,          // ONCE per input: build the data the relation asks about
//     relation: async (world, input) => null  // ok
//                                     | "why it is broken"
//                                     | SKIP("reason"),   // this input says nothing about the relation
//     minCompared: 0.5,                       // fraction of inputs that must really have compared
//     skipShare: { "reason": 0.2 },           // every reason a relation may skip with, and its largest share
//   });
//
// The relation runs as many related queries as it needs against the SAME world, so a related query is
// never answered by another set-up.
//
// Skips are the way a biased generator hides: a test where nine in ten cases skip proves little. So they
// are counted PER REASON and printed, a reason that has no stated share is an error, and one reason that
// accounts for more than its own share fails the test — however small the total looks. `minCompared`
// bounds the other side: the fraction of inputs that really compared.
//
// Seed and run count: PROPS_SEED / PROPS_RUNS (propsConfig.ts). A failure prints fast-check's shrunk
// counterexample and the line to replay it. `maxRuns` caps a slow world (a database, a browser stack);
// the report says when it did.

import fc from "fast-check";
import { PROPS_RUNS, PROPS_SEED } from "./propsConfig.js";

export type Skip = { readonly skipped: string };
/** This input says nothing about the relation (say why, in the words the budget uses). */
export const SKIP = (reason: string): Skip => ({ skipped: reason });
const isSkip = (value: unknown): value is Skip => typeof value === "object" && value !== null && "skipped" in value;

type Verdict = null | string | Skip;

export type MetamorphicSpec<Input, World> = {
  name: string;
  source: fc.Arbitrary<Input>;
  setup: (input: Input) => Promise<World> | World;
  relation: (world: World, input: Input) => Promise<Verdict> | Verdict;
  teardown?: (world: World) => Promise<void> | void;
  /** Fraction (0..1) of inputs that must have compared, not skipped. */
  minCompared: number;
  /** Every skip reason the relation may give, with the largest share (0..1) of all inputs it may account for. */
  skipShare: Record<string, number>;
  /** Cap on the runs of a slow world (the run count is min(PROPS_RUNS, maxRuns)). */
  maxRuns?: number;
};

export type MetamorphicReport = {
  name: string;
  runs: number;
  compared: number;
  skipped: Record<string, number>;
};

const percent = (part: number, whole: number): string => `${whole === 0 ? 0 : Math.round((1000 * part) / whole) / 10}%`;

export function describeReport(report: MetamorphicReport, capped: boolean): string {
  const skips = Object.entries(report.skipped).map(([reason, count]) => `    skipped ${count} (${percent(count, report.runs)}): ${reason}`);
  return [
    `[metamorphic] ${report.name}: ${report.runs} runs${capped ? " (capped by maxRuns)" : ""}, compared ${report.compared} (${percent(report.compared, report.runs)})`,
    ...skips,
  ].join("\n");
}

/** Run the relation over generated inputs. Throws on a broken relation, an unstated skip reason, a skip
 *  reason over its share, or too few inputs that compared. Returns the counts. */
export async function metamorphic<Input, World>(spec: MetamorphicSpec<Input, World>): Promise<MetamorphicReport> {
  const runs = Math.min(PROPS_RUNS, spec.maxRuns ?? Infinity);
  const counts = { total: 0, compared: 0, skipped: {} as Record<string, number> };
  const replay = `PROPS_SEED=${PROPS_SEED} PROPS_RUNS=${runs}`;
  const property = fc.asyncProperty(spec.source, async (input) => {
    const world = await spec.setup(input);
    try {
      const verdict = await spec.relation(world, input);
      counts.total++;
      if (isSkip(verdict)) {
        if (!(verdict.skipped in spec.skipShare)) throw new Error(`metamorphic: the relation skipped with "${verdict.skipped}", a reason skipShare does not state`);
        counts.skipped[verdict.skipped] = (counts.skipped[verdict.skipped] ?? 0) + 1;
        return;
      }
      if (typeof verdict === "string") throw new Error(verdict);
      counts.compared++;
    } finally {
      await spec.teardown?.(world);
    }
  });
  try {
    await fc.assert(property, { seed: PROPS_SEED, numRuns: runs });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // fast-check's message holds the shrunk input; what the relation said about it is the error's cause.
    const said = error instanceof Error && error.cause instanceof Error ? `\nthe relation: ${error.cause.message}` : "";
    throw new Error(`${detail}${said}\n\nreplay: ${replay}`, { cause: error });
  }
  const report: MetamorphicReport = { name: spec.name, runs: counts.total, compared: counts.compared, skipped: counts.skipped };
  process.stdout.write(`${describeReport(report, runs < PROPS_RUNS)}\n`);
  for (const [reason, count] of Object.entries(counts.skipped)) {
    const allowed = spec.skipShare[reason]!;
    if (count > allowed * counts.total) {
      throw new Error(`metamorphic ${spec.name}: ${count} of ${counts.total} runs skipped with "${reason}" (${percent(count, counts.total)}), more than the ${allowed * 100}% it may account for — the generator is biased away from what the relation checks\n\nreplay: ${replay}`);
    }
  }
  if (counts.compared < spec.minCompared * counts.total) {
    throw new Error(`metamorphic ${spec.name}: only ${counts.compared} of ${counts.total} runs compared (${percent(counts.compared, counts.total)}), the test needs ${spec.minCompared * 100}%\n\nreplay: ${replay}`);
  }
  return report;
}
