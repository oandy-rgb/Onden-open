import { describe, expect, it } from "vitest";
import { effectKindLabel } from "./effectKinds";

describe("effectKindLabel", () => {
  it("names the kinds the backend registers", () => {
    expect(effectKindLabel("github_backup")).toBe("GitHub backup");
    expect(effectKindLabel("rss_fetch")).toBe("Feed refresh");
    expect(effectKindLabel("site_rebuild")).toBe("Website update");
    expect(effectKindLabel("site_bundle")).toBe("Website download copy");
  });

  it("never shows a kind it has no name for", () => {
    expect(effectKindLabel("some_new_effect")).toBe("Background job");
  });
});
