// Several tabs of one browser profile, each running the REAL client stack
// (localDb RPC client → localDbWorker with sql.js → snapshot adapter + journal,
// writeQueue, writeRecovery, noteWriter, syncEngine, appStore), against ONE
// shared disk (fakeIndexedDb), one shared localStorage and one fake server
// (test/properties/multiTab.property.test.ts).
//
// A tab is a fresh module registry (vi.resetModules) plus an AsyncLocalStorage
// context. Everything the real page reaches through a global (indexedDB,
// navigator.locks / onLine, Worker, self, window listeners, timers) is
// attributed to the tab that is running, so one global stub can serve several
// tabs and a closed tab simply stops being run.
//
// The test decides every interleaving: IndexedDB completions (`pump`), server
// responses (`respond`) and time (`advance`). Nothing here imports an app
// module at the top level: tabs import them after vi.resetModules, and the
// test file mocks lib/api and sql.js.

import { AsyncLocalStorage } from "node:async_hooks";
import { vi } from "vitest";
import { FakeIdb, FakeKeyRange } from "./fakeIndexedDb";
import type { DataCtx } from "../../lib/data/types";

// On globalThis because every tab re-imports modules (vi.resetModules), this one
// included when a mock factory asks for it: they must all see the same context.
const shared = globalThis as { __ondenTabContext?: AsyncLocalStorage<Tab>; __ondenWorld?: World };
export const tabContext: AsyncLocalStorage<Tab> = (shared.__ondenTabContext ??= new AsyncLocalStorage<Tab>());

export type NoteId = "n0" | "n1";
export const NOTES: NoteId[] = ["n0", "n1"];
export const noteText = (n: number) => `v${n}`;
export const noteVersion = (markdown: string | undefined): number => {
  const match = /^v(\d+)$/.exec(markdown ?? "");
  return match ? Number(match[1]) : -1;
};

type Mods = {
  localDb: typeof import("../../lib/localDb");
  writeQueue: typeof import("../../lib/data/writeQueue");
  writeRecovery: typeof import("../../lib/data/writeRecovery");
  syncEngine: typeof import("../../lib/data/syncEngine");
  appStore: typeof import("../../lib/appStore");
  noteWriter: typeof import("../../lib/data/noteWriter");
  tagWriter: typeof import("../../lib/data/tagWriter");
  api: typeof import("../../lib/api");
  localCopyState: typeof import("../../lib/localCopyState");
  connectivity: typeof import("../../lib/data/connectivity");
};

export type WriteStatus = "started" | "synced" | "queued" | "refused" | "storage-error" | "failed";
export type WriteRecord = { n: number; note: NoteId; tab: string; owner: Tab; status: WriteStatus; keepalive: boolean; leftUnanswered?: boolean; done?: Promise<unknown> };

export class Tab {
  dead = false;
  online = true;
  /** How often the tab read the stored snapshot: the first read is its load, any later one is it continuing from another tab's snapshot. */
  snapshotReads = 0;
  /** What the tab's worker answered with an error (a broken run shows them). */
  workerErrors: string[] = [];
  receive!: (event: { data: unknown }) => void;
  mainWorker: { onmessage: null | ((event: { data: unknown }) => void) } | null = null;
  mods!: Mods;
  listeners: Array<{ type: string; fn: () => void }> = [];
  /** Undo functions for the listeners it put on the real window or document. */
  foreign: Array<() => void> = [];
  /** The tab's own failures: anything the tab throws that the app does not expect. */
  unexpected: unknown[] = [];
  /** Every version of each note this tab ever displayed, in order. */
  shown: Record<NoteId, number[]> = { n0: [], n1: [] };
  /** What the first paint of a tab opened by "reload" showed. */
  coldPaint: Record<NoteId, number> | null = null;
  /** The floor a reload must not go below (set on the tab that replaces this one). */
  floorFromPredecessor: Record<NoteId, number> | null = null;
  /** The account scope this tab's storage is bound to. Tabs of one account share a disk and Web Locks;
   *  a device of the multi-device simulation is a distinct account scope here (accountStorage partitions the local copy). */
  constructor(readonly name: string, readonly account = "u") {}

  fire(type: string): void {
    for (const l of this.listeners.filter((x) => x.type === type)) tabContext.run(this, l.fn);
  }
  display(note: NoteId): number {
    return noteVersion(this.mods.appStore.getAppState().data.nodes.find((x) => x.id === note)?.markdown);
  }
}

// ── the server ───────────────────────────────────────────────────────────────

export type Outcome = "deliver" | "arrive" | "503" | "net" | "refuse" | "lose";
type Req = {
  id: number; tab: Tab; method: string; path: string; body: string | null; key: string | null; keepalive: boolean;
  state: "inflight" | "done"; abandoned: boolean; arrived: boolean; refused: boolean; payload?: unknown;
  resolve(value: unknown): void; reject(error: unknown): void;
};

export class Server {
  notes = new Map<string, { n: number; lastEvent: number }>();
  head = 0;
  requests: Req[] = [];
  private seq = 0;
  private cache = new Map<string, unknown>();
  private refusedKeys = new Set<string>();
  /** Keys for which a success response reached a live tab. */
  ackedKeys = new Set<string>();
  appliedNs = new Set<number>();
  /** Texts the server refused for good (their key answers 422 from then on). */
  refusedNs = new Set<number>();
  /** Per key, how often the request ARRIVED (applied or deduped). */
  arrivals: Array<{ key: string; tab: string; afterAck: boolean; applied: boolean; n: number }> = [];
  violations: string[] = [];
  /** A timeline of what the server saw, for reading a failure. */
  log: string[] = [];
  nextN = 1;

  reset(): void {
    this.notes = new Map(NOTES.map((id) => [id, { n: 0, lastEvent: 0 }]));
    // A real workspace's event log never starts empty: cursor 0 means "this device has no cursor".
    this.head = 10; this.requests = []; this.seq = 0; this.cache.clear(); this.refusedKeys.clear();
    this.ackedKeys.clear(); this.appliedNs.clear(); this.refusedNs.clear(); this.arrivals = []; this.violations = []; this.log = []; this.nextN = 1;
  }

  row(id: string) {
    const note = this.notes.get(id)!;
    return { id, title: id, slug: id, markdown: noteText(note.n), node_type: "content", source_type: "manual", parent_id: null, hidden: false, order_key: "a0", updated_at: "2026-10-24T00:00:00.000Z" };
  }

  /** Another device saves a newer text. */
  remoteEdit(id: string): number {
    const n = this.nextN++;
    const note = this.notes.get(id)!;
    note.n = Math.max(note.n, n);
    note.lastEvent = ++this.head;
    return n;
  }

  private bootstrap() {
    return {
      workspace: { id: "w", name: "W", slug: "w", home_node_id: null }, actor_role: "admin", actor_is_owner: true, can_review: true,
      last_event_id: String(this.head), membership_epoch: 0, server_time: "2026-10-24T00:00:00.000Z",
      nodes: NOTES.map((id) => this.row(id)), edges: [], tasks: [], suggestions: [], events: [], tags: [],
    };
  }
  private delta(since: number) {
    return {
      last_event_id: this.head, membership_epoch: 0,
      nodes: { upsert: NOTES.filter((id) => this.notes.get(id)!.lastEvent > since).map((id) => this.row(id)), delete: [] },
      edges: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null,
    };
  }

  request(tab: Tab, path: string, init: { method?: string; body?: unknown; headers?: unknown; signal?: AbortSignal; keepalive?: boolean } = {}): Promise<unknown> {
    if (tab.dead) return new Promise(() => {}); // a closed page sends nothing
    const headers = new Headers(init.headers as HeadersInit | undefined);
    return new Promise((resolve, reject) => {
      const req: Req = {
        id: ++this.seq, tab, method: init.method ?? "GET", path, body: typeof init.body === "string" ? init.body : null,
        key: headers.get("Idempotency-Key"), keepalive: init.keepalive === true, state: "inflight", abandoned: false, arrived: false, refused: false, resolve, reject,
      };
      // A second attempt of one key while the first is still on the wire, from another tab.
      if (req.key && this.requests.some((r) => r.key === req.key && r.state === "inflight" && !r.abandoned && r.tab !== tab)) {
        this.violations.push(`write ${req.key} is on the wire from two tabs at once (${tab.name} and ${this.requests.find((r) => r.key === req.key && r.state === "inflight" && !r.abandoned)!.tab.name})`);
      }
      init.signal?.addEventListener("abort", () => { req.abandoned = true; this.log.push(`#${req.id} ${tab.name} gave up (deadline)`); });
      this.log.push(`#${req.id} ${tab.name} sends ${req.method} ${req.path}${req.key ? ` key=${req.key.slice(-4)}` : ""}${req.body ? ` ${req.body.slice(0, 40)}` : ""}`);
      this.requests.push(req);
    });
  }

  get inflight(): Req[] { return this.requests.filter((r) => r.state === "inflight" && !r.tab.dead); }
  /** Anything that can still reach the server: live tabs' requests and abandoned ones. */
  get open(): Req[] { return this.requests.filter((r) => r.state === "inflight"); }

  /** The server handles the request (once). */
  arrive(req: Req): void {
    if (req.arrived) return;
    req.arrived = true;
    if (req.method === "PATCH" && /^\/api\/nodes\/[^/]+$/.test(req.path)) {
      const id = req.path.split("/").pop()!;
      const n = noteVersion((JSON.parse(req.body ?? "{}") as { markdown?: string }).markdown);
      if (req.key && this.refusedKeys.has(req.key)) { req.refused = true; return; }
      const cached = req.key ? this.cache.get(req.key) : undefined;
      if (req.key) this.arrivals.push({ key: req.key, tab: req.tab.name, afterAck: this.ackedKeys.has(req.key), applied: !cached, n });
      // The late arrival of an attempt the page gave up on (the 25 s deadline) is the case the server's idempotency cache exists for.
      const lateOldAttempt = req.abandoned;
      if (req.key && this.ackedKeys.has(req.key) && lateOldAttempt) {
        this.log.push(`#${req.id} is the late arrival of an attempt that was given up on`);
      } else if (req.key && this.ackedKeys.has(req.key)) {
        this.violations.push(`write ${req.key} (v${n}) reached the server again from ${req.tab.name} after a success was already delivered`);
      }
      if (cached) { req.payload = cached; return; }
      const note = this.notes.get(id)!;
      // A lower value than the server's is a merge the server resolved in favor of the newer text; either way the note changed (an event).
      note.n = Math.max(note.n, n);
      note.lastEvent = ++this.head;
      this.appliedNs.add(n);
      req.payload = this.row(id);
      if (req.key) this.cache.set(req.key, req.payload);
      return;
    }
    if (req.method === "POST" && req.path === "/api/sync") req.payload = this.delta(Number((JSON.parse(req.body ?? "{}") as { since: number | string }).since));
    else if (req.method === "GET" && /^\/api\/nodes\/[^/]+$/.test(req.path) && this.notes.has(req.path.split("/").pop()!)) req.payload = this.row(req.path.split("/").pop()!);
    else if (req.path.startsWith("/api/bootstrap")) req.payload = this.bootstrap();
    else req.payload = {};
  }

  respond(req: Req, outcome: Outcome): void {
    if (req.state !== "inflight") return;
    this.log.push(`#${req.id} ${req.tab.name} -> ${outcome}${req.abandoned ? " (abandoned)" : ""}`);
    const tab = req.tab;
    const fail = (status: number | "net") => {
      req.state = "done";
      if (!tab.dead) req.reject(status === "net" ? new TypeError("Failed to fetch") : new tab.mods.api.ApiError(status, JSON.stringify({ error: "x" })));
    };
    switch (outcome) {
      case "arrive": this.arrive(req); return;
      case "503": fail(503); return;
      case "net": fail("net"); return;
      case "lose": this.arrive(req); fail("net"); return;
      case "refuse": {
        if (req.method === "PATCH" && req.key) {
          this.refusedKeys.add(req.key);
          this.refusedNs.add(noteVersion((JSON.parse(req.body ?? "{}") as { markdown?: string }).markdown));
          req.refused = true; req.arrived = true;
        }
        fail(422);
        return;
      }
      case "deliver": {
        this.arrive(req);
        req.state = "done";
        if (req.refused) { if (!tab.dead) req.reject(new tab.mods.api.ApiError(422, JSON.stringify({ error: "x" }))); return; }
        // An answer to an attempt the page already gave up on (the 25 s deadline) tells nobody anything.
        if (req.key && req.method === "PATCH" && !req.abandoned && !tab.dead) this.ackedKeys.add(req.key);
        if (!tab.dead) req.resolve(structuredClone(req.payload));
      }
    }
  }
}

/** The default account keeps the plain name, so a test that looks at a lock by name still finds it. */
const lockName = (tab: Tab, name: string): string => (tab.account === "u" ? name : `${tab.account}|${name}`);

// ── the world ────────────────────────────────────────────────────────────────

export class World {
  idb = new FakeIdb();
  server = new Server();
  tabs: Tab[] = [];
  writes: WriteRecord[] = [];
  private lockHeld = new Map<string, Tab>();
  private lockQueue = new Map<string, Array<{ tab: Tab; run: () => Promise<unknown>; resolve(v: unknown): void; reject(e: unknown): void }>>();
  private uuid = 0;
  private pick = 0;
  private realSetTimeout!: typeof setTimeout;
  private restore: Array<() => void> = [];
  // `location` because vitest's URL shim resolves relative URLs against self.location.
  private sharedSelf: { onmessage: null | ((e: { data: unknown }) => void); postMessage(m: unknown): void; location: Location } = { onmessage: null, postMessage: () => {}, location: window.location };

  /** Which tab a global call belongs to. */
  constructor() {
    this.idb.currentTab = () => tabContext.getStore() ?? null;
    this.idb.isDead = (tab) => !!tab && (tab as Tab).dead;
  }

  install(): void {
    this.idb = new FakeIdb();
    this.idb.currentTab = () => tabContext.getStore() ?? null;
    this.idb.isDead = (tab) => !!tab && (tab as Tab).dead;
    this.idb.onRead = (tab, database, store, key) => {
      if (tab && database === "onden-storage" && store === "sqlite" && typeof key === "string" && !key.endsWith(":generation")) (tab as Tab).snapshotReads++;
    };
    this.server.reset(); this.tabs = []; this.writes = []; this.lockHeld.clear(); this.lockQueue.clear(); this.uuid = 0; this.pick = 0;
    // Timers belong to the tab that set them; a closed tab's never fire.
    this.realSetTimeout = globalThis.setTimeout;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fakeSet = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((cb: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const tab = tabContext.getStore();
      return fakeSet(tab ? () => { if (!tab.dead) tabContext.run(tab, cb, ...args); } : cb, ms);
    }) as typeof setTimeout);
    vi.stubGlobal("indexedDB", { open: (name: string, version?: number) => this.idb.open(name, version) });
    vi.stubGlobal("IDBKeyRange", FakeKeyRange);
    // Plain assignment, not vi.spyOn: vitest keeps every spy it ever made.
    const randomUUID = globalThis.crypto.randomUUID;
    globalThis.crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++this.uuid).padStart(12, "0")}`;
    this.restore.push(() => { globalThis.crypto.randomUUID = randomUUID; });
    vi.stubGlobal("self", this.sharedSelf);
    this.sharedSelf.postMessage = (message: unknown) => {
      const tab = tabContext.getStore();
      if (!tab || tab.dead) return;
      const copy = structuredClone(message);
      const failure = copy as { ok?: boolean; error?: string };
      if (failure.ok === false) tab.workerErrors.push(String(failure.error));
      queueMicrotask(() => { if (!tab.dead) tabContext.run(tab, () => tab.mainWorker?.onmessage?.({ data: copy })); });
    };
    vi.stubGlobal("Worker", class {
      onmessage: null | ((event: { data: unknown }) => void) = null;
      onerror = null; onmessageerror = null;
      private readonly tab = tabContext.getStore()!;
      constructor() { this.tab.mainWorker = this; }
      postMessage(request: unknown) {
        const copy = structuredClone(request);
        queueMicrotask(() => { if (!this.tab.dead) tabContext.run(this.tab, () => this.tab.receive({ data: copy })); });
      }
      terminate() {}
    });
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => tabContext.getStore()?.online ?? true });
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request: (name: string, run: () => Promise<unknown>) => this.lockRequest(name, run) } });
    // Page lifecycle listeners are per tab: pagehide of one tab is not pagehide of the other.
    const TRACKED = new Set(["pagehide", "visibilitychange", "online", "offline", "beforeunload"]);
    for (const target of [window, document] as EventTarget[]) {
      const add = target.addEventListener.bind(target);
      const remove = target.removeEventListener.bind(target);
      target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
        const tab = tabContext.getStore();
        if (tab && TRACKED.has(type)) { tab.listeners.push({ type, fn: () => (typeof fn === "function" ? fn(new Event(type)) : fn.handleEvent(new Event(type))) }); return; }
        // Any other listener goes to the real window; it is taken off again when the run ends, or the whole tab stays reachable.
        if (tab) tab.foreign.push(() => remove(type, fn, opts as never));
        add(type, fn, opts as never);
      }) as typeof target.addEventListener;
      target.removeEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
        const tab = tabContext.getStore();
        if (tab && TRACKED.has(type)) return; // listeners die with the tab; nothing here re-adds one after removal
        remove(type, fn, opts as never);
      }) as typeof target.removeEventListener;
      this.restore.push(() => { target.addEventListener = add as never; target.removeEventListener = remove as never; });
    }
    localStorage.clear();
    // Every refused or failed server answer makes the app log a warning; hundreds per run only hide a real one.
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { if (!String(args[0]).startsWith("[onden] the refresh failed")) warn(...args); };
    this.restore.push(() => { console.warn = warn; });
  }

  uninstall(): void {
    // Whatever a finished run's tabs were still doing must not reach the next run's disk and server.
    for (const tab of this.tabs) { tab.dead = true; for (const undo of tab.foreign.splice(0)) undo(); }
    const opened = (globalThis as { __ondenDatabases?: Array<{ close(): void }> }).__ondenDatabases;
    for (const database of opened?.splice(0) ?? []) { try { database.close(); } catch { /* closed by its worker already */ } }
    for (const undo of this.restore.splice(0)) undo();
    vi.unstubAllGlobals();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  }

  // ── Web Locks ──
  private lockRequest(unscoped: string, run: () => Promise<unknown>): Promise<unknown> {
    const tab = tabContext.getStore()!;
    // Locks belong to one browser: tabs of another device never wait for them.
    const name = lockName(tab, unscoped);
    return new Promise((resolve, reject) => {
      const queue = this.lockQueue.get(name) ?? [];
      queue.push({ tab, run, resolve, reject });
      this.lockQueue.set(name, queue);
      queueMicrotask(() => this.grant(name));
    });
  }
  private grant(name: string): void {
    if (this.lockHeld.has(name)) return;
    const queue = this.lockQueue.get(name) ?? [];
    while (queue.length) {
      const next = queue.shift()!;
      if (next.tab.dead) continue;
      this.lockHeld.set(name, next.tab);
      tabContext.run(next.tab, () => next.run()).then(
        (value) => { if (this.lockHeld.get(name) === next.tab) this.lockHeld.delete(name); next.resolve(value); this.grant(name); },
        (error) => { if (this.lockHeld.get(name) === next.tab) this.lockHeld.delete(name); next.reject(error); this.grant(name); },
      );
      return;
    }
  }

  // ── tabs ──
  /** A new tab: fresh module registry, worker, listeners. It has not booted yet. */
  async createTab(name: string, account = "u"): Promise<Tab> {
    const tab = new Tab(name, account);
    this.tabs.push(tab);
    vi.resetModules();
    // Imported outside the tab's context: a promise that carries the context is kept alive by the module it
    // belongs to (node keeps module wrappers), and with it the tab and its whole registry.
    await import("../../lib/localDbWorker");
    tab.receive = this.sharedSelf.onmessage!;
    this.sharedSelf.onmessage = null;
    // One at a time, lib/api first: the test's mock of it awaits the real one.
    const api = await import("../../lib/api");
    const localDb = await import("../../lib/localDb");
    const writeQueue = await import("../../lib/data/writeQueue");
    const writeRecovery = await import("../../lib/data/writeRecovery");
    const syncEngine = await import("../../lib/data/syncEngine");
    const appStore = await import("../../lib/appStore");
    const noteWriter = await import("../../lib/data/noteWriter");
    const tagWriter = await import("../../lib/data/tagWriter");
    const accountStorage = await import("../../lib/accountStorage");
    const localCopyState = await import("../../lib/localCopyState");
    const connectivity = await import("../../lib/data/connectivity");
    tab.mods = { localDb, writeQueue, writeRecovery, syncEngine, appStore, noteWriter, tagWriter, api, localCopyState, connectivity };
    tabContext.run(tab, () => {
      accountStorage.bindAccountStorage(account, "");
      localDb.installUnloadFlush();
      appStore.subscribeApp(() => {
        for (const note of NOTES) {
          const shown = tab.display(note);
          const history = tab.shown[note];
          if (shown >= 0 && history[history.length - 1] !== shown) history.push(shown);
        }
        if (!tab.coldPaint && NOTES.every((note) => tab.display(note) >= 0)) tab.coldPaint = { n0: tab.display("n0"), n1: tab.display("n1") };
      });
    });
    return tab;
  }

  /** Run `fn` as the tab and keep going: errors it throws are the tab's own. */
  start<T>(tab: Tab, fn: () => Promise<T>, onError?: (error: unknown) => void): Promise<T | undefined> {
    return tabContext.run(tab, () => fn().catch((error) => { (onError ?? ((e) => tab.unexpected.push(e)))(error); return undefined; }));
  }

  kill(tab: Tab, commitInFlightStorage: boolean, deliverKeepalive: boolean): void {
    tab.dead = true;
    this.idb.killTab(tab, commitInFlightStorage);
    const drainLock = lockName(tab, "onden-pending-drain");
    if (this.lockHeld.get(drainLock) === tab) { this.lockHeld.delete(drainLock); queueMicrotask(() => this.grant(drainLock)); }
    for (const req of this.server.requests.filter((r) => r.tab === tab && r.state === "inflight")) {
      // The request left the page: the server may well get it (keepalive), nobody reads the answer.
      if (deliverKeepalive && req.keepalive) this.server.arrive(req);
      req.state = "done";
    }
  }

  // ── scheduling ──
  private realDelay(ms: number): Promise<void> { return new Promise<void>((resolve) => this.realSetTimeout(resolve, ms)); }

  private async macrotask(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }

  /** Let the page do everything that needs no storage answer and no server answer. */
  async quiet(): Promise<void> { await this.macrotask(); }

  /** Complete up to `steps` storage requests, in an order chosen by `seed`. */
  async pump(steps: number, seed = 0): Promise<number> {
    let done = 0;
    for (; done < steps; done++) {
      await this.macrotask();
      if (!this.idb.io.length) break;
      this.pick = (this.pick * 31 + seed + done + 7) >>> 0;
      const [item] = this.idb.io.splice(this.pick % this.idb.io.length, 1);
      tabContext.run(item!.tab as Tab, item!.run);
    }
    await this.macrotask();
    return done;
  }

  /** Time passes; storage keeps up with it (a request takes milliseconds, not the 26 s a test may skip). */
  async advance(ms: number): Promise<void> {
    for (let left = ms; left > 0; left -= 1000) {
      await this.macrotask();
      await vi.advanceTimersByTimeAsync(Math.min(left, 1000));
      await this.settleStorage();
    }
    await this.macrotask();
  }

  /** Complete the storage requests that exist, and those they cause, in the order they were made. */
  async settleStorage(limit = 5000): Promise<void> {
    for (let i = 0; i < limit; i++) {
      await this.macrotask();
      const item = this.idb.io.shift();
      if (!item) return;
      tabContext.run(item.tab as Tab, item.run);
    }
  }

  /** Storage in FIFO order until nothing waits. */
  async drainStorage(limit = 200_000): Promise<void> {
    for (let i = 0; i < limit; i++) {
      await this.macrotask();
      if (!this.idb.io.length) {
        for (let wait = 0; wait < 5 && !this.idb.io.length; wait++) await this.realDelay(2);
        if (!this.idb.io.length) return;
      }
      const item = this.idb.io.shift()!;
      tabContext.run(item.tab as Tab, item.run);
    }
    throw new Error("storage never became quiet");
  }

  /** Drive until `promise` settles; server answers are given as `autoOutcome`. */
  async drive<T>(promise: Promise<T>, autoOutcome: Outcome | null = "deliver", limit = 800): Promise<T> {
    let settled = false;
    let idle = 0;
    promise.then(() => { settled = true; }, () => { settled = true; });
    for (let i = 0; i < limit; i++) {
      await this.macrotask();
      if (settled) return promise;
      if (this.idb.io.length) { const item = this.idb.io.shift()!; tabContext.run(item.tab as Tab, item.run); continue; }
      await this.macrotask();
      if (settled) return promise;
      if (this.idb.io.length) continue;
      const open = this.server.inflight[0];
      if (open && autoOutcome) { this.server.respond(open, autoOutcome); idle = 0; continue; }
      // Nothing to answer: either the page waits for a timer, or for something
      // really asynchronous (sql.js reading its wasm). Give the latter real time first.
      if (++idle < 4) { await this.realDelay(1); continue; }
      idle = 0;
      await vi.advanceTimersByTimeAsync(1000);
    }
    throw new Error("drive: the operation never finished");
  }

  live(): Tab[] { return this.tabs.filter((tab) => !tab.dead); }
}

/** The data context a tab's writers (makeNoteWriter, makeTagWriter) run with: live getters into that tab's app store. */
export function dataCtx(tab: Tab): DataCtx {
  const { appStore } = tab.mods;
  return {
    get data() { return appStore.getAppState().data; },
    get online() { return appStore.getAppState().online; },
    setData: appStore.setData, addToast: () => {}, scheduleUserFolderSync: () => {}, refresh: async () => {},
  };
}

/** The one world of the running test file (tab modules reach it through a mock). */
export const theWorld: World = (shared.__ondenWorld ??= new World());
