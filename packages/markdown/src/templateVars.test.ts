import { describe, expect, it } from "vitest";
import { applyTemplateVars } from "./templateVars.js";

describe("applyTemplateVars", () => {
  const vars = { date: "2026-10-18", datetime: "2026-10-18 09:05" };

  it("expands every {date} and {datetime}", () => {
    expect(applyTemplateVars("Meeting — {datetime} ({date}, {date})", vars))
      .toBe("Meeting — 2026-10-18 09:05 (2026-10-18, 2026-10-18)");
  });

  it("keeps other braces as written", () => {
    expect(applyTemplateVars("{title} {Date} {{date}}", vars)).toBe("{title} {Date} {2026-10-18}");
  });
});
