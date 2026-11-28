// Guards for the 2026-10-27 dedupe batch, owner half: @onden/markdown is where the repeat grammar and
// the day arithmetic live, so inside the package only these files may spell them. The consumers' halves
// are in frontend and backend test/guards/tasks-time.guard.test.ts.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { overBaseline } from "./sources";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Non-test source files directly in src/, with comment lines blanked. */
const FILES = readdirSync(SRC).filter((f) => f.endsWith(".ts") && !/\.(test|testing)\.ts$/.test(f)).map((name) => ({
  name,
  text: readFileSync(join(SRC, name), "utf8").split("\n").map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? "" : line)).join("\n"),
}));

function filesWith(pattern: RegExp): string[] {
  return FILES.filter((f) => pattern.test(f.text)).map((f) => f.name);
}

describe("the one repeat grammar and the one calendar arithmetic", () => {
  it("`[dwm]` is spelled only by recur.ts", () => {
    expect(filesWith(/\[dwm\]/)).toEqual(["recur.ts"]);
  });

  it("adding days or months is calendar.ts's alone", () => {
    expect(filesWith(/setUTCDate\(|setUTCMonth\(|86_?400_?000/)).toEqual(["calendar.ts"]);
  });

  it("recur.ts and taskParse.ts take their arithmetic from calendar.ts", () => {
    for (const name of ["recur.ts", "taskParse.ts"]) {
      expect(FILES.find((f) => f.name === name)!.text, name).toMatch(/from "\.\/calendar\.js"/);
    }
  });

  it("calendar.ts and recur.ts stay free of the Markdown pipeline (the local-DB worker reaches taskParse through them)", () => {
    // taskTime.ts is the line-time grammar: pure, no imports.
    for (const name of ["calendar.ts", "recur.ts", "taskBucket.ts", "taskParse.ts", "taskTime.ts"]) {
      const imports = [...FILES.find((f) => f.name === name)!.text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      expect(imports.filter((spec) => !["./calendar.js", "./recur.js", "./taskTime.js"].includes(spec!)), name).toEqual([]);
    }
  });
});

// ── The workspace's day, not the device's (2026-10-30, 日期統一) ────────────────────────────────────
// Which day it is comes from the workspace clock (frontend lib/localDate, backend localDay.ts); a day is
// picked with the one DatePicker (frontend components/ui). Across every package's production source:
//   * no native <input type="date"> / "datetime-local" — there is no baseline for these, the count is 0;
//   * no read of a Date's local calendar fields or a UTC slice of an instant as a day
//     (`getDate()`, `getFullYear()`, `getMonth()`, `getDay()`, `toISOString().slice(0, 10)`, `toLocaleDateString`):
//     each file is held to the count in tasks-time.baseline.json, which only ratchets down.
// Day arithmetic on ids (calendar.ts) is UTC math on YYYY-MM-DD and is the one place that may slice an ISO string.
// Lower the baseline after removing hits: UPDATE_DAY_BASELINE=1 npx vitest run src/test/guards/tasks-time
const PACKAGES = resolve(SRC, "../..");
const DAY_BASELINE = join(dirname(fileURLToPath(import.meta.url)), "tasks-time.baseline.json");
const NATIVE_DATE_INPUT = /\btype=["'](?:date|datetime-local)["']/;
const DEVICE_DAY = /\.(?:getDate|getFullYear|getMonth|getDay)\(\)|toISOString\(\)\.(?:slice|substring)\(\s*0\s*,\s*10\s*\)|\.toLocaleDateString\(|\.toDateString\(/g;
const DAY_OWNER = "markdown/src/calendar.ts";

function productionSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ["node_modules", "dist", "test", "fixtures", "__snapshots__", "vendor"].includes(entry.name) ? [] : productionSources(path);
    return /\.(ts|tsx|astro)$/.test(entry.name) && !/\.(test|spec|testing)\./.test(entry.name) ? [path] : [];
  });
}

const codeOnly = (text: string) => text.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");

describe("the workspace's day, not the device's", () => {
  const nativeInputs: string[] = [];
  const deviceDays: Record<string, number> = {};
  for (const pkg of ["markdown", "site", "backend", "frontend"]) {
    for (const file of productionSources(join(PACKAGES, pkg, "src"))) {
      const rel = relative(PACKAGES, file).split(sep).join("/");
      const text = codeOnly(readFileSync(file, "utf8"));
      if (NATIVE_DATE_INPUT.test(text)) nativeInputs.push(rel);
      const hits = rel === DAY_OWNER ? 0 : (text.match(DEVICE_DAY) ?? []).length;
      if (hits > 0) deviceDays[rel] = hits;
    }
  }
  if (process.env.UPDATE_DAY_BASELINE === "1") writeFileSync(DAY_BASELINE, `${JSON.stringify(Object.fromEntries(Object.entries(deviceDays).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`);
  const baseline = JSON.parse(readFileSync(DAY_BASELINE, "utf8")) as Record<string, number>;

  it("a day is picked with the DatePicker, never a native date input", () => {
    expect(nativeInputs, "use components/ui DatePicker (a time of day may still be <input type=\"time\">)").toEqual([]);
  });

  it("no file reads the device's calendar for a day beyond its baseline", () => {
    const over = overBaseline(deviceDays, baseline);
    expect(over, "ask the workspace clock (lib/localDate todayId / dateIdAt, backend localDayId) or calendar.ts; raising the baseline needs a reason").toEqual([]);
  });

  it("the scan still sees what it looks for (a regex that matched nothing would pass for nothing)", () => {
    expect(NATIVE_DATE_INPUT.test('<input type="date" value={x} />')).toBe(true);
    expect(NATIVE_DATE_INPUT.test('<input type="datetime-local" />')).toBe(true);
    expect(NATIVE_DATE_INPUT.test('<input type="time" />')).toBe(false);
    expect(NATIVE_DATE_INPUT.test('field.type === "date"')).toBe(false);
    expect("a.getDate() b.getFullYear() c.toISOString().slice(0, 10) d.toLocaleDateString('zh')".match(DEVICE_DAY)).toHaveLength(4);
    expect(readFileSync(join(PACKAGES, DAY_OWNER), "utf8")).toContain("toISOString().slice(0, 10)");
  });
});
