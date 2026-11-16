// The connection lifecycle (lib/data/connectivity.ts) and the sync engine entry points it orders
// (lib/data/syncEngine.ts: boot, refresh, sync, reconnect, wentOffline), driven by random sequences
// against a fake server and a fake window.
//
// Real: connectivity, syncEngine, writeQueue, noteWriter, appStore, the real `api()` / `apiFetch()`
// and the REAL local copy (localDb RPC → localDbWorker with sql.js → snapshot adapter over the fake
// IndexedDB of test/helpers/tabWorld.ts). test/syncLiveness.test.tsx mocks the whole local layer, and
// that is how a defect in what the local layer does between two steps stayed hidden. Faked: the
// network (`fetch`, answering for a server that is up, down, a 502 gateway, slow or has removed the
// account), the window's online/offline events, `navigator.onLine`, `document.visibilityState` and the clock.
//
// Commands (any order): server up / down / 502 / slow / access removed; the browser's `offline` and
// `online` events; a page reload (boot again over the same local copy); the tab hidden / visible; a
// refresh() or a delta sync() asked for; a note save; time passing.
//
// Invariants (checked while the run goes, and once more after a final stretch of quiet time):
//   liveness   the browser is online, the server has answered for a minute (twelve retry
//              intervals) and the account is not removed  -> the app is online, with no reload and
//              no browser `online` event, and every note save was accepted by the server
//   safety     boot, refresh() or reconnect() (the steps that DECIDE online/offline) just ended
//              while the server was unreachable  -> the app is not marked online
//              a save made while the server is unreachable is in the queue, not lost, not "synced"
//              the browser is offline  -> the app is offline and the membership gate is down
//   revoked    the account was removed  -> the app does not turn "offline", and it asks the
//              server nothing more without a person's action (no retry timer)
//   disposed   after the lifecycle's disposer ran, no listener, no retry and no store change
//              reaches boot / reconnect / sync again
//
// Known defects: none open. The three it used to steer around (revoked-while-reconnecting, queued-during-drain,
// gate-raised-offline) are fixed; their minimal cases at the bottom are plain `it`, and the generator excludes nothing.
//
// Replay:  PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/connectionLiveness
//          (fast-check prints the seed, path and the shrunk command list; PROPS_TRACE=1 appends the
//          server's timeline to a failure.)

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

vi.mock("sql.js", async (original) => {
  const real = await original<typeof import("sql.js")>();
  // One wasm load for every run; the databases a run opens are closed when it ends (World.uninstall).
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

import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";
import { dataCtx, tabContext, theWorld, type Tab } from "../helpers/tabWorld";

const w = theWorld;
/** A run starts a registry, a sql.js and a fake disk, and walks about two minutes of fake time: capped unless PROPS_RUNS is set on purpose. */
const RUNS = process.env.PROPS_RUNS ? PROPS_RUNS : Math.min(PROPS_RUNS, 40);
/** Look at the known defects instead of steering around them. */
const INCLUDE_KNOWN = !!process.env.PROPS_INCLUDE_KNOWN;
/** lib/data/connectivity.ts RECONNECT_RETRY_MS, read from the module itself in the checks below. */
const MINUTE = 60_000;

beforeAll(async () => { await (await import("sql.js")).default(); });
afterEach(() => { net.reset(); restoreVisibility(); w.uninstall(); });

// ── the fake server ──────────────────────────────────────────────────────────

type Mode = "up" | "down" | "bad-gateway" | "slow" | "revoked" | "forbidden";
const unreachable = (mode: Mode) => mode === "down" || mode === "bad-gateway";
/** readWithDeadline gives a read up after this long (lib/api.ts): a server slower than that is "unreachable" to the sync engine. */

class Net {
  mode: Mode = "up";
  slowMs = 4_000;
  head = 10;
  /** Fake time, advanced by the test's own `advance`. */
  clock = 0;
  requests = 0;
  inflight = 0;
  applied = new Set<number>();
  /** How many times each note save (by number) reached the server: a retry must not send one twice. */
  sentCount = new Map<number, number>();
  log: string[] = [];
  /** The browser is online (`navigator.onLine`); a request made while it is not never leaves the page. */
  browserOnline = true;
  /** The membership the server reports: its epoch and the ids this account may read (a change moves the epoch). */
  epoch = 0;
  readable = ["n0"];
  /** Runs when a request is about to be answered: a test that needs the network to change at an exact step. */
  beforeAnswer: ((path: string, tab: Tab | undefined) => void) | null = null;

  reset(): void {
    Object.assign(this, { mode: "up", slowMs: 4_000, head: 10, clock: 0, requests: 0, inflight: 0, browserOnline: true, beforeAnswer: null, epoch: 0, readable: ["n0"] });
    this.applied = new Set(); this.sentCount = new Map(); this.log = [];
  }

  private json(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  }
  private row() {
    return { id: "n0", title: "n0", slug: "n0", markdown: "v0", node_type: "content", source_type: "manual", parent_id: null, hidden: false, sort_order: 0, updated_at: "2026-11-14T00:00:00.000Z" };
  }
  private answer(path: string, init: RequestInit): Response {
    const method = init.method ?? "GET";
    if (method === "PATCH" && /^\/api\/nodes\/[^/]+$/.test(path)) {
      const n = Number((/^v(\d+)$/.exec((JSON.parse(String(init.body ?? "{}")) as { markdown?: string }).markdown ?? "") ?? [])[1]);
      if (Number.isFinite(n)) { this.applied.add(n); this.sentCount.set(n, (this.sentCount.get(n) ?? 0) + 1); }
      this.head += 1;
      return this.json(this.row());
    }
    if (method === "POST" && path === "/api/sync") {
      return this.json({
        last_event_id: this.head, head_event_id: String(this.head), membership_epoch: this.epoch,
        nodes: { upsert: [], delete: [] }, edges: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null,
      });
    }
    if (path.startsWith("/api/bootstrap")) {
      return this.json({
        workspace: { id: "w", name: "W", slug: "w", home_node_id: null }, actor_role: "admin", actor_is_owner: true, can_review: true,
        last_event_id: String(this.head), membership_epoch: this.epoch, server_time: "2026-11-14T00:00:00.000Z",
        nodes: [this.row()], edges: [], tasks: [], suggestions: [], events: [], tags: [],
      });
    }
    // What the membership check reads: the readable set is the one note, at epoch 0.
    if (path.startsWith("/api/sync/membership/digest")) return this.json({ epoch: this.epoch, event_cursor: String(this.head) });
    if (path.startsWith("/api/sync/membership")) return this.json({ epoch: this.epoch, event_cursor: String(this.head), ids: this.readable, next_cursor: null, tags: [] });
    return this.json({});
  }

  /** What `fetch` does. `tab` is the page the request comes from: a closed page's request is never answered. */
  fetch(tab: Tab | undefined, url: string, init: RequestInit = {}): Promise<Response> {
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    this.requests += 1;
    this.beforeAnswer?.(path, tab);
    const note = (what: string) => this.log.push(`t=${this.clock} ${tab?.name ?? "?"} ${method} ${path} -> ${what}`);
    if (tab?.dead) return new Promise(() => {});
    const failed = (): Promise<Response> => Promise.reject(new TypeError("Failed to fetch"));
    if (!this.browserOnline) { note("no network"); return failed(); }
    switch (this.mode) {
      case "down": note("down"); return failed();
      case "bad-gateway":
        note("502");
        return Promise.resolve(new Response("<html>Bad Gateway</html>", { status: 502 }));
      case "revoked":
        note("401 membership_removed");
        return Promise.resolve(this.json({ error: "membership_removed" }, 401));
      case "forbidden":
        note("403 forbidden");
        return Promise.resolve(this.json({ error: "forbidden" }, 403));
      case "slow": {
        note(`slow ${this.slowMs}ms`);
        this.inflight += 1;
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.inflight -= 1;
            resolve(this.answer(path, init));
          }, this.slowMs);
          init.signal?.addEventListener("abort", () => {
            clearTimeout(timer); this.inflight -= 1;
            reject(init.signal!.reason);
          }, { once: true });
        });
      }
      default:
        note("ok");
        return Promise.resolve(this.answer(path, init));
    }
  }
}
const net = new Net();

// ── the fake window and the page's visibility ───────────────────────────────

let hidden = false;
const realVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
function restoreVisibility(): void {
  hidden = false;
  if (realVisibility) Object.defineProperty(document, "visibilityState", realVisibility); else delete (document as { visibilityState?: unknown }).visibilityState;
}

type FakeWindow = {
  host: import("../../lib/data/connectivity").ConnectivityHost;
  listeners: { online: Set<() => void>; offline: Set<() => void> };
  fire(type: "online" | "offline"): void;
};
const windows = new WeakMap<Tab, FakeWindow>();
function fakeWindow(tab: Tab): FakeWindow {
  const listeners = { online: new Set<() => void>(), offline: new Set<() => void>() };
  const win: FakeWindow = {
    listeners,
    host: {
      get navigator() { return { onLine: tab.online }; },
      addEventListener: (type, l) => { listeners[type].add(l); },
      removeEventListener: (type, l) => { listeners[type].delete(l); },
    },
    fire(type) { for (const l of [...listeners[type]]) tabContext.run(tab, () => { void l(); }); },
  };
  windows.set(tab, win);
  return win;
}

// ── a run ────────────────────────────────────────────────────────────────────

type WriteRec = { n: number; status: string; duringOutage: boolean; tab: string };
type Counts = { boot: number; reconnect: number; sync: number; wentOffline: number };
type Run = {
  tab: Tab;
  win: FakeWindow;
  dispose: (() => void) | null;
  disposed: boolean;
  /** Fake time of the last change that restarts "answering for a minute": server mode, the browser's state, a reload, a call into the engine. */
  disturbedAt: number;
  includeKnown: boolean;
  /** The store said the account was removed (first seen after this command); `onlineBefore`: it was online just before. */
  revokedSeen: { onlineBefore: boolean } | null;
  onlineBefore: boolean;
  writes: WriteRec[];
  counts: Counts;
  /** The engine calls made once the lifecycle was disposed. */
  afterDispose: Counts | null;
  problems: string[];
  tabs: number;
  ops: Promise<unknown>[];
};

const appState = (run: Run) => run.tab.mods.appStore.getAppState();
const settleStorage = () => w.settleStorage();

/** Storage answered and the engine's boot / sync pass has ended: what a command started is over, unless the server is slow (time must pass for that). */
async function quiet(run: Run): Promise<void> {
  await settleStorage();
  if (net.mode === "slow" || run.disposed) return;
  await w.drive(w.start(run.tab, () => run.tab.mods.syncEngine.__idleSyncEngineForTests()), null, 400);
  await settleStorage();
}

function watchEngine(run: Run): void {
  // connectivity.ts reaches the engine through its module exports: counting there sees every call it makes.
  const engine = run.tab.mods.syncEngine;
  for (const name of ["boot", "reconnect", "sync", "wentOffline"] as const) {
    const original = engine[name] as (...args: unknown[]) => unknown;
    (vi.spyOn(engine as unknown as Record<string, never>, name) as unknown as { mockImplementation(fn: (...args: unknown[]) => unknown): void }).mockImplementation((...args: unknown[]) => {
      run.counts[name] += 1;
      if (run.disposed && run.afterDispose) run.afterDispose[name] += 1;
      return original(...args);
    });
  }
}

async function openTab(run: Run | null, previous?: Run): Promise<Run> {
  const tab = await w.createTab(`P${previous ? previous.tabs + 1 : 1}`);
  tab.online = previous ? previous.tab.online : true;
  const next: Run = previous ?? {
    tab, win: fakeWindow(tab), dispose: null, disposed: false, disturbedAt: 0, includeKnown: INCLUDE_KNOWN, revokedSeen: null, onlineBefore: false, writes: [],
    counts: { boot: 0, reconnect: 0, sync: 0, wentOffline: 0 }, afterDispose: null, problems: [], tabs: 1, ops: [],
  };
  if (previous) { next.tab = tab; next.win = fakeWindow(tab); next.dispose = null; next.disposed = false; next.afterDispose = null; next.tabs += 1; next.revokedSeen = null; next.onlineBefore = false; /* a reload starts offline: it is not the removal that turned the app offline */ }
  void run;
  watchEngine(next);
  tabContext.run(tab, () => { next.dispose = tab.mods.connectivity.attachConnectivity(next.win.host); });
  next.disturbedAt = net.clock;
  await quiet(next);
  return next;
}

/** An engine call the page makes on its own (a refresh button, a live tick): started, and left running. */
function begin(run: Run, fn: () => Promise<unknown>): void {
  run.disturbedAt = net.clock;
  run.ops.push(w.start(run.tab, fn));
}

async function advance(run: Run, ms: number): Promise<void> {
  const step = 1_000;
  for (let left = ms; left > 0; left -= step) {
    await w.advance(Math.min(left, step));
    net.clock += Math.min(left, step);
  }
}

// ── commands ─────────────────────────────────────────────────────────────────

type Cmd = fc.AsyncCommand<object, Run>;
/** `decides`: the command runs a step whose job is to decide online/offline (boot, refresh, reconnect). */
function cmd<A extends unknown[]>(name: (...a: A) => string, exec: (run: Run, ...a: A) => Promise<void | false>, { decides = false } = {}) {
  return (...args: A): Cmd => ({
    check: () => true,
    async run(_m, run) {
      run.onlineBefore = appState(run).online;
      const outageBefore = unreachable(net.mode) && run.tab.online;
      const acted = await exec(run, ...args);
      await quiet(run);
      checkLive(run);
      // The step came to an end against a server that was unreachable the whole time: it must not leave the app online.
      if (decides && acted !== false && outageBefore && unreachable(net.mode) && run.tab.online && net.inflight === 0 && appState(run).online && !appState(run).accessRevoked) {
        run.problems.push(`safety: ${name(...args)} ended while the server was unreachable (${net.mode}) and the app is still marked online (t=${net.clock})\n${net.log.slice(-4).join("\n")}`);
      }
    },
    toString: () => name(...args),
  });
}

const SetServer = cmd((mode: Mode, slowMs: number) => `server(${mode}${mode === "slow" ? `, ${slowMs}ms` : ""})`, async (run, mode, slowMs) => {
  // Once the account is removed it stays removed.
  if (net.mode === "revoked") return;
  net.mode = mode; net.slowMs = slowMs;
  run.disturbedAt = net.clock;
});
const BrowserOffline = cmd(() => "browser offline", async (run) => {
  if (!run.tab.online) return;
  run.tab.online = false; net.browserOnline = false;
  run.disturbedAt = net.clock;
  run.win.fire("offline");
});
const BrowserOnline = cmd(() => "browser online", async (run) => {
  if (run.tab.online) return false;
  run.tab.online = true; net.browserOnline = true;
  run.disturbedAt = net.clock;
  run.win.fire("online");
}, { decides: true });
const Reload = cmd(() => "reload", async (run) => {
  run.dispose?.();
  await Promise.resolve();
  w.start(run.tab, () => run.tab.mods.localDb.flushLocalDbSync());
  run.tab.fire("pagehide");
  await w.pump(8, 3);
  w.kill(run.tab, true, false);
  await openTab(null, run);
}, { decides: true });
const SetHidden = cmd((value: boolean) => (value ? "tab hidden" : "tab visible"), async (run, value) => {
  hidden = value;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
  run.disturbedAt = net.clock;
  run.tab.fire("visibilitychange");
});
const Refresh = cmd(() => "refresh()", async (run) => {
  begin(run, () => run.tab.mods.syncEngine.refresh());
}, { decides: true });
const Sync = cmd(() => "sync()", async (run) => { begin(run, () => run.tab.mods.syncEngine.sync()); });
const Advance = cmd((ms: number) => `advance(${ms}ms)`, async (run, ms) => { await advance(run, ms); });
/** The account loses the note on the server (its membership epoch moves). */
const ChangeMembership = cmd(() => "membership changes (note lost)", async (run) => { net.epoch += 1; net.readable = []; run.disturbedAt = net.clock; });
const Write = cmd(() => "save a note", async (run) => {
  const tab = run.tab;
  if (tab.display("n0" as never) < 0) return;
  const rec: WriteRec = { n: run.writes.length + 1, status: "started", duringOutage: unreachable(net.mode) || !net.browserOnline, tab: tab.name };
  run.writes.push(rec);
  run.disturbedAt = net.clock;
  run.ops.push(w.start(tab, async () => {
    try { rec.status = (await tab.mods.noteWriter.makeNoteWriter(dataCtx(tab)).patch("n0", { markdown: `v${rec.n}` })).status; }
    catch { rec.status = "failed"; }
  }));
});

const weighted = (entries: Array<{ weight: number; arbitrary: fc.Arbitrary<Cmd> }>): Array<fc.Arbitrary<Cmd>> =>
  entries.flatMap(({ weight, arbitrary }) => Array<fc.Arbitrary<Cmd>>(weight).fill(arbitrary));
const commandArbs = weighted([
  { weight: 8, arbitrary: fc.tuple(fc.constantFrom<Mode>("up", "up", "down", "bad-gateway", "slow"), fc.constantFrom(3_000, 20_000)).map(([m, s]) => SetServer(m, s)) },
  { weight: 1, arbitrary: fc.constant(SetServer("revoked", 0)) },
  { weight: 4, arbitrary: fc.constant(BrowserOffline()) },
  { weight: 4, arbitrary: fc.constant(BrowserOnline()) },
  { weight: 2, arbitrary: fc.constant(Reload()) },
  { weight: 2, arbitrary: fc.boolean().map((h) => SetHidden(h)) },
  { weight: 3, arbitrary: fc.constant(Refresh()) },
  { weight: 3, arbitrary: fc.constant(Sync()) },
  { weight: 2, arbitrary: fc.constant(Write()) },
  { weight: 9, arbitrary: fc.constantFrom(1_000, 4_000, 5_000, 16_000, 30_000, 61_000).map((ms) => Advance(ms)) },
]);

// ── invariants ───────────────────────────────────────────────────────────────

/** Checked after every command, with the page settled as far as fake time allows. */
function checkLive(run: Run): void {
  if (run.disposed) return;
  const state = appState(run);
  const quiet = net.clock - run.disturbedAt;
  const settled = net.inflight === 0 && state.bootstrapped;
  const browserOnline = run.tab.online;
  const revoked = state.accessRevoked;

  // revoked: the removal is not "offline"
  if (revoked && !run.revokedSeen) {
    run.revokedSeen = { onlineBefore: run.onlineBefore };
    if (run.onlineBefore && browserOnline && !state.online) run.problems.push(`revoked: the account was removed while the app was online, and the app now reads as offline (t=${net.clock})`);
  }

  // usable: a server that cannot be reached is offline, never a locked workspace (owner decision 2026-11-15)
  if (browserOnline && unreachable(net.mode) && !revoked && settled && quiet >= 10_000 && state.membershipGated) {
    run.problems.push(`usable: the browser is online, the server cannot be reached (${net.mode}) and the workspace is still locked behind the membership gate (t=${net.clock})\n${net.log.slice(-4).join("\n")}`);
  }
  // revoked, for good: once the server refused on purpose the shell keeps the notice over the workspace (BuilderWorkspace: inert while accessRevoked)
  if (run.revokedSeen && !revoked) run.problems.push(`revoked: the removal notice went away after the server had refused the account (t=${net.clock})`);

  // liveness
  if (browserOnline && net.mode === "up" && !revoked && settled && quiet >= MINUTE) {
    if (!state.online) run.problems.push(`liveness: the browser is online and the server has answered for ${Math.round(quiet / 1000)} s, but the app is not online (t=${net.clock})\n${net.log.slice(-4).join("\n")}`);
  }
  // safety: the browser itself is offline
  if (!browserOnline && settled && quiet >= 10_000) {
    if (state.online) run.problems.push(`safety: the browser is offline but the app is marked online (t=${net.clock})`);
    if (state.membershipGated && !revoked) run.problems.push(`safety: the browser is offline and the membership gate is still up (t=${net.clock})`);
  }
}

// ── settling and the final checks ────────────────────────────────────────────

async function pendingRows(run: Run): Promise<number> {
  const rows = await w.drive(w.start(run.tab, () => run.tab.mods.localDb.getPendingWrites()) as Promise<unknown[]>, null);
  return rows.length;
}

async function finish(run: Run): Promise<string[]> {
  // The last stretch: nothing else happens. The server comes back (unless the account is gone); the browser stays as it is.
  if (net.mode !== "revoked") { net.mode = "up"; run.disturbedAt = net.clock; }
  // The person looks at the page again: a hidden tab pauses the write queue's retries on purpose (writeQueue.ts waits for `visible`).
  if (hidden) {
    hidden = false;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    run.tab.fire("visibilitychange");
  }
  for (let i = 0; i < 3; i++) { await advance(run, 61_000); await settleStorage(); checkLive(run); }
  const state = appState(run);
  if (net.mode === "revoked" && state.accessRevoked) {
    // After the notice: asking again is the page being told nothing, so any request in a quiet stretch is a retry.
    await advance(run, 10_000); await settleStorage();
    const before = net.requests;
    await advance(run, 61_000); await settleStorage();
    if (net.requests !== before) run.problems.push(`revoked: ${net.requests - before} request(s) reached the server in a quiet minute after the account was removed (a retry):\n${net.log.slice(-6).join("\n")}`);
  }
  // writes: made while the server was unreachable → queued; and everything made is accepted by the end
  for (const rec of run.writes) {
    if (rec.duringOutage && rec.status === "synced") run.problems.push(`writes: save #${rec.n} was made while the server was unreachable and reported as synced`);
    // A save whose page was reloaded while it was in flight is the reload's business (writeRecovery, tested elsewhere), not this property's.
    if (rec.status === "started" && rec.tab === run.tab.name && run.tab.online && net.mode === "up") run.problems.push(`writes: save #${rec.n} never finished after a quiet stretch with the server up`);
  }
  if (run.tab.online && net.mode === "up" && !state.accessRevoked) {
    const rows = await pendingRows(run);
    if (rows) run.problems.push(`writes: ${rows} save(s) still wait in the offline queue after the server answered for three minutes`);
    for (const rec of run.writes) {
      if (rec.status === "queued" && !net.applied.has(rec.n)) run.problems.push(`writes: queued save #${rec.n} never reached the server`);
    }
  }
  for (const [n, times] of net.sentCount) if (times > 1) run.problems.push(`writes: save #${n} reached the server ${times} times`);
  // dispose: nothing keeps going
  run.disposed = true;
  run.afterDispose = { boot: 0, reconnect: 0, sync: 0, wentOffline: 0 };
  run.dispose?.();
  await Promise.resolve(); await Promise.resolve();
  await settleStorage();
  const requestsAtDispose = net.requests;
  const listeners = run.win.listeners.online.size + run.win.listeners.offline.size;
  if (listeners) run.problems.push(`disposed: ${listeners} window listener(s) are still attached`);
  net.mode = "down"; // every stray retry would now have something to report
  run.win.fire("online"); run.win.fire("offline");
  run.tab.mods.appStore.setOnline(false); run.tab.mods.appStore.setOnline(true);
  await advance(run, 120_000); await settleStorage();
  const late = run.afterDispose;
  if (late.boot + late.reconnect + late.sync + late.wentOffline) {
    run.problems.push(`disposed: the engine was called after the lifecycle was disposed (boot ${late.boot}, reconnect ${late.reconnect}, sync ${late.sync}, wentOffline ${late.wentOffline})`);
  }
  void requestsAtDispose;
  return run.problems;
}

async function runCommands(commands: Iterable<Cmd>, includeKnown = INCLUDE_KNOWN, prepare?: () => void, inspect?: (run: Run) => Promise<void>): Promise<string[]> {
  w.install();
  net.reset();
  prepare?.();
  restoreVisibility();
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => net.fetch(tabContext.getStore(), String(input), init));
  try {
    const run = await openTab(null);
    run.includeKnown = includeKnown;
    await fc.asyncModelRun(() => ({ model: {}, real: run }), commands as never);
    await inspect?.(run);
    const problems = await finish(run);
    const unexpected = [...run.tab.unexpected, ...w.tabs.flatMap((t) => t.unexpected)].map((e) => `unexpected: ${String(e)}`);
    const all = [...problems, ...unexpected];
    if (process.env.PROPS_DUMP) console.log("DUMP", [...commands].map(String).join(" | "), `\nonline=${appState(run).online} gated=${appState(run).membershipGated}\n`, net.log.join("\n"));
    return all.length && process.env.PROPS_TRACE ? [...all, ...net.log] : all;
  } finally {
    w.uninstall();
    net.reset();
    restoreVisibility();
  }
}
const execute = async (commands: Iterable<Cmd>) => { expect(await runCommands(commands)).toEqual([]); };

// ── the property ─────────────────────────────────────────────────────────────

describe("the connection lifecycle against random server and browser states", () => {
  it("liveness, safety, revocation and disposal hold for any sequence", async () => {
    await fc.assert(
      fc.asyncProperty(fc.commands(commandArbs, { maxCommands: 30, size: "max" }), (commands) => execute(commands)),
      { seed: PROPS_SEED, numRuns: RUNS, verbose: 0 },
    );
  }, Number(process.env.PROPS_TIMEOUT ?? 300_000));
});

// ── minimal reproductions of what the property found ─────────────────────────
// Each is a command list the shrinker ended on, replayed with the steering off. The seed is the default one
// (20261023): `PROPS_SEED=20261023 PROPS_RUNS=<n>` reaches the same family at the run count named.
// Each was `it.fails` until its fix landed; they are kept as plain `it` so the defect stays pinned.

describe("what the property found (minimal cases, fixed)", () => {
  // Control: with the browser's own `online` event the retry exists, so the app does come back.
  it("a server that is down when the browser comes back online is asked again every 5 s, and the app ends online", async () => {
    expect(await runCommands([BrowserOffline(), SetServer("down", 0), BrowserOnline(), Advance(16_000), SetServer("up", 0)], true)).toEqual([]);
  });

  // seed 20261023, found at 18 runs with `server(bad-gateway), reload`, shrunk 5 times.
  // Scenario: the page loads while the gateway answers 502; the browser stays online; the server then recovers.
  // Expected: the app goes online by itself. Actual: boot() ends offline (syncEngine.ts runBoot catch → setOnline(false), endedOffline = true),
  // connectivity.ts only schedules a retry from handleOnline (the browser's `online` event), which never fires. Offline for good until a reload.
  it("KNOWN stuck-offline-server-unreachable: a page loaded while the server answers 502 never reconnects once it recovers", async () => {
    expect(await runCommands([SetServer("bad-gateway", 0), Reload()], true)).toEqual([]);
  });

  // seed 20261023, found at 38 runs with `server(slow, 20000ms), reload, sync()`: a server slower than the 15 s read deadline counts as unreachable.
  it("KNOWN stuck-offline-server-unreachable: a page loaded while the server is slower than the read deadline never reconnects", async () => {
    expect(await runCommands([SetServer("slow", 20_000), Reload()], true)).toEqual([]);
  });

  // Same family from refresh(): syncEngine.ts refreshWhole `if (isServerUnreachable(error)) setOnline(false)` with nobody scheduled to ask again.
  // (The Advance first lets boot's own deferred full download finish: left pending it would answer later and put the app back online by luck.)
  it("KNOWN stuck-offline-server-unreachable: a refresh() that finds the server down leaves the app offline for good once it recovers", async () => {
    expect(await runCommands([Advance(1_000), SetServer("down", 0), Refresh()], true)).toEqual([]);
  });

  // seed 20261023, found at 14 runs, shrunk 5 times to `browser offline, server(revoked), browser online`.
  // Scenario: the account is removed from the workspace while the browser is offline; the browser comes back.
  // Expected: the removal notice, nothing else, no more requests (lib/accessRevoked.ts: "NOT offline", "refuses on purpose").
  // Actual: reconnect() (syncEngine.ts: `setOnline(false)` after a sync that is not ok) returns false, and handleOnline
  // (connectivity.ts: `if (!ok && host.navigator?.onLine)`) schedules a retry every 5 s, for good: a request pair each time.
  it("KNOWN revoked-retry-loop: after the account is removed, a reconnect is retried every 5 s forever", async () => {
    expect(await runCommands([BrowserOffline(), SetServer("revoked", 0), BrowserOnline()], true)).toEqual([]);
  });

  // seed 20261023, found at 128 runs. The same reconnect() path, with the removal found while the app was online:
  // the app reads as offline afterwards (online false) although the server answered, and the retry loop above follows.
  it("KNOWN revoked-retry-loop: an account removed while a reconnect is running turns into 'offline'", async () => {
    expect(await runCommands([BrowserOffline(), SetServer("slow", 20_000), BrowserOnline(), SetServer("revoked", 0), Refresh()], true)).toEqual([]);
  });

  // Nightly 2026-11-15, PROPS_SEED=765832 PROPS_RUNS=5000 (found at run 894). Invariant: an account removed while the app was online does not read as offline.
  // Likely cause: the revoked answer reaches a reconnect that was already in flight (syncEngine reconnect() setOnline(false)); same family as the case above, no Refresh needed.
  it.fails("revoked-while-reconnecting again: slow server, back online, account removed, server up reads as offline (seed 765832)", async () => {
    expect(await runCommands([BrowserOffline(), Advance(1_000), SetServer("slow", 20_000), BrowserOnline(), SetServer("revoked", 0), SetServer("up", 0)], true)).toEqual([]);
  });

  // seed 3 at 500 runs, shrunk to this. Scenario: a save is queued offline; the browser comes back while the server is slow (the drain's PATCH is in
  // flight); a second save is made meanwhile. Expected: both reach the server once it answers. Actual: the second save goes to the queue behind the first,
  // the single-flight flushPendingWrites (lib/data/writeQueue.ts) has already read its list, and no retry is scheduled after a pass that succeeded:
  // the save stays queued ("waiting to sync") for good, with the server up and the browser online.
  it("KNOWN queued-during-drain-never-sent: a save made while the queue is being sent stays queued", async () => {
    expect(await runCommands([BrowserOffline(), Advance(1_000), Write(), SetServer("slow", 3_000), BrowserOnline(), Sync(), Write()], true)).toEqual([]);
  });

  // Found as `browser offline, save a note` right after boot, shrunk 0 times; made exact here: the browser drops
  // between the membership digest and the first membership page of the first check.
  // Expected: wentOffline() lowered the gate and it stays down while the browser is offline ("never left raised forever").
  // Actual: maybeReconcileMembership (syncEngine.ts) catches the failed page and calls setMembershipGated(true) after wentOffline()
  // lowered it; the guard `if (!isBrowserOnline()) return;` only looks at the start of the check. The gate stays up, the cached notes stay covered.
  it("KNOWN gate-raised-offline: the browser going offline in the middle of the first membership check leaves the gate up", async () => {
    const problems = await runCommands([Advance(1_000)], true, () => {
      let armed = true;
      net.beforeAnswer = (path, tab) => {
        if (!armed || !tab || !path.startsWith("/api/sync/membership?")) return;
        armed = false;
        tab.online = false; net.browserOnline = false;
        windows.get(tab)?.fire("offline");
      };
    });
    expect(problems).toEqual([]);
  });

  // The other half of the fix above: the failed check is not forgotten. When the browser comes back the first check runs
  // again, and when the server then reports that the account lost the note, the gate is up while that check runs (fail-closed
  // still holds once the server can answer) and the note is gone afterwards.
  it("gate-raised-offline, other half: after the browser comes back the check runs again and a real membership change raises the gate", async () => {
    const seen: Array<{ path: string; gated: boolean }> = [];
    let armed = true;
    const problems = await runCommands([Advance(1_000), BrowserOnline(), Advance(5_000)], true, () => {
      net.beforeAnswer = (path, tab) => {
        if (!tab || !path.startsWith("/api/sync/membership?")) return;
        if (armed) {
          armed = false;
          tab.online = false; net.browserOnline = false;
          windows.get(tab)?.fire("offline");
          // From here on the server reports the removal (epoch 1, nothing readable).
          net.epoch = 1; net.readable = [];
          return;
        }
        seen.push({ path, gated: tab.mods.appStore.getAppState().membershipGated });
      };
    });
    expect(problems.filter((p) => !p.startsWith("liveness"))).toEqual([]);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((entry) => entry.gated)).toBe(true);
  });
});


// ── an unreachable server is offline; only a refusal locks (owner decision 2026-11-15) ──

/** Time passes one second at a time, with the page's storage (and the digest hashing) settling between steps. */
async function pass(run: Run, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 1_000) { await advance(run, Math.min(left, 1_000)); await settleStorage(); }
}
type Outcome = { online: boolean; gated: boolean; revoked: boolean; noteShown: boolean };
const outcomeOf = (run: Run): Outcome => {
  const s = appState(run);
  return { online: s.online, gated: s.membershipGated, revoked: s.accessRevoked, noteShown: !s.membershipGated && !s.accessRevoked && run.tab.display("n0" as never) >= 0 };
};

describe("an unreachable server is offline, not locked", () => {
  it("the browser comes back online but the server cannot be reached: offline, no gate, the note readable, a new save queued, then sent once", async () => {
    let seen: Outcome | null = null; let queued = -1;
    const problems = await runCommands([BrowserOffline(), SetServer("down", 0), BrowserOnline(), Advance(6_000), Write(), Advance(6_000)], true, undefined, async (run) => {
      seen = outcomeOf(run); queued = await pendingRows(run);
    });
    expect(problems).toEqual([]);
    expect(seen).toEqual({ online: false, gated: false, revoked: false, noteShown: true });
    expect(queued).toBe(1);
  });

  it("the server comes back with the account intact: online again, the queue sent, each save once", async () => {
    let seen: Outcome | null = null; let sent: number[] = [];
    const problems = await runCommands([BrowserOffline(), SetServer("down", 0), BrowserOnline(), Write(), Advance(6_000), SetServer("up", 0), Advance(16_000)], true, undefined, async (run) => {
      seen = outcomeOf(run); sent = [...net.sentCount.values()];
    });
    expect(problems).toEqual([]);
    expect(seen).toEqual({ online: true, gated: false, revoked: false, noteShown: true });
    expect(sent).toEqual([1]);
  });

  it("the server comes back and says the account was removed: the notice, nothing of the workspace readable (fail-closed unchanged)", async () => {
    let seen: Outcome | null = null;
    const problems = await runCommands([BrowserOffline(), SetServer("down", 0), BrowserOnline(), Advance(6_000), SetServer("revoked", 0), Advance(16_000)], true, undefined, async (run) => {
      seen = outcomeOf(run);
    });
    expect(problems).toEqual([]);
    expect(seen).toMatchObject({ revoked: true, noteShown: false });
  });

  it("the server comes back and the membership changed: the lost note is removed and the gate came up for the check", async () => {
    let seen: Outcome | null = null;
    const gates: boolean[] = [];
    const problems = await runCommands([BrowserOffline(), SetServer("down", 0), BrowserOnline(), Advance(6_000), ChangeMembership(), SetServer("up", 0)], true, () => {
      net.beforeAnswer = (path, tab) => { if (tab && path.startsWith("/api/sync/membership?")) gates.push(tab.mods.appStore.getAppState().membershipGated); };
    }, async (run) => {
      await pass(run, 16_000);
      seen = outcomeOf(run);
    });
    expect(problems.filter((p) => !p.startsWith("liveness"))).toEqual([]);
    expect(gates.length).toBeGreaterThan(0);
    expect(gates.every(Boolean)).toBe(true);
    expect(seen).toMatchObject({ noteShown: false });
  });

  it("the server answers but the membership keeps changing and never settles: the gate stays up (fail-closed unchanged)", async () => {
    let seen: Outcome | null = null;
    const problems = await runCommands([BrowserOffline(), SetServer("down", 0), BrowserOnline(), Advance(6_000), SetServer("up", 0)], true, () => {
      net.beforeAnswer = (path) => { if (path.startsWith("/api/sync/membership")) net.epoch += 1; };
    }, async (run) => {
      await pass(run, 16_000);
      seen = outcomeOf(run);
    });
    expect(problems.filter((p) => !p.startsWith("liveness"))).toEqual([]);
    expect(seen).toMatchObject({ gated: true, noteShown: false });
  });

  // Boot (a page reload over the same copy) and reconnect (the browser's `online` event) meet the same server: the same outcome.
  it.each<Mode>(["down", "bad-gateway", "slow", "forbidden", "revoked"])("boot and reconnect end the same way against a server that is %s", async (mode) => {
    const outcome = async (commands: Cmd[]): Promise<Outcome> => {
      let seen: Outcome | null = null;
      await runCommands(commands, true, undefined, async (run) => { await pass(run, 6_000); seen = outcomeOf(run); });
      return seen!;
    };
    const viaBoot = await outcome([SetServer(mode, 20_000), Reload()]);
    const viaReconnect = await outcome([BrowserOffline(), SetServer(mode, 20_000), BrowserOnline()]);
    // Whether the store reads online while it is locked behind a refusal flaps with the retry; the gate, the notice and what is readable do not.
    const { online: reconnectOnline, ...reconnectRest } = viaReconnect; const { online: bootOnline, ...bootRest } = viaBoot;
    // Under the removal notice the gate's own value does not matter (the notice covers the workspace either way).
    if (mode === "revoked") { reconnectRest.gated = bootRest.gated = false; }
    expect(reconnectRest).toEqual(bootRest);
    if (mode === "down" || mode === "bad-gateway" || mode === "slow") expect(reconnectOnline).toBe(bootOnline);
  });
});
