import { describe, expect, it } from "vitest";
import { newNoteSiteDefault } from "../sharedContract";

// The one rule for a new note's place on the site (backend services/siteDefault.ts and the app's
// noteWriter.create both call it): only the direct parent's own 「不發布」 counts.
describe("newNoteSiteDefault", () => {
  it("under a kept-off parent: kept off, marked as inherited", () => {
    expect(newNoteSiteDefault({ _published: "false" })).toEqual({ _published: "false", _published_by_parent: "true" });
  });

  it.each([
    ["no parent", undefined],
    ["a parent with no attributes", {}],
    ["a parent marked 「發布」", { _published: "true" }],
    ["a parent with only the inherited mark", { _published_by_parent: "true" }],
    ["other attributes", { _pinned: "true" }],
  ])("%s: no default", (_name, attrs) => {
    expect(newNoteSiteDefault(attrs)).toBeNull();
  });
});
