// Ratchet: how many places let layout or behaviour follow the WINDOW, per screen (windowWidthDeps.ts says what counts).
// Side by side, rewritten as "a second page" (docs/architecture/proposals/panes-as-pages-2026-11-16.md), needs every
// screen to lay out from its own pane's width, so this number only goes down while that work proceeds.
// A new screen or a new rule reads its width from its own box: a container query, or the pane's size class — not
// `@media`, `vw`/`dvh`, `useIsMobile` or `innerWidth`. Where the window really is the answer (the phone shell, the
// on-screen keyboard, a full-window overlay), it is already in the baseline; do not add to it.
// When a number drops, lower it in window-width-deps-baseline.json (the second test), so it never keeps a hole open.
import { describe, expect, it } from "vitest";
import baseline from "./window-width-deps-baseline.json";
import { KINDS, windowWidthDeps, type Counts } from "./windowWidthDeps";

const allowed = baseline.groups as Record<string, Counts>;
const { groups } = windowWidthDeps();
const cells = (g: Record<string, Counts>) => Object.entries(g).flatMap(([group, c]) => KINDS.map((k) => [`${group}.${k}`, c[k]] as const));
const current = new Map(cells(groups));
const base = new Map(cells(allowed));

describe("window-width dependencies only go down", () => {
  it("has no screen with more window-bound rules than the baseline", () => {
    const more = [...current].filter(([key, n]) => n > (base.get(key) ?? 0)).map(([key, n]) => `${key}: ${n} (baseline ${base.get(key) ?? 0})`);
    expect(more, "read the width from the pane's own box (container query / size class); do not raise the baseline").toEqual([]);
  });

  it("has no baseline number above what is there now", () => {
    const stale = [...base].filter(([key, n]) => (current.get(key) ?? 0) < n).map(([key, n]) => `${key}: baseline ${n}, now ${current.get(key) ?? 0}`);
    expect(stale, "lower these in window-width-deps-baseline.json").toEqual([]);
  });
});
