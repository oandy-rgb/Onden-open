// @vitest-environment node
// Guard: the number of controls whose hit area is under 44×44 CSS px on a touch screen (pointer: coarse) only goes down.
// The measurement needs a browser and takes minutes, so it is run by hand (npm run style:census -- --check-taps, see
// e2e/style-census/README.md); this test holds the file it compares with and the rules of the comparison.
// scripts/tap-target-baseline.json is also a ratchet file: `npm run ratchet:check` fails when any number in it rises.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareTaps, readTapBaseline, renderTapComparison, TAP_BASELINE_FILE, writeTapBaseline, type TapCounts } from "../../../e2e/style-census/tapBaseline.mjs";

const at = (off: number, total = 20): TapCounts => ({ "1204x714": { note: { total, off } } });

describe("scripts/tap-target-baseline.json", () => {
  const base = readTapBaseline();
  it("covers the real tablet (1204×714) and the phone, with whole numbers and off ≤ total", () => {
    expect(Object.keys(base)).toEqual(expect.arrayContaining(["1204x714", "390"]));
    for (const [size, screens] of Object.entries(base)) for (const [screen, c] of Object.entries(screens)) {
      expect(Number.isInteger(c.off) && c.off >= 0 && c.off <= c.total, `${size} ${screen}`).toBe(true);
    }
  });
  it("includes the screens the owner measured: note, tasks, settings", () => {
    for (const screen of ["note-long", "tasks", "settings"]) expect(base["1204x714"]?.[screen], screen).toBeDefined();
  });
  it("is read from the file the census writes", () => {
    expect(JSON.parse(readFileSync(TAP_BASELINE_FILE, "utf8"))).toEqual(base);
  });
});

describe("the comparison", () => {
  it("fails when a screen has more small controls than the baseline", () => {
    const r = compareTaps(at(10), at(11));
    expect(r.ok).toBe(false);
    expect(renderTapComparison(r)).toContain("FAIL");
  });
  it("passes when equal or fewer, and for a screen the baseline does not have yet", () => {
    expect(compareTaps(at(10), at(10)).ok && compareTaps(at(10), at(2)).ok).toBe(true);
    expect(compareTaps({}, at(30)).ok).toBe(true);
  });
  it("writing only lowers: a higher number is kept as it was, a new screen is added", () => {
    const dir = mkdtempSync(join(tmpdir(), "tap-baseline-"));
    try {
      const file = join(dir, "b.json");
      const first = writeTapBaseline({}, at(10), file);
      expect(first).toEqual({ lowered: 0, added: 1, kept: 0 });
      expect(writeTapBaseline(readTapBaseline(file), at(12), file).kept).toBe(1);
      expect(readTapBaseline(file)["1204x714"]!.note!.off).toBe(10);
      expect(writeTapBaseline(readTapBaseline(file), at(4), file).lowered).toBe(1);
      expect(readTapBaseline(file)["1204x714"]!.note!.off).toBe(4);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
