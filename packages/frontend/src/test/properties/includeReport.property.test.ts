// 「一起發布」's failure message (modules/website/usePublishReview.ts reportIncluded): it says what the
// server said, one sentence per reason, never a code, and counts every refused note exactly once
// (round 2 of scan 13 中等 10: the text used to be one fixed sentence whatever the reason).
import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

const toasts = vi.hoisted(() => [] as string[]);
vi.mock("../../lib/appStore", async (original) => ({ ...await original<typeof import("../../lib/appStore")>(), addToast: (m: string) => { toasts.push(m); } }));

import { reportIncluded } from "../../modules/website/usePublishReview";

beforeEach(() => { toasts.length = 0; });

const reasons = ["hidden", "space_not_published", "not_a_page", "something_new"] as const;

describe("reportIncluded", () => {
  it("fixed: a hidden note and a trashed one each get their own sentence", () => {
    expect(reportIncluded({ failed: [{ noteId: "a", error: "hidden" }, { noteId: "b", error: "not_a_page" }] })).toBe(false);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain("1 notes could not be published together: they are hidden.");
    expect(toasts[0]).toContain("1 notes could not be published together: they are in the trash or no longer available.");
    expect(toasts[0]).not.toContain("space");
  });

  it("fixed: no failures says nothing and returns true", () => {
    expect(reportIncluded({ failed: [] })).toBe(true);
    expect(reportIncluded({ deduped: true })).toBe(true);
    expect(toasts).toEqual([]);
  });

  it("any mix of reasons: one toast, one sentence per distinct reason, counts add up, no code in the text", () => {
    fc.assert(fc.property(fc.array(fc.constantFrom(...reasons), { minLength: 1, maxLength: 12 }), (list) => {
      toasts.length = 0;
      expect(reportIncluded({ failed: list.map((error, i) => ({ noteId: `n${i}`, error })) })).toBe(false);
      expect(toasts).toHaveLength(1);
      const sentences = toasts[0]!.match(/\d+ notes could not be published together[^.]*\./g) ?? [];
      expect(sentences).toHaveLength(new Set(list).size);
      expect(sentences.reduce((sum, s) => sum + Number(s.match(/^\d+/)![0]), 0)).toBe(list.length);
      expect(toasts[0]).not.toMatch(/space_not_published|not_a_page|something_new|hidden\b.*_/);
    }), { numRuns: process.env.PROPS_RUNS ? Number(process.env.PROPS_RUNS) : 100 });
  });
});
