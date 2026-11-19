import fc from "fast-check";

/**
 * `fc.assert` for the sync simulators, which stop after a time limit: a run that ended early and had no failure
 * did NOT test what its name says (owner 2026-11-18 asked for more rounds each run), so it fails and says how many
 * rounds it got through. Failing rather than warning: a warning in a CI log nobody reads is the silent under-run
 * this exists to end. Lower `numRuns` (SYNC_SIM_RUNS) on purpose if the machine is too slow for it.
 * A failure keeps `counterexample` and the original error (`cause`) on the error, as `fc.assert` does.
 */
export async function assertAllRuns<T>(label: string, property: fc.IAsyncProperty<T>, params: fc.Parameters<T> & { numRuns: number }): Promise<void> {
  const details = await fc.check(property, params);
  console.log(`[${label}] ran ${details.numRuns} of ${params.numRuns} rounds${details.interrupted ? " (stopped by the time limit)" : ""}`);
  if (details.failed) throw Object.assign(new Error((await fc.asyncDefaultReportMessage(details)) ?? `${label} failed`, { cause: details.errorInstance }), { counterexample: details.counterexample });
  if (details.numRuns < params.numRuns) {
    throw new Error(`${label}: only ${details.numRuns} of ${params.numRuns} rounds ran${details.interrupted ? " before the time limit" : ""}; the test did not cover what it was set to. Lower the rounds on purpose (SYNC_SIM_RUNS) if this machine is too slow.`);
  }
}
