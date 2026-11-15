// Random bursts of calls against lib/afterPause.ts (scan 01 #8: the phone bar re-parsed the whole note on every key).
// Invariants: one run per burst, never before the pause, never after cancel; a quiet period of `ms` always yields a run.
//
// Replay: PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/afterPause

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { afterPause } from "../../lib/afterPause";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";

const params = { numRuns: PROPS_RUNS, seed: PROPS_SEED };
const MS = 250;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("afterPause (scan 01 #8)", () => {
  it("a burst of keystrokes closer together than the pause costs one run, after the last", () => {
    const run = vi.fn();
    const pause = afterPause(run, MS);
    for (let i = 0; i < 100; i++) { pause.schedule(); vi.advanceTimersByTime(MS - 1); }
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("random gaps: runs = number of gaps of at least the pause (plus the final one), and cancel leaves none pending", () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 600 }), { minLength: 1, maxLength: 30 }), fc.boolean(), (gaps, cancelAtEnd) => {
      const run = vi.fn();
      const pause = afterPause(run, MS);
      let expected = 0;
      gaps.forEach((gap, i) => {
        pause.schedule();
        const last = i === gaps.length - 1;
        if (last) { if (cancelAtEnd) pause.cancel(); else expected++; } else if (gap >= MS) expected++;
        vi.advanceTimersByTime(last ? MS * 2 : gap);
      });
      expect(run).toHaveBeenCalledTimes(expected);
      expect(vi.getTimerCount()).toBe(0);
    }), params);
  });
});
