// The timing helper the linear-time tests share (linearTiming.testing.ts): what it measures must not move with what other threads
// of the process, or other processes, are doing.
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { cpuMs, typicalMs, timed } from "./linearTiming.testing.js";

// A fixed amount of work, not a fixed wall time: on a busy runner a wall-time spin gets less CPU and every number here moves.
let sink = 0; // keeps the optimiser from deleting the loop
const work = (n: number) => { let x = 0; for (let i = 0; i < n; i++) x += Math.sqrt(i); sink += x; return x; };

/** A second thread that burns CPU, like V8's collector and compiler helper threads do in bursts. */
async function withBusyThread<T>(body: () => T): Promise<T> {
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker("const { workerData: f } = require('node:worker_threads'); Atomics.store(f, 0, 1); for (;;) {}", { eval: true, workerData: flag });
  try {
    while (Atomics.load(flag, 0) === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    return body();
  } finally { await worker.terminate(); }
}

describe("the CPU clock of the linear-time tests", () => {
  it.runIf(typeof process.threadCpuUsage === "function" && availableParallelism() >= 2)("counts this thread's work only: a busy second thread adds to the process's CPU time, not to the run's", async () => {
    const { process: processMs, thread } = await withBusyThread(() => {
      const startedProcess = process.cpuUsage(), startedThread = cpuMs();
      work(40_000_000);
      const used = process.cpuUsage(startedProcess);
      return { process: (used.user + used.system) / 1000, thread: cpuMs() - startedThread };
    });
    expect(processMs, "the process clock sees the other thread").toBeGreaterThan(thread * 1.2);
  });

  it("typicalMs() sizes its batch from the run and answers a finite, non-negative number", () => {
    // Not a timing assertion (the per-thread clock is only as fine as the kernel's accounting): it checks the batching runs the
    // function more than once for a tiny run, and once per batch (plus the sizing run) for a long one.
    let tinyCalls = 0, longCalls = 0;
    const tiny = typicalMs(() => { tinyCalls++; });
    const long = typicalMs(() => { longCalls++; work(30_000_000); }, 3);
    expect(tinyCalls).toBeGreaterThan(3 * 100);
    expect(longCalls).toBe(1 + 3);
    for (const ms of [tiny, long]) expect(Number.isFinite(ms) && ms >= 0).toBe(true);
    expect(timed(() => { work(1_000); })).toBeGreaterThanOrEqual(0);
  });
});
