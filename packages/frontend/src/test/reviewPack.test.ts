import { describe, it, expect } from "vitest";
import { STARTER_PACKS } from "../data/starterPacks";
import reviewPack from "../data/packs/review.tagpack.json";

// The #review pack is no longer a template (the module library's Review
// module creates #複習), but packs carrying it still install. These pin its
// shape and keep its behaviour.review in lockstep with the backend's
// reviewBehaviourFromSchema (reviewBehaviour.test).
describe("review starter pack", () => {
  it("is not offered as a template: the module library provides #複習", () => {
    expect(STARTER_PACKS.find((p) => p.pack === reviewPack)).toBeUndefined();
    expect(STARTER_PACKS.map((p) => p.label)).toEqual(["📚 Book", "👥 Person", "🗓 Meeting", "🚀 Project"]);
  });

  it("imports as the #review capability tag with the module binding", () => {
    expect(reviewPack.name).toBe("review");          // = REVIEW_TAG_NAME (backend)
    expect(reviewPack.modules).toEqual(["review"]);  // declares its automation module
    expect(reviewPack._format).toBe("onden.tagpack/v1");
  });

  it("carries scheduler config the backend reads from behaviour.review", () => {
    const r = reviewPack.behaviour.review;
    expect(r.request_retention).toBe(0.9);
    expect(r.maximum_interval_days).toBe(365);
    expect(r.new_per_day).toBe(15);
    // Within the backend clamp envelope so nothing is silently coerced.
    expect(r.request_retention).toBeGreaterThanOrEqual(0.7);
    expect(r.request_retention).toBeLessThanOrEqual(0.97);
    expect(r.new_per_day).toBeGreaterThanOrEqual(0);
    expect(r.new_per_day).toBeLessThanOrEqual(500);
  });
});
