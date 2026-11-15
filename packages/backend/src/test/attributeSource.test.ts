// D106: one answer to "is this a person's value?" (spine/attributeSource.ts),
// and legacy `explicit` read as `ui` but never written.

import { describe, expect, it } from "vitest";
import { incomingWins, isPersonAuthored, PERSON_SOURCE, writableSource } from "../spine/attributeSource.js";

describe("attribute provenance (D106)", () => {
  it("a value set in the UI, legacy explicit or the frontmatter is a person's", () => {
    expect(isPersonAuthored("ui")).toBe(true);
    expect(isPersonAuthored("explicit")).toBe(true);
    expect(isPersonAuthored("frontmatter")).toBe(true);
  });

  it("body-inline, automated, computed and unknown values are not", () => {
    for (const source of ["markdown", "dispatcher", "derived", "", "bogus", null, undefined]) {
      expect(isPersonAuthored(source), String(source)).toBe(false);
    }
  });

  it("new person-set values are written as ui, and a copied legacy row becomes ui", () => {
    expect(PERSON_SOURCE).toBe("ui");
    expect(writableSource("explicit")).toBe("ui");
    for (const source of ["ui", "markdown", "frontmatter", "dispatcher", "derived"]) expect(writableSource(source)).toBe(source);
  });

  it("a legacy explicit row still ranks as ui", () => {
    expect(incomingWins("ui", "explicit")).toBe(true);
    expect(incomingWins("explicit", "ui")).toBe(true);
    expect(incomingWins("frontmatter", "explicit")).toBe(false);
  });
});
