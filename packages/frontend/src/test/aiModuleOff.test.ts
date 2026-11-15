// AI switched off (modules/ai): the info panel has no AI tab and never lands on it, and
// the "ai" shell feature follows the workspace's module list. The census of every other entry
// point is moduleOffNoTrace.test.ts.
import { describe, expect, it } from "vitest";
import { infoTabsFor, initialInfoTab } from "../lib/infoPanel";
import { shellFeatureOnIn } from "../lib/shellFeatures";
import { moduleFilterFor, moduleStatusFor } from "../modules";

const nothingElse = { hasFunctions: false, hasTags: false, hasRelations: false };

describe("AI off", () => {
  it("the info panel has no AI tab and a saved AI pick is ignored", () => {
    expect(infoTabsFor(true)).toContain("ai");
    expect(infoTabsFor(false)).not.toContain("ai");
    expect(initialInfoTab("ai", nothingElse, false)).toBe("relations");
    expect(initialInfoTab("ai", nothingElse, true)).toBe("ai");
    expect(initialInfoTab(null, nothingElse, true)).toBe("ai");
    expect(initialInfoTab("tags", nothingElse, false)).toBe("tags");
  });

  it("the ai feature is on only while the module list has it", () => {
    expect(shellFeatureOnIn(["tasks"], "ai")).toBe(false);
    expect(shellFeatureOnIn(["tasks", "ai"], "ai")).toBe(true);
    expect(moduleFilterFor(["tasks"])("ai")).toBe(false);
  });

  it("a new workspace asks before AI starts, and skills are not on without it", () => {
    const status = moduleStatusFor(["tasks"], ["ai"]);
    expect(status("ai")).toBe("ask");
    expect(status("skills")).toBe("off");
  });
});
