// Guards for the 2026-10-27 dedupe batch (docs/archive/research/review-2026-10-27/deep-modules-tasks-time.md):
// the rule for where a task falls, the repeat grammar, day arithmetic, "today" and the account
// preference endpoint each have one owner. This file reads the source so a second copy cannot grow
// back unnoticed. The backend and markdown halves are in their own packages' tasks-time.guard.test.ts.
//
// How to read a failure: it names the file and the single owner. Use the owner, do not add the file
// to an allow-list. An allow-list entry needs a reason, and an entry whose file no longer has the
// pattern fails too, so the list never keeps a stale excuse.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { if (name !== "test" && name !== "node_modules") walk(path, out); }
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** Source files outside tests, as `src/`-relative posix paths with comment lines blanked. */
const FILES = walk(SRC).map((path) => {
  const text = readFileSync(path, "utf8")
    .split("\n").map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? "" : line)).join("\n");
  return { path: relative(SRC, path).split(sep).join("/"), text };
});

type Exceptions = Record<string, string>;

function expectOnlyOwner(pattern: RegExp, owners: readonly string[], exceptions: Exceptions = {}) {
  const hits = FILES.filter((f) => pattern.test(f.text) && !owners.some((o) => f.path === o || (o.endsWith("/") && f.path.startsWith(o))));
  const unexpected = hits.map((f) => f.path).filter((p) => !(p in exceptions));
  const stale = Object.keys(exceptions).filter((p) => !hits.some((f) => f.path === p));
  expect(unexpected, `only ${owners.join(", ") || "@onden/markdown"} may contain ${pattern}`).toEqual([]);
  expect(stale, "these exceptions no longer need to be listed").toEqual([]);
}

describe("where a task falls on the calendar (@onden/markdown taskBucket / taskHome)", () => {
  it("no code compares a task's day with today by hand", () => {
    // whenDate <= today, task.when_date < todayId, today >= task.when … : ask taskBucket / taskHome.
    expectOnlyOwner(/(?:whenDate|when_date|due_date|\.when)[!?]?\s*(?:<=?|>=?)\s*\(?(?:today|todayId)\b|\b(?:today|todayId)\b\s*(?:<=?|>=?)\s*[\w.!]*(?:whenDate|when_date|due_date|\.when)\b/, []);
  });

  it("the Tasks page and the journal call the shared rule", () => {
    const calls = (path: string, name: string) => FILES.find((f) => f.path === path)!.text.includes(name);
    expect(calls("lib/tasks/taskModel.ts", "taskHome(")).toBe(true);
    expect(calls("lib/tasks/journalBuckets.ts", "taskBucket(")).toBe(true);
  });
});

describe("the repeat grammar (@onden/markdown parseRecur)", () => {
  it("no `<n><d|w|m>` regex in the app: read a rule with parseRecur", () => {
    expectOnlyOwner(/\[dwm\]|\[dwmy\]/, []);
  });
});

describe("day arithmetic (@onden/markdown calendar, re-exported by lib/localDate)", () => {
  it("nobody adds days or months by hand", () => {
    expectOnlyOwner(/setUTCDate\(|setDate\(|setUTCMonth\(|86_?400_?000|\b24 \* 60 \* 60 \* 1000\b/, ["lib/localDate.ts"], {
      "lib/data/syncEngine.ts": "FULL_REFRESH_MAX_AGE_MS: how old a local copy may be (milliseconds of wall time), not a calendar day",
    });
  });

  it("'is this a real day' is isCalendarDay / isCalendarDate, not a round trip through Date", () => {
    expectOnlyOwner(/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/|toISOString\(\)\.slice\(0, ?10\)\s*[!=]==/, []);
  });
});

describe("a month of days to pick from (components/ui/MonthGrid)", () => {
  it("one component draws a month to pick a day from; the diary and the date picker both use it", () => {
    // A second hand-drawn month went crooked on the phone (2026-11-01): numbers off-centre, a fixed 308px grid.
    expectOnlyOwner(/\bbuildMonthGrid\(/, ["components/ui/MonthGrid.tsx"], {
      "modules/calendar/CalendarLayout.tsx": "the calendar view: a page-size month whose cells hold the notes of each day, not a day picker",
    });
  });
});

describe("today (hooks/useToday)", () => {
  it("the hook that re-reads the workspace's day is written once", () => {
    expectOnlyOwner(/function useToday\b|const useToday\b/, ["hooks/useToday.ts"]);
  });

  it("the old todayId alias lib/dayNode localDateId is gone", () => {
    expectOnlyOwner(/\blocalDateId\b/, []);
  });
});

describe("account preferences (lib/accountPrefStore createAccountPref)", () => {
  it("the /api/me/prefs endpoint is spelled only by the factory (write) and the data layer's read", () => {
    expectOnlyOwner(/\/api\/me\/prefs\//, ["lib/accountPrefStore.ts", "lib/data/reads.ts"]);
  });

  it("a synced pref is made by the factory, not by hand-wiring createSyncedPrefStore", () => {
    expectOnlyOwner(/createSyncedPrefStore\s*[<(]/, ["lib/accountPrefStore.ts", "lib/syncedPrefStore.ts"]);
  });
});
