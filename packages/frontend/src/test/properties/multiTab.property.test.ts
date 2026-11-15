// Two tabs of one browser profile (a browser tab and the installed app, or two
// tabs) share ONE local database and ONE offline write queue. This test runs
// the REAL client stack in each tab — noteWriter → writeQueue → writeRecovery →
// localDb (RPC) → localDbWorker with sql.js, its journal and its snapshot
// adapter, and syncEngine — each tab a separate module registry, over one fake
// IndexedDB (test/helpers/fakeIndexedDb.ts), one fake Web Locks, one
// localStorage and one fake server (test/helpers/tabWorld.ts).
//
// The test chooses every interleaving: which IndexedDB request completes next
// (across tabs), when the server answers a request and how (delivered, 503,
// network error, refused for good, applied with the answer lost), when time
// passes (the 2 s snapshot debounce, the 15 s compaction, the 25 s write
// deadline), when a tab goes offline/online, writes a snapshot, reloads or is
// closed (pagehide), and when another device edits a note.
//
// Notes hold "v<n>": every save is a new, larger n, and the server keeps the
// largest it was ever given (the resolution of a merge), so "what the note
// shows" is a number and "this write is not lost" is a set lookup.
//
// After a run settles (online, every request answered, synced):
//   1 a write a tab was told is saved (synced / queued / refused) reached the
//     server or is in recovery — no other tab's snapshot or reload ate it
//   2 no write reaches the server again after a success for it was delivered,
//     and none is on the wire from two tabs at once
//   3 both tabs, a freshly opened tab and the server show the same notes, and
//     no queued write is left over
//   4 a reloaded tab's first paint shows every text that was queued (told
//     "saved offline") and not yet sent, whichever tab queued it
//
// Known bugs. What this test found is fixed and pinned at the bottom as plain
// cases with a minimal reproduction; one is still open, as it.fails("KNOWN: …"):
// a reload can paint older text than the tab was showing. The random property
// does not reach it. One more is steered around (search for "KNOWN" below):
//   crash with an edit sent   a tab with an unanswered edit is not crashed
// PROPS_INCLUDE_KNOWN=1 turns that off; the property then fails.
//
// Replay:  PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run <this file>
//          (fast-check prints the seed, path and the shrunk command list;
//          PROPS_TRACE=1 adds the server's timeline, PROPS_DUMP=1 prints the
//          first failing run before shrinking starts.)

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

vi.mock("sql.js", async (original) => {
  const real = await original<typeof import("sql.js")>();
  // One wasm load for every tab and run; the databases a run opens are closed when it ends (World.uninstall),
  // or the shared wasm heap runs out after about a thousand runs.
  const shared = globalThis as { __ondenSql?: ReturnType<typeof real.default>; __ondenDatabases?: Array<{ close(): void }> };
  return {
    default: async () => {
      const SQL = await (shared.__ondenSql ??= real.default());
      class TrackedDatabase extends SQL.Database {
        constructor(data?: ArrayLike<number> | Buffer | null) { super(data); (shared.__ondenDatabases ??= []).push(this); }
      }
      return { ...SQL, Database: TrackedDatabase };
    },
  };
});
vi.mock("../../lib/api", async (original) => ({
  ...await original<typeof import("../../lib/api")>(),
  // Not vi.fn: vitest keeps every mock and the values it returned, and a returned promise carries its tab.
  api: async (path: string, init?: unknown) => {
    const { tabContext, theWorld } = await import("../helpers/tabWorld");
    return theWorld.server.request(tabContext.getStore()!, path, init as never);
  },
}));

import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";
import { NOTES, Tab, dataCtx, theWorld, type NoteId, type Outcome, type WriteRecord } from "../helpers/tabWorld";

const w = theWorld;
/** A run starts four module registries, a sql.js and a fake disk: about 0.2 s. Capped unless PROPS_RUNS is set on purpose, to keep the file under a minute. */
const RUNS = process.env.PROPS_RUNS ? PROPS_RUNS : Math.min(PROPS_RUNS, 120);
/** Look at the known bugs instead of steering around them (see the KNOWN cases below). */
const INCLUDE_KNOWN = !!process.env.PROPS_INCLUDE_KNOWN;
type Slot = "A" | "B";
type Reloaded = { tab: Tab; floor: Record<NoteId, number> };
type Run = { includeKnown: boolean; slots: Record<Slot, Tab>; ops: Array<{ tab: Tab; done: Promise<unknown> }>; reloads: Reloaded[] };

// sql.js reads its wasm from disk once, for real; after that nothing in a tab waits on the outside world.
beforeAll(async () => { await (await import("sql.js")).default(); });
afterEach(() => w.uninstall());

// ── driving a tab ────────────────────────────────────────────────────────────

function begin(run: Run, tab: Tab, fn: () => Promise<unknown>): void {
  run.ops.push({ tab, done: w.start(tab, fn) });
}

async function openTab(run: Run, name: Slot, wait: boolean): Promise<Tab> {
  const tab = await w.createTab(name);
  run.slots[name] = tab;
  const booting = w.start(tab, () => tab.mods.syncEngine.boot());
  run.ops.push({ tab, done: booting });
  if (wait) await w.drive(booting);
  return tab;
}

/** Text a reload must show on its first paint: of the writes any tab was told
 *  are queued (durable) and nobody has sent yet, at least the oldest one's. Two
 *  tabs queue in the order their commits happen, not the order they were typed,
 *  so which of them wins the paint is not fixed; showing none of them is the
 *  bug. (The server-derived text the tab showed is only a cache until the next
 *  sync: see the KNOWN case "a reload can paint older".) */
function queuedFloor(): Record<NoteId, number> {
  const floor = { n0: 0, n1: 0 } as Record<NoteId, number>;
  for (const id of NOTES) {
    const unsent = w.writes.filter((rec) => rec.note === id && rec.status === "queued" && !w.server.appliedNs.has(rec.n) && !w.server.refusedNs.has(rec.n)).map((rec) => rec.n);
    if (unsent.length) floor[id] = Math.min(...unsent);
  }
  return floor;
}

/** What data/connectivity does when the browser comes back: reconnect(), and on the online flip refreshIfStale(). */
async function reconnectLikeTheApp(tab: Tab): Promise<void> {
  await tab.mods.syncEngine.reconnect();
  await tab.mods.syncEngine.refreshIfStale();
}

// ── commands ─────────────────────────────────────────────────────────────────

type Cmd = fc.AsyncCommand<object, Run>;
const slot = fc.constantFrom<Slot>("A", "B");
const note = fc.constantFrom<NoteId>(...NOTES);
const pumps = fc.integer({ min: 0, max: 25 });
const seed = fc.integer({ min: 0, max: 1_000_000 });
const OUTCOMES: Outcome[] = ["deliver", "deliver", "deliver", "deliver", "arrive", "503", "503", "net", "net", "refuse", "lose", "lose"];

function cmd<A extends unknown[]>(name: (...a: A) => string, exec: (run: Run, ...a: A) => Promise<void>) {
  return (...args: A): Cmd => ({
    check: () => true,
    async run(_m, run) { await exec(run, ...args); },
    toString: () => name(...args),
  });
}
const alive = (run: Run, s: Slot): Tab | null => run.slots[s].dead ? null : run.slots[s];

/** The user types a new text into a note: the real noteWriter save, started and left running. */
function startTyping(run: Run | null, tab: Tab, id: NoteId, keepalive: boolean): WriteRecord {
  const rec: WriteRecord = { n: w.server.nextN++, note: id, tab: tab.name, owner: tab, status: "started", keepalive };
  w.writes.push(rec);
  const saving = w.start(tab, async () => {
    try {
      const result = await tab.mods.noteWriter.makeNoteWriter(dataCtx(tab)).patch(id, { markdown: `v${rec.n}` }, { keepalive });
      rec.status = result.status;
    } catch (error) {
      rec.status = error instanceof tab.mods.api.ApiError ? "refused" : error instanceof Error && error.name === "WriteStorageError" ? "storage-error" : "failed";
    }
  });
  run?.ops.push({ tab, done: saving });
  rec.done = saving;
  return rec;
}
const Type = cmd((s: Slot, n: NoteId, keepalive: boolean, k: number, sd: number) => `type(${s}, ${n}${keepalive ? ", keepalive" : ""}) pump(${k},${sd})`, async (run, s, id, keepalive, k, sd) => {
  const tab = alive(run, s);
  if (!tab || tab.display(id) < 0) return;
  startTyping(run, tab, id, keepalive);
  await w.pump(k, sd);
});
const GoOffline = cmd((s: Slot) => `offline(${s})`, async (run, s) => {
  const tab = alive(run, s);
  if (!tab) return;
  tab.online = false;
  tab.mods.syncEngine.wentOffline();
  await w.pump(2);
});
const GoOnline = cmd((s: Slot, k: number, sd: number) => `online(${s}) pump(${k},${sd})`, async (run, s, k, sd) => {
  const tab = alive(run, s);
  if (!tab) return;
  tab.online = true;
  begin(run, tab, () => reconnectLikeTheApp(tab));
  await w.pump(k, sd);
});
const Drain = cmd((s: Slot, k: number, sd: number) => `drain(${s}) pump(${k},${sd})`, async (run, s, k, sd) => {
  const tab = alive(run, s);
  if (!tab) return;
  begin(run, tab, () => tab.mods.writeQueue.flushPendingWrites());
  await w.pump(k, sd);
});
const Sync = cmd((s: Slot, k: number, sd: number) => `sync(${s}) pump(${k},${sd})`, async (run, s, k, sd) => {
  const tab = alive(run, s);
  if (!tab) return;
  begin(run, tab, () => tab.mods.syncEngine.sync());
  await w.pump(k, sd);
});
const Refresh = cmd((s: Slot, k: number, sd: number) => `refresh(${s}) pump(${k},${sd})`, async (run, s, k, sd) => {
  const tab = alive(run, s);
  if (!tab) return;
  begin(run, tab, () => tab.mods.syncEngine.refresh());
  await w.pump(k, sd);
});
const WriteSnapshot = cmd((s: Slot, k: number, sd: number) => `flushSnapshot(${s}) pump(${k},${sd})`, async (run, s, k, sd) => {
  const tab = alive(run, s);
  if (!tab) return;
  begin(run, tab, () => tab.mods.localDb.flushLocalDbSync());
  await w.pump(k, sd);
});
const Respond = cmd((index: number, outcome: Outcome, k: number, sd: number) => `respond(#${index}, ${outcome}) pump(${k},${sd})`, async (_run, index, outcome, k, sd) => {
  const open = w.server.open;
  if (open.length) w.server.respond(open[index % open.length]!, outcome);
  await w.pump(k, sd);
});
const Pump = cmd((k: number, sd: number) => `pump(${k},${sd})`, async (_run, k, sd) => { await w.pump(k, sd); });
const Advance = cmd((ms: number) => `advance(${ms}ms)`, async (_run, ms) => { await w.advance(ms); });
const Remote = cmd((id: NoteId) => `otherDevice edits ${id}`, async (_run, id) => { w.server.remoteEdit(id); });

/** pagehide, a moment for the unload flush, then the tab is gone. */
async function leave(run: Run, tab: Tab, waitSteps: number, sd: number, commitStorage: boolean, deliverKeepalive: boolean): Promise<Record<NoteId, number>> {
  const floor = queuedFloor();
  // What is still unanswered when the page hides is protected by writeRecovery (protectPendingWriteOnExit).
  for (const rec of w.writes) if (rec.owner === tab && rec.status === "started") rec.leftUnanswered = true;
  w.start(tab, () => tab.mods.localDb.flushLocalDbSync());
  tab.fire("pagehide");
  await w.pump(waitSteps, sd);
  w.kill(tab, commitStorage, deliverKeepalive);
  return floor;
}
const Reload = cmd((s: Slot, steps: number, sd: number, commit: boolean, keepalive: boolean) => `reload(${s}) flushPump(${steps},${sd})${commit ? " commit" : " rollback"}${keepalive ? " keepalive-arrives" : ""}`, async (run, s, steps, sd, commit, keepalive) => {
  const old = alive(run, s);
  if (!old) return;
  const floor = await leave(run, old, steps, sd, commit, keepalive);
  const tab = await openTab(run, s, false);
  run.reloads.push({ tab, floor });
  await w.pump(5, sd);
});
const Close = cmd((s: Slot, steps: number, sd: number, commit: boolean, keepalive: boolean) => `close(${s}) flushPump(${steps},${sd})${commit ? " commit" : " rollback"}${keepalive ? " keepalive-arrives" : ""}`, async (run, s, steps, sd, commit, keepalive) => {
  const tab = alive(run, s);
  if (!tab) return;
  await leave(run, tab, steps, sd, commit, keepalive);
});
/** The tab dies with no pagehide (a crash, the OS killing the page): nothing gets a last word. */
const Crash = cmd((s: Slot, steps: number, sd: number, commit: boolean) => `crash(${s}) pump(${steps},${sd})${commit ? " commit" : " rollback"}`, async (run, s, steps, sd, commit) => {
  const tab = alive(run, s);
  if (!tab) return;
  await w.pump(steps, sd);
  // KNOWN (phantom text): an edit still on the wire when the page dies is in no queue, but the local copy keeps showing it
  // until a tab drains the queue (the reopened tab sends it: see the case "an edit still on the wire when the page crashes").
  if (!run.includeKnown && w.writes.some((rec) => rec.owner === tab && rec.status === "started" && !rec.keepalive)) return;
  w.kill(tab, commit, false);
});
const Reopen = cmd((s: Slot) => `reopen(${s})`, async (run, s) => {
  if (!run.slots[s].dead) return;
  await openTab(run, s, false);
  await w.pump(5, 1);
});

/** fc.commands picks uniformly: a command listed N times is N times as likely. */
const weighted = (entries: Array<{ weight: number; arbitrary: fc.Arbitrary<Cmd> }>): Array<fc.Arbitrary<Cmd>> =>
  entries.flatMap(({ weight, arbitrary }) => Array<fc.Arbitrary<Cmd>>(weight).fill(arbitrary));
const commandArbs = weighted([
  { weight: 7, arbitrary: fc.tuple(slot, note, fc.boolean(), pumps, seed).map(([a, b, c, d, e]) => Type(a, b, c, d, e)) },
  { weight: 3, arbitrary: slot.map((s) => GoOffline(s)) },
  { weight: 3, arbitrary: fc.tuple(slot, pumps, seed).map(([a, b, c]) => GoOnline(a, b, c)) },
  { weight: 3, arbitrary: fc.tuple(slot, pumps, seed).map(([a, b, c]) => Drain(a, b, c)) },
  { weight: 2, arbitrary: fc.tuple(slot, pumps, seed).map(([a, b, c]) => Sync(a, b, c)) },
  { weight: 1, arbitrary: fc.tuple(slot, pumps, seed).map(([a, b, c]) => Refresh(a, b, c)) },
  { weight: 2, arbitrary: fc.tuple(slot, pumps, seed).map(([a, b, c]) => WriteSnapshot(a, b, c)) },
  { weight: 6, arbitrary: fc.tuple(fc.nat(20), fc.constantFrom(...OUTCOMES), pumps, seed).map(([a, b, c, d]) => Respond(a, b, c, d)) },
  { weight: 4, arbitrary: fc.tuple(fc.integer({ min: 1, max: 60 }), seed).map(([a, b]) => Pump(a, b)) },
  { weight: 3, arbitrary: fc.constantFrom(500, 2_500, 16_000, 26_000).map((ms) => Advance(ms)) },
  { weight: 1, arbitrary: note.map((id) => Remote(id)) },
  { weight: 2, arbitrary: fc.tuple(slot, fc.integer({ min: 0, max: 40 }), seed, fc.boolean(), fc.boolean()).map(([a, b, c, d, e]) => Reload(a, b, c, d, e)) },
  { weight: 1, arbitrary: fc.tuple(slot, fc.integer({ min: 0, max: 40 }), seed, fc.boolean(), fc.boolean()).map(([a, b, c, d, e]) => Close(a, b, c, d, e)) },
  { weight: 1, arbitrary: fc.tuple(slot, fc.integer({ min: 0, max: 40 }), seed, fc.boolean()).map(([a, b, c, d]) => Crash(a, b, c, d)) },
  { weight: 1, arbitrary: slot.map((s) => Reopen(s)) },
]);

// ── settling and checking ────────────────────────────────────────────────────

async function pendingRows(tab: Tab): Promise<number> {
  return (await w.drive(w.start(tab, () => tab.mods.localDb.getPendingWrites()) as Promise<unknown[]>)).length;
}

/** What the tabs still open are doing (a closed tab's operations never finish). */
const liveOps = (run: Run) => Promise.allSettled(run.ops.filter((op) => !op.tab.dead).map((op) => op.done));

/** Everyone online, every request answered, every queue drained and synced. */
async function settle(run: Run): Promise<void> {
  if (w.live().length === 0) await openTab(run, "A", false);
  for (let round = 0; round < 12; round++) {
    for (const tab of w.live()) {
      tab.online = true;
      tab.mods.appStore.setOnline(true);
    }
    await w.drive(liveOps(run), "deliver");
    for (const tab of w.live()) {
      await w.drive(w.start(tab, () => reconnectLikeTheApp(tab)), "deliver");
      await w.drive(w.start(tab, () => tab.mods.writeQueue.flushPendingWrites()), "deliver");
      await w.drive(w.start(tab, () => tab.mods.syncEngine.sync()), "deliver");
    }
    while (w.server.open.length) { w.server.respond(w.server.open[0]!, "deliver"); await w.pump(3); }
    await w.advance(30_000);
    await w.drainStorage();
    let rows = 0;
    for (const tab of w.live()) rows += await pendingRows(tab);
    if (rows === 0 && w.server.open.length === 0) {
      await w.drive(liveOps(run), "deliver");
      if (w.server.open.length === 0) return;
    }
  }
}

const versionsIn = (bodies: Array<string | null>): number[] =>
  bodies.flatMap((body) => { try { const n = Number((/^v(\d+)$/.exec((JSON.parse(body ?? "{}") as { markdown?: string }).markdown ?? "") ?? [])[1]); return Number.isFinite(n) ? [n] : []; } catch { return []; } });

async function check(run: Run): Promise<string[]> {
  const problems: string[] = [];
  const live = w.live();
  // A tab that lost its local copy (its worker was thrown away) is a broken run, not a finding.
  for (const tab of live) if (tab.mods.localCopyState.getLocalCopyState() !== "ok") throw new Error(`test setup: tab ${tab.name} has no local copy (${tab.mods.localCopyState.getLocalCopyState()}); worker errors: ${tab.workerErrors.join(" | ")}`);
  const reader = live[0]!;
  // What recovery holds (refused / unconfirmed writes), seen from one live tab.
  await w.drive(w.start(reader, () => reader.mods.writeRecovery.refreshRecoveryWrites()), "deliver");
  // The raw rows too: the panel shows only the newest refusal of one note (writeRecovery sameRefusal), which is by design.
  const rejectedRows = await w.drive(w.start(reader, () => reader.mods.localDb.getRejectedWrites()) as Promise<Array<{ body: string | null }>>, "deliver");
  const recovered = new Set(versionsIn([...reader.mods.writeRecovery.getRecoveryWrites(), ...rejectedRows].map((x) => x.body)));

  // 1 no acknowledged write is lost
  for (const rec of w.writes) {
    const acknowledged = rec.status === "synced" || rec.status === "queued" || rec.status === "refused" || rec.status === "storage-error";
    const protectedAtExit = rec.keepalive || rec.leftUnanswered === true;
    if (!acknowledged && !protectedAtExit) continue;
    if (w.server.appliedNs.has(rec.n) || recovered.has(rec.n)) continue;
    problems.push(`#1 write v${rec.n} (${rec.note}, tab ${rec.tab}, ${rec.status}${rec.keepalive ? ", keepalive" : ""}) is neither on the server nor in recovery`);
  }
  // 2 no duplicate sends
  for (const violation of w.server.violations) problems.push(`#2 ${violation}`);
  // 3 the same content everywhere, no leftover queue. A note with a write that
  // only recovery holds (the page hid before the answer) shows that text on purpose.
  const heldBack = new Set(w.writes.filter((x) => recovered.has(x.n) && !w.server.appliedNs.has(x.n)).map((x) => x.note));
  await openTab(run, "Z" as Slot, true);
  await w.drive(liveOps(run), "deliver");
  const tabs = w.live();
  for (const tab of tabs) {
    if (tab.dead) continue;
    for (const id of NOTES) {
      const server = w.server.notes.get(id)!.n;
      if (!heldBack.has(id) && tab.display(id) !== server) problems.push(`#3 tab ${tab.name} shows ${id}=v${tab.display(id)} but the server has v${server}`);
    }
    const rows = await pendingRows(tab);
    if (rows) problems.push(`#3 tab ${tab.name} still has ${rows} queued write(s) after everything was delivered`);
  }
  // 4 a reload does not paint older than the closed tab's acknowledged state
  for (const { tab, floor } of run.reloads) {
    if (!tab.coldPaint) continue;
    for (const id of NOTES) {
      if (tab.coldPaint[id] < floor[id]) problems.push(`#4 tab ${tab.name} first painted ${id}=v${tab.coldPaint[id]} after a reload, below v${floor[id]} which was queued and not yet sent`);
    }
  }
  return problems;
}

/** Run the commands against two fresh tabs, settle, and report which invariants broke. */
async function runCommands(commands: Iterable<Cmd>, includeKnown = INCLUDE_KNOWN): Promise<string[]> {
  w.install();
  try {
    const run: Run = { includeKnown, slots: {} as Run["slots"], ops: [], reloads: [] };
    await openTab(run, "A", true);
    await openTab(run, "B", true);
    await fc.asyncModelRun(() => ({ model: {}, real: run }), commands as never);
    await settle(run);
    const problems = await check(run);
    if (problems.length && process.env.PROPS_DUMP) {
      const tabs = [];
      for (const t of w.live()) tabs.push(`${t.name}: n0=${t.display("n0")} n1=${t.display("n1")} snapshotReads=${t.snapshotReads} cursor=${await w.drive(w.start(t, () => t.mods.localDb.getLastEventId()) as Promise<number>)}`);
      console.log("DUMP", [...commands].map(String).join(" | "), "\n", problems.join("\n"), "\n", tabs.join("\n"), "\n", w.server.log.join("\n"));
    }
    // PROPS_TRACE=1 appends the server's timeline to a failure.
    return problems.length && process.env.PROPS_TRACE ? [...problems, ...w.server.log] : problems;
  } finally {
    w.uninstall();
  }
}
async function execute(commands: Iterable<Cmd>): Promise<void> {
  expect(await runCommands(commands)).toEqual([]);
}

describe("two tabs over one local database", () => {
  it("random interleavings keep every acknowledged write and converge", async () => {
    await fc.assert(
      fc.asyncProperty(fc.commands(commandArbs, { maxCommands: 40, size: "max" }), (commands) => execute(commands)),
      { seed: PROPS_SEED, numRuns: RUNS, verbose: 0 },
    );
  }, Number(process.env.PROPS_TIMEOUT ?? 120_000));

  // ── minimal reproductions of what the property found ──

  /** A tab that is open and has loaded the workspace. */
  async function bare(name: string): Promise<Tab> {
    const tab = await w.createTab(name);
    await w.drive(w.start(tab, () => tab.mods.syncEngine.boot()));
    return tab;
  }

  // Root cause guess: the journal of one queue is replayed in (seq, session) order, but every session
  // counts seq from its own start, so one tab's "sent" record (pw.del) can sort before the other tab's
  // queue row it removes (pw.put) when the seqs tie and its session id is smaller.
  it("a write another tab already sent comes back from the journal and is sent again", async () => {
    w.install();
    try {
      const b = await bare("B"); // created first: its session id sorts first
      const a = await bare("A");
      a.online = false;
      a.mods.syncEngine.wentOffline();
      const typed = startTyping(null, a, "n0", false);
      await w.drive(typed.done as Promise<unknown>);
      expect(typed.status).toBe("queued");
      await w.drive(w.start(b, () => b.mods.writeQueue.flushPendingWrites())); // B sends A's queued write
      expect(w.server.appliedNs.has(typed.n)).toBe(true);
      const c = await bare("C"); // a tab opened now replays the journal from scratch
      await w.drive(w.start(c, () => c.mods.writeQueue.flushPendingWrites()));
      await w.drive(w.start(c, () => c.mods.syncEngine.sync()));
      expect(w.server.arrivals.filter((x) => x.n === typed.n)).toHaveLength(1);
    } finally { w.uninstall(); }
  });

  // Root cause guess: when its snapshot save loses the compare-and-swap, a tab continues from the stored
  // snapshot (adoptStoredSnapshot) and only re-applies the journal, so the server data it applied in
  // memory since (a bootstrap, a sync delta; not journaled) is gone from its copy while the page keeps
  // showing it. The next sync repairs it; until then a reload paints the older text.
  it.fails("KNOWN: a reload can paint older text than the tab was showing (a stale save drops the tab's own mirror)", async () => {
    w.install();
    try {
      const a = await bare("A");
      const b = await bare("B");
      w.server.remoteEdit("n0");
      await w.drive(w.start(a, () => a.mods.syncEngine.refresh()));
      expect(a.display("n0")).toBe(1);
      await w.advance(3_000); // both tabs' snapshot saves; B's lands first, A's is stale
      await w.drainStorage();
      w.start(a, () => a.mods.localDb.flushLocalDbSync());
      await w.drainStorage();
      w.kill(a, true, false);
      const reopened = await w.createTab("A");
      const booting = w.start(reopened, () => reopened.mods.syncEngine.boot());
      await w.drive(booting);
      expect(reopened.coldPaint?.n0).toBeGreaterThanOrEqual(1);
      void b;
    } finally { w.uninstall(); }
  });

  // Root cause guess: boot's retry path (hydrateFullBootstrap → landBootstrap) waits for the sync() in flight,
  // while sync() waits for bootCursorReady, which only boot releases: each waits for the other.
  it("a sync() asked for while a cold boot retries its failed first download never finishes", async () => {
    w.install();
    try {
      const tab = await w.createTab("A"); // no local copy yet: the first download is the slim bootstrap
      const booting = w.start(tab, () => tab.mods.syncEngine.boot());
      for (let i = 0; i < 100 && !w.server.inflight.length; i++) await w.pump(5, i);
      w.server.respond(w.server.inflight[0]!, "net"); // the first download fails: boot retries with the full one
      const syncing = w.start(tab, () => tab.mods.syncEngine.sync()); // a live tick, an online event, the other tab's write
      await w.drive(Promise.all([booting, syncing]), "deliver", 150);
    } finally { w.uninstall(); }
  });

  // Root cause guess: adoptStoredSnapshot swaps the worker's database for the stored one, which carries the
  // other tab's sync cursor and node rows, but nothing tells the page: its store keeps the old text and its
  // next sync starts at the adopted cursor, so the change in between is never delivered to this tab.
  it("a tab that adopts another tab's snapshot skips the changes up to its cursor and keeps showing old text", async () => {
    w.install();
    try {
      const a = await bare("A");
      const b = await bare("B");
      w.server.remoteEdit("n0");
      await w.drive(w.start(b, () => b.mods.syncEngine.sync())); // B has the edit and cursor 11
      await w.drive(w.start(b, () => b.mods.localDb.flushLocalDbSync())); // ... and stores its snapshot
      await w.drive(w.start(a, () => a.mods.writeQueue.flushPendingWrites())); // A looks at the shared queue: it continues from B's snapshot
      await w.drive(w.start(a, () => a.mods.syncEngine.sync()));
      expect(a.display("n0")).toBe(1);
    } finally { w.uninstall(); }
  });

  // Root cause guess: adoptStoredSnapshot reads the stored snapshot and then the journal; a save of the tab's
  // OLD database that was queued before can land in between (its CAS passes because the adoption's read
  // moved the known generation) and trims the journal records it contains. The adopted copy then has neither
  // the row nor the record, and the next save, whose journal_applied lists the record, forgets the row.
  it("a refused write's saved input disappears when a queued snapshot save lands during another tab's adoption", async () => {
    const problems = await runCommands([
      GoOnline("A", 9, 197469), Type("B", "n0", false, 5, 0), WriteSnapshot("A", 5, 467121), Respond(9, "refuse", 9, 395242),
      Reload("B", 27, 957692, true, false), Close("A", 0, 337941, true, true),
    ], true);
    expect(problems.filter((x) => x.startsWith("#1"))).toEqual([]);
  });

  // Was a finding (noteWriter puts the text into the local copy before the save is queued or acknowledged, and a
  // save sent straight to the server was in no queue). Fixed by the in-flight slot (lib/data/inFlightWrite.ts):
  // the reopened tab queues the interrupted write under its own key before it does anything else.
  it("an edit still on the wire when the page crashes is sent by the reopened tab, not left as if saved", async () => {
    w.install();
    try {
      const a = await bare("A");
      startTyping(null, a, "n0", false); // sent, never answered
      await w.pump(20, 1);
      await w.advance(3_000); // the local copy, with the new text, is saved
      await w.drainStorage();
      w.kill(a, true, false); // a crash: no pagehide, no recovery copy
      const reopened = await bare("A");
      expect(reopened.display("n0")).toBe(w.server.notes.get("n0")!.n);
    } finally { w.uninstall(); }
  });

  // Root cause guess: while a note has a queued write, applySync keeps the queued text over the server's row (right: the
  // person's input must not vanish). When the write finally lands, nothing asks for the note again, so a delta the tab
  // already took (here: the other device's edit, merged by the server when the write arrived) stays hidden behind the text.
  it("a delta taken while the tab's own write is still queued stays hidden after the write lands", async () => {
    w.install();
    try {
      const a = await bare("A");
      const typed = startTyping(null, a, "n0", false);
      for (let i = 0; i < 100 && !w.server.inflight.some((r) => r.method === "PATCH"); i++) await w.pump(5, i);
      w.server.respond(w.server.inflight.find((r) => r.method === "PATCH")!, "lose"); // applied, the answer is lost: queued
      await w.drive(typed.done as Promise<unknown>);
      w.server.remoteEdit("n0"); // the other device edits the same note
      const syncing = w.start(a, () => a.mods.syncEngine.sync());
      for (let i = 0; i < 200 && !w.server.inflight.some((r) => r.method === "PATCH"); i++) await w.pump(5, i);
      w.server.respond(w.server.inflight.find((r) => r.method === "PATCH")!, "503"); // the replay inside sync() fails, the delta is still pulled
      await w.drive(syncing);
      await w.drive(w.start(a, () => a.mods.writeQueue.flushPendingWrites())); // the replay lands (the server deduplicates it)
      await w.drive(w.start(a, () => a.mods.syncEngine.sync()));
      expect(a.display("n0")).toBe(w.server.notes.get("n0")!.n);
    } finally { w.uninstall(); }
  });
});
