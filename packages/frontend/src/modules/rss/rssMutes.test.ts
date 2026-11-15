import { describe, expect, it } from "vitest";
import { muteWordOf } from "./rssMutes";

describe("muteWordOf", () => {
  it("collapses lines and spaces", () => {
    expect(muteWordOf("  the\n  big   news ")).toBe("the big news");
  });
  it("is null for nothing or too long a selection", () => {
    expect(muteWordOf("  \n ")).toBeNull();
    expect(muteWordOf("字".repeat(81))).toBeNull();
    expect(muteWordOf("字".repeat(80))).toBe("字".repeat(80));
  });
});
