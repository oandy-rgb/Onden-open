// The day a day page (今天, 日記) shows, over a random life of the page: the person picks days, the
// clock rolls to a new day while the page is open, the page is left and opened again
// (modules/daily/useShownDay.ts, with the same "kept pick" store the screens use).
//
// Invariants:
//  D1  a page that has no pick shows today, also after midnight passed while it was open (scan 10 #10);
//  D2  a pick is shown until another pick or until the page is opened on another day;
//  D3  picking today is the same as no pick: when the day rolls, the page follows;
//  D4  opening the page again the same day shows the last pick; on a later day, that day's today.
//
// Replay a failure:  PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/shownDay

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { act, renderHook } from "@testing-library/react";
import { addDays } from "@onden/markdown";
import { useShownDay } from "../../modules/daily/useShownDay";
import { pickedDay, rememberPickedDay } from "../../modules/daily/pickedDay";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";

type Op = { k: "pick"; by: number } | { k: "pickToday" } | { k: "midnight" } | { k: "reopen" };
const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ k: fc.constant("pick" as const), by: fc.integer({ min: -5, max: 5 }) }),
  fc.constant({ k: "pickToday" } as Op), fc.constant({ k: "midnight" } as Op), fc.constant({ k: "reopen" } as Op),
);

function play(ops: Op[]): void {
  rememberPickedDay("2026-01-01", "2026-01-01"); // forget any pick left by another case
  let today = "2026-11-14";
  let own: { date: string; madeOn: string } | null = null; // the model: the pick and the day it was made on
  const mount = () => renderHook(({ t }) => useShownDay(t, pickedDay, rememberPickedDay), { initialProps: { t: today } });
  let hook = mount();
  const steps: string[] = [];
  for (const o of ops) {
    steps.push(JSON.stringify(o) + ` today=${today}`);
    if (o.k === "pick") { const d = addDays(today, o.by); act(() => hook.result.current[1](d)); own = d === today ? null : { date: d, madeOn: today }; }
    else if (o.k === "pickToday") { act(() => hook.result.current[1](today)); own = null; }
    else if (o.k === "midnight") { today = addDays(today, 1); hook.rerender({ t: today }); }
    else { hook.unmount(); hook = mount(); if (own && own.madeOn !== today) own = null; } // a kept pick only lasts for the day it was made on
    expect(hook.result.current[0], steps.join("\n")).toBe(own?.date ?? today);
  }
  hook.unmount();
}

describe("the day a day page shows (random)", () => {
  it("shows the pick, else today; follows midnight when nothing is picked", () => {
    fc.assert(fc.property(fc.array(op, { minLength: 1, maxLength: 12 }), play), { numRuns: PROPS_RUNS, seed: PROPS_SEED });
  });

  it("named case: a page left open past midnight moves to the new day", () => {
    rememberPickedDay("2026-01-01", "2026-01-01");
    const hook = renderHook(({ t }) => useShownDay(t, pickedDay, rememberPickedDay), { initialProps: { t: "2026-11-14" } });
    expect(hook.result.current[0]).toBe("2026-11-14");
    hook.rerender({ t: "2026-11-15" });
    expect(hook.result.current[0]).toBe("2026-11-15");
  });

  it("named case: a picked day stays when midnight passes", () => {
    rememberPickedDay("2026-01-01", "2026-01-01");
    const hook = renderHook(({ t }) => useShownDay(t, pickedDay, rememberPickedDay), { initialProps: { t: "2026-11-14" } });
    act(() => hook.result.current[1]("2026-11-10"));
    hook.rerender({ t: "2026-11-15" });
    expect(hook.result.current[0]).toBe("2026-11-10");
  });
});
