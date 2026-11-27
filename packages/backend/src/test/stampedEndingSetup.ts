// Setup file of every backend test file (vitest.config.ts setupFiles): the engine's receiving calls go through the ending's record (helpers/stampedEnding.ts), whoever
// makes them — the helpers of stampedBundleWorld.ts, a direct call in a test, a service (services/stampedJoin.ts). Nothing else changes: each call is the engine's own.
// The wrapped module is loaded only when a test file imports it (the factory runs then, after that file's own vi.mock calls are registered), so a file that never
// touches the engine pays nothing; the ending's helpers are imported inside the calls, for the same reason.
//
// Exchanges in another process (the worker processes of the two-process tests: helpers/stampedBundleWorker.ts, stampedTwoProcessWorker.ts) are reported by the helpers
// there, one line each, to the file ONDEN_ENDING_MARKS names (set here, inherited by a child's environment); a test during which lines were added must have an entry
// in the exception lists (the ending cannot reach a database another process holds).
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, onTestFinished, vi } from "vitest";

// The exports wrapped here are named in helpers/stampedEndingNames.ts ENDING_WRAPPED; guards/stampedEndingReach.guard.test.ts checks that every export of
// stampedImport.ts is wrapped or named there as not writing what was received, and that each named one is wrapped.
vi.mock("../spine/stampedImport.js", async (original) => {
  const real = await original<typeof import("../spine/stampedImport.js")>();
  const ending = () => import("./helpers/stampedEnding.js");
  return {
    ...real,
    applyChangeBundle: async (ws: string, bundle: Parameters<typeof real.applyChangeBundle>[1]) =>
      (await ending()).engineCall("bundle", ws, typeof bundle?.sender === "string" ? bundle.sender : null, bundle, () => real.applyChangeBundle(ws, bundle)),
    beginJoin: async (input: Parameters<typeof real.beginJoin>[0]) => {
      await real.beginJoin(input);
      (await ending()).joinStarted(input.workspaceId, input.sourceNode);
    },
    markJoinDone: async (ws: string, ...rest: [Parameters<typeof real.markJoinDone>[1], Parameters<typeof real.markJoinDone>[2]]) => {
      const e = await ending();
      return e.engineCall("join", ws, e.joinSource(ws), null, () => real.markJoinDone(ws, ...rest));
    },
    mergeUnitsIntoWorkspace: async (ws: string, ...rest: [Parameters<typeof real.mergeUnitsIntoWorkspace>[1], Parameters<typeof real.mergeUnitsIntoWorkspace>[2]?]) =>
      (await ending()).engineCall("units", ws, null, null, () => real.mergeUnitsIntoWorkspace(ws, ...rest)),
  };
});

// one file of marks per test file, made before its first test and removed after its last (the run fails on anything left in the temp directory: globalSetup.ts;
// a file whose every test is skipped runs neither hook, so it makes none)
let marksFile = "";
beforeAll(() => {
  marksFile = join(mkdtempSync(join(tmpdir(), "onden-ending-")), "marks");
  appendFileSync(marksFile, "");
  process.env.ONDEN_ENDING_MARKS = marksFile;
});
const marks = () => { try { return readFileSync(marksFile, "utf8").length; } catch { return 0; } };
let marksBefore = 0;
let marksInTests = 0;
/** The tests of this file that passed with an entry in ENDING_FAILS of their own or under a " > *" key: their ending must have run and failed as pinned. */
const pinnedTests: { name: string; key: string }[] = [];
const pinnedFailed = () => (globalThis as { __ondenPinnedFailed?: Set<string> }).__ondenPinnedFailed ?? new Set<string>();
/** The skipped tests that still needed it: the ending found something, could not go on or had no node to end with (helpers/stampedEnding.ts), or another process exchanged. */
const skippedNeeded = () => ((globalThis as { __ondenSkippedNeeded?: Set<string> }).__ondenSkippedNeeded ??= new Set<string>());
beforeEach(() => {
  marksBefore = marks();
  // registered first, so it runs after the ending's own onTestFinished (they run last registered first): what the ending found is known by then
  onTestFinished(async ({ task }) => {
    if (task.result?.state === "fail") return;
    const { fullName } = await import("./helpers/stampedEndingNames.js");
    const { ENDING_FAILS, ENDING_SKIPPED } = await import("./helpers/stampedEndingExceptions.js");
    const name = fullName(task as never);
    if (ENDING_SKIPPED[name] !== undefined && !skippedNeeded().has(name)) {
      throw new Error(`"${name}" is in ENDING_SKIPPED, but nothing of it needed skipping: no exchange of it was recorded, or the ending of its exchanges passes, and no call of it came from no node or another process. Take the line out of ENDING_SKIPPED (helpers/stampedEndingExceptions.ts)`);
    }
    if (ENDING_FAILS[name] !== undefined) {
      if (!pinnedFailed().has(name)) throw new Error(`"${name}" is pinned in ENDING_FAILS, but its ending never ran and failed as pinned: nothing of the test was recorded (is the wrapper of test/stampedEndingSetup.ts in place?), or the test no longer exchanges. Take the entry out, with its README line, or find out why`);
      return;
    }
    const key = Object.keys(ENDING_FAILS).find((k) => k.endsWith(" > *") && name.startsWith(k.slice(0, -1)));
    if (key) pinnedTests.push({ name, key });
  }, 900_000);
  // the first node this test opens (helpers/distSim/realNode.ts serial): one opened before it is shared with the file's other tests, which the ending must not change
  const g = globalThis as { __ondenNodeSerial?: number; __ondenFirstNodeOfTest?: number };
  g.__ondenFirstNodeOfTest = (g.__ondenNodeSerial ?? 0) + 1;
});
afterEach(async () => {
  if (marks() === marksBefore) return;
  marksInTests += marks() - marksBefore;
  const { getCurrentTest } = await import("vitest/suite");
  const test = getCurrentTest();
  if (!test || test.result?.state === "fail") return;
  const { fullName, exceptionEntryFor } = await import("./helpers/stampedEndingNames.js");
  const { ENDING_FAILS, ENDING_SKIPPED } = await import("./helpers/stampedEndingExceptions.js");
  const name = fullName(test as never);
  if (exceptionEntryFor(ENDING_SKIPPED, name) !== undefined) skippedNeeded().add(name);
  if (exceptionEntryFor(ENDING_SKIPPED, name) === undefined && exceptionEntryFor(ENDING_FAILS, name) === undefined) {
    if (process.env.ONDEN_ENDING_LOG) appendFileSync(process.env.ONDEN_ENDING_LOG, `${name}\tan exchange in another process, no entry\n`);
    throw new Error(`"${name}" exchanged bundles or snapshots in another process, where the ending cannot reach: give it an entry in ENDING_SKIPPED (helpers/stampedEndingExceptions.ts) saying why`);
  }
});

// After the file's last test (this hook runs after the file's own afterAll, which may close nodes: those closes wait for this): what the file's beforeAll exchanged is
// ended like a test's, and an exchange another process made outside every test needs an entry "<file> > (outside a test)".
afterAll(async () => {
  const outside = marks() - marksInTests;
  if (marksFile) rmSync(dirname(marksFile), { recursive: true, force: true });
  // the ending's module is loaded only by a file that reached the engine (it sets this flag): every other file pays nothing here
  if ((globalThis as { __ondenEndingLoaded?: boolean }).__ondenEndingLoaded) await (await import("./helpers/stampedEnding.js")).finishFile();
  // a " > *" entry (one world a describe's tests share, ended by whichever test built it): one of its tests that passed must have failed as pinned
  for (const key of new Set(pinnedTests.map((t) => t.key))) {
    if (!pinnedTests.some((t) => t.key === key && pinnedFailed().has(t.name))) {
      throw new Error(`"${key}" is pinned in ENDING_FAILS, but no ending of its tests ran and failed as pinned: nothing was recorded, or they no longer exchange. Take the entry out, with its README line, or find out why`);
    }
  }
  const { exceptionEntryFor } = await import("./helpers/stampedEndingNames.js");
  const { ENDING_FAILS, ENDING_SKIPPED } = await import("./helpers/stampedEndingExceptions.js");
  const file = (globalThis as { __vitest_worker__?: { filepath?: string } }).__vitest_worker__?.filepath ?? "?";
  const name = `${file.split("/").pop()} > (outside a test)`;
  // a skipped beforeAll must still need it, as a skipped test must
  if (outside > 0) skippedNeeded().add(name);
  if (ENDING_SKIPPED[name] !== undefined && !skippedNeeded().has(name)) {
    throw new Error(`"${name}" is in ENDING_SKIPPED, but nothing the file did outside its tests needed skipping: take the line out of ENDING_SKIPPED (helpers/stampedEndingExceptions.ts)`);
  }
  if (outside <= 0) return;
  if (exceptionEntryFor(ENDING_SKIPPED, name) === undefined && exceptionEntryFor(ENDING_FAILS, name) === undefined) {
    if (process.env.ONDEN_ENDING_LOG) appendFileSync(process.env.ONDEN_ENDING_LOG, `${name}\tan exchange in another process, no entry\n`);
    throw new Error(`"${name}": the file's beforeAll exchanged bundles or snapshots in another process, where the ending cannot reach: give it an entry in ENDING_SKIPPED (helpers/stampedEndingExceptions.ts) saying why`);
  }
}, 900_000);
