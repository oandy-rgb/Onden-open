import { afterEach, describe, expect, it, vi } from "vitest";
import { startPeriodicJob, stopAllPeriodicJobs } from "../backgroundJobs.js";

afterEach(() => {
  stopAllPeriodicJobs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("startPeriodicJob", () => {
  it("runs each interval, and once at runFirstAfterMs", async () => {
    vi.useFakeTimers();
    const run = vi.fn();
    startPeriodicJob({ name: "t-run", everyMs: 1000, runFirstAfterMs: 100 }, run);
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("waits a full interval when runFirstAfterMs is omitted, and runs at once for 0", async () => {
    vi.useFakeTimers();
    const wait = vi.fn(), now = vi.fn();
    startPeriodicJob({ name: "t-wait", everyMs: 1000 }, wait);
    startPeriodicJob({ name: "t-now", everyMs: 1000, runFirstAfterMs: 0 }, now);
    await vi.advanceTimersByTimeAsync(0);
    expect(wait).not.toHaveBeenCalled();
    expect(now).toHaveBeenCalledTimes(1);
  });

  it("logs a failing run and keeps ticking", async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi.fn().mockRejectedValue(new Error("boom"));
    startPeriodicJob({ name: "t-fail", everyMs: 1000 }, run);
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(err.mock.calls[0]?.[0]).toContain("[t-fail] periodic job failed");
  });

  it("starts a name once and stops cleanly", async () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const a = startPeriodicJob({ name: "t-once", everyMs: 1000 }, run);
    expect(startPeriodicJob({ name: "t-once", everyMs: 1000 }, vi.fn())).toBe(a);
    a.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).not.toHaveBeenCalled();
    expect(startPeriodicJob({ name: "t-once", everyMs: 1000 }, run)).not.toBe(a);
  });
});
