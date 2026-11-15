// The addresses an export writes into HTML attributes: a link must not carry a
// script scheme. The pages' CSP blocks scripts as well; this is the layer under it.
import { describe, expect, it } from "vitest";
import { safeUrl } from "../modules/website/publishing/htmlUtils.js";

describe("export attributes", () => {
  it("safeUrl keeps relative, fragment and http(s)/mailto addresses, and drops other schemes", () => {
    for (const ok of ["../about/", "#top", "media/a.png", "/api/media/a.png", "https://x.test/", "http://x.test", "mailto:a@x.test", "?q=1"]) {
      expect(safeUrl(ok)).toBe(ok);
    }
    for (const bad of ["javascript:alert(1)", " JavaScript:alert(1)", "java\tscript:alert(1)", "data:text/html,<b>", "vbscript:x"]) {
      expect(safeUrl(bad)).toBe("#");
    }
  });
});
