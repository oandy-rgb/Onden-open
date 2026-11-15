import { describe, expect, it } from "vitest";
import { intervalLabel } from "./intervalLabel";

describe("intervalLabel", () => {
  it("counts days up to a month, then months, then years", () => {
    expect(intervalLabel(1)).toBe("in 1 day");
    expect(intervalLabel(6)).toBe("in 6 days");
    expect(intervalLabel(29)).toBe("in 29 days");
    expect(intervalLabel(30)).toBe("in 1 month");
    expect(intervalLabel(75)).toBe("in 3 months");
    expect(intervalLabel(364)).toBe("in 12 months");
    expect(intervalLabel(365)).toBe("in 1 year");
    expect(intervalLabel(548)).toBe("in 1.5 years");
  });

  it("never says 0 days", () => {
    expect(intervalLabel(0)).toBe("in 1 day");
  });
});
