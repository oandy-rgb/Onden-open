// Run a step list against a cluster and check it; cut a failing list down.
import type { OpId } from "../../../distributedSync/types.js";
import { Cluster, DEVICES, HUB, Violation, type Topology } from "./cluster.js";
import { checkDistributedInvariants, type Report } from "./invariants.js";
import { makeRng } from "./rng.js";
import { runStep, setupWorld, type Step } from "./workload.js";

export type RunResult = { failures: string[]; report?: Report; counts: Record<string, number>; net: Cluster["net"]["stats"]; rounds: number; steps: number };

/** `phased` = the star/mesh comparison mode: local ops only happen inside "phases" separated by full syncs, so both topologies
 *  see the same concurrent edits (what an edit is based on does not depend on how fast the network is). */
export async function runScript(c: Cluster, seed: number, steps: Step[], opts: { drop?: number; duplicate?: number; phased?: boolean; skew?: boolean } = {}): Promise<RunResult> {
  const rng = makeRng(seed ^ 0x9e3779b9);
  await c.start(rng, { drop: opts.drop ?? 0.15, duplicate: opts.duplicate ?? 0.1 }, { skew: opts.skew });
  const counts: Record<string, number> = {};
  const localOk = new Set<OpId>();
  const failures: string[] = [];
  let rounds = 0;
  try {
    await setupWorld(c);
    c.net.faults = { drop: opts.drop ?? 0.15, duplicate: opts.duplicate ?? 0.1 };
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      if (opts.phased && step.t !== "op" && step.t !== "tick") continue; // phased runs sync only at phase ends
      const before = step.t === "op" ? (await c.node(step.node).ops()).length : 0;
      const what = await runStep(c, step, i);
      counts[what] = (counts[what] ?? 0) + 1;
      if (step.t === "op" && what !== "refused_locally" && what !== "skipped") {
        const ops = await c.node(step.node).ops();
        if (ops.length > before) localOk.add(`${step.node}:${ops.filter((o) => o.origin === step.node).length}`);
      }
      if (opts.phased && step.t === "op" && (i + 1) % 12 === 0) await c.quiesce();
    }
    rounds = await c.quiesce();
    const report = await checkDistributedInvariants(c, localOk);
    return { failures: report.failures, report, counts, net: { ...c.net.stats }, rounds, steps: steps.length };
  } catch (e) {
    failures.push(e instanceof Violation ? `violation: ${e.message}` : `exception: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    return { failures, counts, net: { ...c.net.stats }, rounds, steps: steps.length };
  }
}

/** Remove steps (halves first, then one by one) while the run still fails; returns the smallest list found. */
export async function shrinkSteps(c: Cluster, seed: number, steps: Step[], opts: Parameters<typeof runScript>[3], budget = 40): Promise<Step[]> {
  let best = steps;
  let tries = 0;
  const stillFails = async (candidate: Step[]) => { tries += 1; return (await runScript(c, seed, candidate, opts)).failures.length > 0; };
  for (let size = Math.floor(best.length / 2); size >= 1 && tries < budget; size = Math.floor(size / 2)) {
    for (let start = 0; start < best.length && tries < budget; start += size) {
      const candidate = [...best.slice(0, start), ...best.slice(start + size)];
      if (candidate.length && (await stillFails(candidate))) { best = candidate; start -= size; }
    }
  }
  return best;
}

export const describeStep = (s: Step): string => JSON.stringify(s);
export { DEVICES, HUB };
export type { Topology };
