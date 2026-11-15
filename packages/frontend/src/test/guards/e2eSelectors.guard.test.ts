// Guard: every class name and data-testid the e2e scripts look for exists in src/ (or is a library's own class).
// An e2e check on an element that is no longer rendered cannot fail (`toHaveCount(0)` is green forever; a click on it
// is skipped by `.catch(() => {})`), so such a script protects nothing. The `zz*` probes are not scanned: they only
// log values and live in e2e/probes/ (see its README).
// The ones that already do not match are in e2e-selectors-baseline.json, today's numbers: it can only shrink, and an
// entry that was fixed must be deleted from it (the second test), so it never keeps a hole open.
import { describe, expect, it } from "vitest";
import baseline from "./e2e-selectors-baseline.json";
import { asBaseline, deadSelectors, selectorsUsedBy } from "./e2eSelectors";

describe("e2e selectors point at something src/ renders", () => {
  const found = asBaseline(deadSelectors());
  const allowed = { ...baseline.classes, ...baseline.testIds } as Record<string, number>;
  const current = { ...found.classes, ...found.testIds } as Record<string, number>;

  it("has no dead class or data-testid beyond the baseline", () => {
    const newlyDead = Object.entries(current).filter(([key, n]) => n > (allowed[key] ?? 0)).map(([key, n]) => `${key} (${n}×)`);
    expect(newlyDead, "pick a selector the app renders now (a role or label is best); do not add to the baseline").toEqual([]);
  });

  it("lists nothing in the baseline that is live again or gone", () => {
    const stale = Object.entries(allowed).filter(([key, n]) => (current[key] ?? 0) < n).map(([key]) => key);
    expect(stale, "delete these entries from e2e-selectors-baseline.json").toEqual([]);
  });
});

describe("the selector reader", () => {
  const read = (text: string) => selectorsUsedBy("e2e/fullstack/x.spec.ts", text).map((u) => `${u.kind}:${u.name}`);
  it("takes classes from selector strings, with unions, descendants and attributes", () => {
    expect(read(`page.locator(".a-b .c_d > .e, button.f-g[aria-label='x.y']")`)).toEqual(["class:a-b", "class:c_d", "class:e", "class:f-g"]);
  });
  it("takes data-testid values from attribute selectors and getByTestId", () => {
    expect(read(`page.locator('[data-testid="row-1"]'); page.getByTestId("save")`)).toEqual(["testid:row-1", "testid:save"]);
  });
  it("ignores text, file names and interpolated names", () => {
    expect(read('page.locator("a", { hasText: "v1.2 notes.md" }); page.locator(`.item-${i}`)')).toEqual([]);
  });
});
