// The WebKit scan's spec list (packages/frontend/e2e/webkitScanSpecs.ts).
import { describe, expect, it } from "vitest";
import { SCAN_PROJECTS, WEBKIT_SCAN, WEBKIT_SCAN_SPECS, invalidScanSpecs, scanSpecsFor, unmatchedScanSpecs, webkitScanMatch } from "../../../frontend/e2e/webkitScanSpecs";

describe("the WebKit scan list", () => {
  it("names a spec that does not exist (negative control)", () => expect(unmatchedScanSpecs(["a.spec.ts"], ["a", "gone"])).toEqual(["gone"]));
  it("covers the handwriting specs and matches by file name", () => {
    for (const s of ["inkCanvas", "inkColdStart", "inkFingerTools", "inkNote", "inkTouch", "pdfInk", "offlineHandwriting"]) expect(WEBKIT_SCAN_SPECS).toContain(s);
    expect(webkitScanMatch(["ink-note", "a"]).test("/x/ink-note.spec.ts")).toBe(true);
    expect(webkitScanMatch(["a"]).test("/x/ba.spec.ts")).toBe(false);
  });
  it("declares sizes for every spec (negative controls: none, empty, unknown project)", () => {
    expect(invalidScanSpecs()).toEqual([]);
    expect(invalidScanSpecs({ a: [], b: undefined, c: ["webkit"], d: ["android"] })).toEqual([
      "a: no project declared", "b: no project declared", 'd: unknown project "android"',
    ]);
  });
  it("runs every spec on at least one project, and the desktop-only ones are not on the phone-layout projects", () => {
    const ran = new Set(SCAN_PROJECTS.flatMap((p) => scanSpecsFor(p)));
    expect([...ran].sort()).toEqual([...WEBKIT_SCAN_SPECS].sort());
    for (const s of ["inboxGovernance", "syncStatus", "inkNote"]) {
      expect(scanSpecsFor("webkit")).toContain(s);
      expect(scanSpecsFor("ipad")).not.toContain(s);
      expect(scanSpecsFor("mobile-safari")).not.toContain(s);
    }
    expect(WEBKIT_SCAN.crossbrowser).not.toContain("ipad");
  });
});
