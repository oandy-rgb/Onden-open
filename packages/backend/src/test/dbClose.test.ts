// dbClose.ts: the order of closing the database, with stand-in registrants (no database needed).
// The real registrants (dispatcher, outbox, periodic jobs) are covered by dispatcherClose*.integration.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, onBeforePoolEnd } from "../dbClose.js";
import { log } from "../logger.js";

const unregister: Array<() => void> = [];
const register = (name: string, drain: Parameters<typeof onBeforePoolEnd>[1]) => { unregister.push(onBeforePoolEnd(name, drain)); };
afterEach(() => { for (const off of unregister.splice(0)) off(); vi.useRealTimers(); vi.restoreAllMocks(); });

/** A registrant with a count of jobs; draining finishes them, then runs `afterDrain` (which may start work elsewhere). */
function worker(afterDrain: () => void = () => {}) {
  const state = { jobs: 0, done: 0 };
  const drain: Parameters<typeof onBeforePoolEnd>[1] = {
    pending: () => state.jobs,
    drain: async () => { await Promise.resolve(); state.done += state.jobs; state.jobs = 0; afterDrain(); },
  };
  return { state, drain, add: () => { state.jobs++; } };
}

describe("closing the database drains to a fixed point", () => {
  // A cascade (dispatcher) kicks an outbox pass while it is drained. Whichever registered first, the pass must be
  // done before the pool ends.
  it.each([
    ["the outbox registered first", true],
    ["the dispatcher registered first", false],
  ])("work queued from inside a drained job lands before the pool ends (%s)", async (_label, outboxFirst) => {
    const outbox = worker();
    const dispatcher = worker(() => outbox.add());
    dispatcher.add();
    if (outboxFirst) { register("outbox", outbox.drain); register("dispatcher", dispatcher.drain); }
    else { register("dispatcher", dispatcher.drain); register("outbox", outbox.drain); }

    let outboxDoneWhenPoolEnded = -1;
    await closeDatabase(async () => { outboxDoneWhenPoolEnded = outbox.state.done; });

    expect(dispatcher.state.done).toBe(1);
    expect(outboxDoneWhenPoolEnded).toBe(1);
  });

  it("a registrant that keeps feeding itself is reported by name, and the pool still ends", async () => {
    register("endless", { pending: () => 1, drain: async () => {} });
    const endPool = vi.fn(async () => {});
    await expect(closeDatabase(endPool)).rejects.toThrow(/"endless" still had work/);
    expect(endPool).toHaveBeenCalledOnce();
  });
});

describe("closing the database when a drain fails", () => {
  it("the pool still ends and the caller gets the drain's error", async () => {
    const boom = new Error("drain failed");
    register("failing", { pending: () => 1, drain: async () => { throw boom; } });
    const endPool = vi.fn(async () => {});
    await expect(closeDatabase(endPool)).rejects.toBe(boom);
    expect(endPool).toHaveBeenCalledOnce();
  });
});

describe("closing the database when work never finishes", () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it("stops waiting at the limit, says so in one log line, and ends the pool", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    register("stuck", { pending: () => 3, drain: () => new Promise<void>(() => {}) });
    const endPool = vi.fn(async () => {});

    const closing = closeDatabase(endPool);
    await vi.advanceTimersByTimeAsync(5_000 - 1);
    expect(endPool).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await closing;

    expect(endPool).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![1])).toContain("3 in stuck");
  });
});

describe("telling the test run what closing waited for", () => {
  it("logs the test file and the number of jobs when there were some, and nothing when there were none", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    await closeDatabase(async () => {});
    expect(warn).not.toHaveBeenCalled();

    const w = worker();
    register("busy", w.drain);
    w.add(); w.add();
    await closeDatabase(async () => {});
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![1])).toMatch(/waited for 2 background job\(s\) in dbClose\.test\.ts/);
  });
});
