import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { assertAllRuns } from "./helpers/syncSim/assertAllRuns.js";

describe("assertAllRuns", () => {
  const quiet = () => vi.spyOn(console, "log").mockImplementation(() => {});

  it("passes when every configured round ran", async () => {
    const log = quiet();
    await assertAllRuns("t", fc.asyncProperty(fc.nat(), async () => {}), { seed: 1, numRuns: 20 });
    expect(log).toHaveBeenCalledWith("[t] ran 20 of 20 rounds");
    log.mockRestore();
  });

  it("fails and names the count when the time limit cut the run short", async () => {
    const log = quiet();
    const slow = fc.asyncProperty(fc.nat(), async () => { await new Promise((r) => setTimeout(r, 30)); });
    await expect(assertAllRuns("t", slow, { seed: 1, numRuns: 500, interruptAfterTimeLimit: 100 })).rejects.toThrow(/only \d+ of 500 rounds ran before the time limit/);
    log.mockRestore();
  });

  it("still reports a real failure with its counterexample", async () => {
    const log = quiet();
    const bad = fc.asyncProperty(fc.nat(), async (n) => { if (n >= 0) throw new Error("boom"); });
    const error = await assertAllRuns("t", bad, { seed: 1, numRuns: 5 }).catch((e) => e);
    expect(error.cause.message).toBe("boom");
    expect(error.counterexample).toHaveLength(1);
    log.mockRestore();
  });
});
