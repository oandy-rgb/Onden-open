// Guards for the 2026-10-27 dedupe batch (docs/archive/research/review-2026-10-27/deep-modules-tasks-time.md),
// server half: day arithmetic and "is this a real day" live in @onden/markdown / localDay.ts, the repeat
// grammar in @onden/markdown, and the scheduler changes task state through tasksStore, not raw SQL.
// The app's half is frontend's test/guards/tasks-time.guard.test.ts.
//
// How to read a failure: it names the file and the single owner. Use the owner, do not add the file to
// an allow-list. An allow-list entry needs a reason, and an entry whose file no longer has the pattern
// fails too, so the list never keeps a stale excuse.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { if (name !== "test" && name !== "node_modules") walk(path, out); }
    else if (/\.ts$/.test(name) && !/\.(test|spec)\.ts$/.test(name)) out.push(path);
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

describe("the repeat grammar (@onden/markdown parseRecur)", () => {
  it("no `<n><d|w|m>` regex on the server: read a rule with parseRecur / isValidRecur", () => {
    expectOnlyOwner(/\[dwm\]|\[dwmy\]/, []);
  });
});

describe("day arithmetic (@onden/markdown calendar, re-exported by localDay.ts)", () => {
  it("nobody adds days or months by hand", () => {
    expectOnlyOwner(/setUTCDate\(|setDate\(|setUTCMonth\(|86_?400_?000|\b24 \* 60 \* 60 \* 1000\b/, ["localDay.ts"], {
      "modules/tasks/recurrence.ts": "shiftRemindAt moves an INSTANT (a zoned reminder) by whole 24-hour days, not a calendar day id",
      "modules/review/fsrs.ts": "FSRS counts elapsed time between reviews in milliseconds",
      "modules/rss/fetch.ts": "a backfill window measured back from now in milliseconds",
      "services/actorInvites.ts": "an invite expires a number of 24-hour days after it is minted (an instant)",
      "server.ts": "maintenance timers: the interval between prunes in milliseconds",
    });
  });

  it("'is this a real day' is isCalendarDay / isCalendarDate, not a shape regex or a round trip through Date", () => {
    expectOnlyOwner(/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/|toISOString\(\)\.slice\(0, ?10\)\s*[!=]==/, []);
  });
});

describe("the task scheduler (modules/tasks/scheduler.ts)", () => {
  const scheduler = FILES.find((f) => f.path === "modules/tasks/scheduler.ts")!.text;

  it("changes no attribute row itself: state goes through tasksStore", () => {
    expect(scheduler).not.toMatch(/UPDATE\s+node_attributes|INSERT\s+INTO\s+node_attributes|DELETE\s+FROM\s+node_attributes/i);
  });

  it("asks the shared rules for the next occurrence and for a rule it can step by", () => {
    expect(scheduler).toContain("nextOccurrence(");
    expect(scheduler).toContain("isParsableRecur(");
  });
});

describe("the task bucket rule", () => {
  it("the agenda SQL spells the shared window (UPCOMING_DAYS), not its own number", () => {
    const store = FILES.find((f) => f.path === "services/tasksStore.ts")!.text;
    expect(store).toContain("${UPCOMING_DAYS}");
    expect(store).not.toMatch(/::date \+ \d/);
  });

  it("the list export sorts tasks with taskHome", () => {
    expect(FILES.find((f) => f.path === "services/taskListFile.ts")!.text).toContain("taskHome(");
  });
});
