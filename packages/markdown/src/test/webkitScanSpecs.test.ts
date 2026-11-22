// The WebKit scan's spec list (packages/frontend/e2e/webkitScanSpecs.ts).
import { describe, expect, it } from "vitest";
import { WEBKIT_SCAN_SPECS, unmatchedScanSpecs, webkitScanMatch } from "../../../frontend/e2e/webkitScanSpecs";

describe("the WebKit scan list", () => {
  it("names a spec that does not exist (negative control)", () => expect(unmatchedScanSpecs(["a.spec.ts"], ["a", "gone"])).toEqual(["gone"]));
  it("covers the handwriting specs and matches by file name", () => {
    for (const s of ["inkCanvas", "inkColdStart", "inkFingerTools", "inkNote", "inkTouch", "pdfInk", "offlineHandwriting"]) expect(WEBKIT_SCAN_SPECS).toContain(s);
    expect(webkitScanMatch(["ink-note", "a"]).test("/x/ink-note.spec.ts")).toBe(true);
    expect(webkitScanMatch(["a"]).test("/x/ba.spec.ts")).toBe(false);
  });
});
