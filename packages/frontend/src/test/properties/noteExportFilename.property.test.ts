// Property: the file name of a single-note export (lib/noteExport.ts
// noteExportFilename) is one a disk accepts for any title: at most 255 bytes of
// UTF-8 (a Chinese character is 3), none of the characters Windows forbids, no
// dot or blank before the extension, no half character at the cut — and a short
// ordinary title is kept as it is. Generators: markdown/src/test/helpers/
// unicodeText.ts. Seed and run count from PROPS_SEED / PROPS_RUNS.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { noteExportFilename } from "../../lib/noteExport";
import { PROPS_RUNS, PROPS_SEED } from "../../../../markdown/src/test/helpers/propsConfig";
import { hostileTitle, titleText, hasLoneSurrogate } from "../../../../markdown/src/test/helpers/unicodeText";

const fcOpts = { seed: PROPS_SEED, numRuns: PROPS_RUNS };

describe("noteExportFilename", () => {
  it("is within 255 bytes, free of forbidden characters and half characters, for any title", () => {
    fc.assert(fc.property(hostileTitle, fc.constantFrom("md", "html"), (title, ext) => {
      const name = noteExportFilename(title, ext as "md" | "html");
      expect(new TextEncoder().encode(name).length, name).toBeLessThanOrEqual(255);
      expect(name).not.toMatch(/[\\/:*?"<>|\p{Cc}]/u);
      expect(name.endsWith(`.${ext}`)).toBe(true);
      const stem = name.slice(0, -(ext.length + 1));
      expect(stem).not.toMatch(/[. ]$/);
      expect(stem.length).toBeGreaterThan(0);
      expect(hasLoneSurrogate(name)).toBe(false);
    }), fcOpts);
  });

  it("keeps a title that is already a good file name", () => {
    fc.assert(fc.property(titleText.filter((t) => !/[\\/:*?"<>|\p{Cc}.]/u.test(t) && new TextEncoder().encode(t).length <= 200), (title) => {
      expect(noteExportFilename(title, "md")).toBe(`${title.trim()}.md`);
    }), fcOpts);
  });

  // Found at PROPS_SEED=20261023 by reading the cap: it was 120 UTF-16 units, i.e. 360 bytes of Chinese.
  it("a 200-character Chinese title fits a disk", () => {
    const name = noteExportFilename("長".repeat(200), "md");
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
    expect(name).toBe(`${"長".repeat(80)}.md`);
  });
});
