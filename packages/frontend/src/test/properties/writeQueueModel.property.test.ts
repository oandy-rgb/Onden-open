// Model test of the offline write queue (lib/data/writeQueue: submitWrite,
// flushPendingWrites) against an in-memory fake server, with up to three
// clients (devices) writing to it. Only the public entry points are used, so
// the file survives a rewrite of the sync protocol.
//
// Each client has its own module registry and its own fake local database (the
// durable queue). The test decides, per request: delivered, 503, network error,
// refused for good (422), or applied with the answer lost; and when a client
// goes offline/online, when its page is reloaded (module state gone, the queue
// survives, requests on the wire still reach the server), and when the 25 s
// attempt deadline passes (the abandoned request may still arrive later).
//
// Every write is `PUT /api/reg/<key>` with {c, seq}: client and its own
// counter. The server applies a body once per Idempotency-Key and replays the
// cached answer after that.
//
// After a run settles (all online, all requests answered, queues drained):
//   1 a write a client was told is saved (synced or queued) is on the server,
//     or was refused for good by it: nothing told "saved" is lost, also when
//     the page was reloaded in between
//   2 a write is applied at most once, however often it was retried, replayed
//     after a lost answer, or resent from another page load; every write keeps
//     one idempotency key for life and no two writes share one
//   3 per client, the acknowledged writes reach the server in the order they
//     were submitted (a new write never overtakes an older queued one)
//   4 a write told "synced" had been applied by the server at that moment
//   5 the queues are empty, and with one client the server's registers equal a
//     replay of the accepted writes in submission order
//
// Replay:  PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run <this file>
//          (fast-check prints the seed, path and the shrunk command list.)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { AsyncLocalStorage } from "node:async_hooks";

type Row = { id: number; method: string; path: string; body: string | null; idem_key: string | null; attempts: number };
type Outcome = "deliver" | "503" | "net" | "refuse" | "lose";
type Req = {
  n: number; client: number; gen: number; c: number; seq: number; key: string; idem: string | null;
  state: "inflight" | "done"; resolve(v: unknown): void; reject(e: unknown): void;
};
type Logical = { client: number; seq: number; reg: string; ack: "none" | "synced" | "queued" | "threw"; appliedAtAck: boolean | null };

const REGS = ["r0", "r1", "r2"] as const;
const CLIENTS = 3;

/** Everything a run owns; rebuilt by reset(). */
class World {
  requests: Req[] = [];
  /** idem key → seq applied; the server's cache. */
  cache = new Map<string, string>();
  /** Applied bodies in arrival order (cache hits are not applications). */
  applied: Array<{ client: number; seq: number; reg: string; idem: string }> = [];
  refused = new Set<string>();
  registers = new Map<string, { client: number; seq: number }>();
  keysOf = new Map<string, Set<string>>();
  logical = new Map<string, Logical>();
  dbs: Row[][] = Array.from({ length: CLIENTS }, () => []);
  rowSeq = 0;
  gen: number[] = Array(CLIENTS).fill(0);
  online: boolean[] = Array(CLIENTS).fill(true);
  nextSeq: number[] = Array(CLIENTS).fill(0);
  writeQueue: Array<typeof import("../../lib/data/writeQueue")> = [];
  ApiError!: typeof import("../../lib/api").ApiError;
  reqSeq = 0;

  reset(): void {
    this.requests = []; this.cache.clear(); this.applied = []; this.refused.clear(); this.registers.clear();
    this.keysOf.clear(); this.logical.clear(); this.dbs = Array.from({ length: CLIENTS }, () => []);
    this.rowSeq = 0; this.gen = Array(CLIENTS).fill(0); this.online = Array(CLIENTS).fill(true);
    this.nextSeq = Array(CLIENTS).fill(0); this.writeQueue = []; this.reqSeq = 0;
    for (const tab of tabStorage) tab.clear();
  }

  // ── transport ──
  transport(client: number, gen: number, path: string, init: { method?: string; body?: unknown; headers?: unknown } = {}): Promise<unknown> {
    const reg = /^\/api\/reg\/(r\d)$/.exec(path)?.[1];
    if (!reg || init.method !== "PUT") throw new Error(`writeQueueModel: unexpected request ${init.method} ${path}`);
    if (!this.online[client]) return Promise.reject(new TypeError("Failed to fetch"));
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = JSON.parse(String(init.body)) as { c: number; seq: number };
    const idem = headers["Idempotency-Key"] ?? null;
    const key = `${body.c}:${body.seq}`;
    if (idem) { const set = this.keysOf.get(key) ?? new Set(); set.add(idem); this.keysOf.set(key, set); }
    return new Promise((resolve, reject) => {
      this.requests.push({ n: this.reqSeq++, client, gen, c: body.c, seq: body.seq, key: reg, idem, state: "inflight", resolve, reject });
    });
  }

  private apply(r: Req): void {
    if (r.idem && this.cache.has(r.idem)) return;
    this.applied.push({ client: r.c, seq: r.seq, reg: r.key, idem: r.idem ?? "" });
    this.registers.set(r.key, { client: r.c, seq: r.seq });
    if (r.idem) this.cache.set(r.idem, `${r.c}:${r.seq}`);
  }

  answer(r: Req, outcome: Outcome): void {
    if (r.state !== "inflight") return;
    r.state = "done";
    if (outcome === "refuse") { this.refused.add(`${r.c}:${r.seq}`); r.reject(new this.ApiError(422, "refused")); return; }
    if (outcome === "503") { r.reject(new this.ApiError(503, "unavailable")); return; }
    if (outcome === "net") { r.reject(new TypeError("Failed to fetch")); return; }
    this.apply(r);
    if (outcome === "lose") r.reject(new TypeError("Failed to fetch"));
    else r.resolve({ ok: true });
  }

  get inflight(): Req[] { return this.requests.filter((r) => r.state === "inflight"); }

  // ── local database fake, one per client ──
  /** A page that was reloaded must not touch the queue any more: its calls never return. */
  dbFor(client: number, gen: number) {
    const live = <T,>(fn: () => T): Promise<T> => this.gen[client] === gen ? Promise.resolve().then(fn) : new Promise<T>(() => {});
    const rows = () => this.dbs[client]!;
    return {
      addPendingWrite: (method: string, path: string, body: string | null, idemKey?: string | null) =>
        live(() => { rows().push({ id: ++this.rowSeq, method, path, body, idem_key: idemKey ?? null, attempts: 0 }); }),
      getPendingWrites: () => live(() => rows().map((w) => ({ ...w }))),
      clearPendingWrite: (id: number) => live(() => { this.dbs[client] = rows().filter((w) => w.id !== id); }),
      bumpPendingWriteAttempt: (id: number) => live(() => { const row = rows().find((w) => w.id === id); return row ? ++row.attempts : 0; }),
      rejectPendingWrite: (write: Row, rejection: string) => live(() => { this.dbs[client] = rows().filter((w) => w.id !== write.id); return { ...write, rejection }; }),
      storeRejectedWrite: (request: Omit<Row, "id" | "attempts">, rejection: string) => live(() => ({ id: ++this.rowSeq, ...request, attempts: 0, rejection })),
      getRejectedWrites: () => live(() => []),
      dismissRejectedWrite: () => live(() => {}),
      catchUpWithOtherTabs: () => live(() => {}),
      upsertNode: () => live(() => {}), removeNode: () => live(() => {}), upsertAttribute: () => live(() => {}),
      flushLocalDbSync: () => live(() => {}),
    };
  }

  // ── clients ──
  async load(client: number): Promise<void> {
    this.gen[client]!++;
    vi.resetModules();
    this.writeQueue[client] = await import("../../lib/data/writeQueue");
    this.ApiError = (await import("../../lib/api")).ApiError;
    // Each page load of a device is bound to the account, as the app is before it writes.
    (await import("../../lib/accountStorage")).bindAccountStorage("user-1", "https://onden.test");
  }

  submit(client: number, regIndex: number, explicitOffline: boolean): void {
    const reg = REGS[regIndex]!;
    const seq = this.nextSeq[client]!++;
    const rec: Logical = { client, seq, reg, ack: "none", appliedAtAck: null };
    this.logical.set(`${client}:${seq}`, rec);
    const gen = this.gen[client]!;
    const op = who.run({ client, gen }, () => this.writeQueue[client]!.submitWrite({
      method: "PUT", path: `/api/reg/${reg}`, body: JSON.stringify({ c: client, seq }),
      online: explicitOffline ? false : undefined,
    })).then(
      (result) => {
        if (this.gen[client] !== gen) return; // the page was gone: nobody was told anything
        rec.ack = result.status;
        rec.appliedAtAck = this.applied.some((a) => a.client === client && a.seq === seq);
      },
      () => { if (this.gen[client] === gen) rec.ack = "threw"; },
    );
    void op;
  }

  flush(client: number): void { who.run({ client, gen: this.gen[client]! }, () => void this.writeQueue[client]!.flushPendingWrites()); }
}

const w = new World();

// vi.resetModules() does not rebuild a mock's factory result, so the fakes cannot be bound to a client when
// they are made. Instead every call the test makes into a client runs inside this context and the fakes read it.
const who = new AsyncLocalStorage<{ client: number; gen: number }>();
const here = () => who.getStore() ?? (() => { throw new Error("writeQueueModel: a call outside a client's context"); })();

vi.mock("../../lib/api", async (original) => ({
  ...await original<typeof import("../../lib/api")>(),
  api: (path: string, init?: unknown) => { const { client, gen } = here(); return w.transport(client, gen, path, init as never); },
}));
vi.mock("../../lib/localDb", () => {
  const db = (name: string) => (...args: unknown[]) => {
    const { client, gen } = here();
    return (w.dbFor(client, gen) as Record<string, (...a: unknown[]) => unknown>)[name]!(...args);
  };
  const names = ["addPendingWrite", "getPendingWrites", "clearPendingWrite", "bumpPendingWriteAttempt", "rejectPendingWrite", "storeRejectedWrite",
    "getRejectedWrites", "dismissRejectedWrite", "catchUpWithOtherTabs", "upsertNode", "removeNode", "upsertAttribute", "flushLocalDbSync"];
  return Object.fromEntries(names.map((n) => [n, db(n)]));
});

// A tab's sessionStorage outlives a reload of the page; each client is its own tab.
const tabStorage = Array.from({ length: CLIENTS }, () => new Map<string, string>());
const stubTabStorage = () => vi.stubGlobal("sessionStorage", {
  getItem: (k: string) => tabStorage[here().client]!.get(k) ?? null,
  setItem: (k: string, v: string) => { tabStorage[here().client]!.set(k, v); },
  removeItem: (k: string) => { tabStorage[here().client]!.delete(k); },
});

import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";

/** Let the promise chains of the lane run until nothing moves, without moving the clock. */
async function quiesce(): Promise<void> { for (let i = 0; i < 60; i++) await Promise.resolve(); }

// ── commands ─────────────────────────────────────────────────────────────────

type Cmd =
  | { t: "submit"; client: number; reg: number; offline: boolean }
  | { t: "answer"; pick: number; outcome: Outcome }
  | { t: "flush"; client: number }
  | { t: "reload"; client: number }
  | { t: "net"; client: number; online: boolean }
  | { t: "deadline" };

const client = fc.integer({ min: 0, max: CLIENTS - 1 });
const cmd: fc.Arbitrary<Cmd> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ t: fc.constant("submit" as const), client, reg: fc.integer({ min: 0, max: REGS.length - 1 }), offline: fc.boolean() }) },
  { weight: 6, arbitrary: fc.record({ t: fc.constant("answer" as const), pick: fc.nat(), outcome: fc.constantFrom<Outcome>("deliver", "deliver", "deliver", "503", "net", "refuse", "lose") }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("flush" as const), client }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("reload" as const), client }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("net" as const), client, online: fc.boolean() }) },
  { weight: 1, arbitrary: fc.constant({ t: "deadline" as const }) },
);

async function run(cmds: Cmd[], clients: number): Promise<void> {
  for (const c of cmds) {
    const k = c.t === "submit" || c.t === "flush" || c.t === "reload" || c.t === "net" ? c.client % clients : 0;
    switch (c.t) {
      case "submit": w.submit(k, c.reg, c.offline); break;
      case "answer": { const open = w.inflight; if (open.length) w.answer(open[c.pick % open.length]!, c.outcome); break; }
      case "flush": w.flush(k); break;
      case "reload": await w.load(k); break;
      case "net": w.online[k] = c.online; break;
      case "deadline": vi.advanceTimersByTime(25_001); break;
    }
    await quiesce();
  }
  await settle(clients);
}

/** Back online, every request answered, every queue drained. Bounded: a loop is itself a failure. */
async function settle(clients: number): Promise<void> {
  for (let i = 0; i < clients; i++) w.online[i] = true;
  for (let round = 0; round < 40; round++) {
    await quiesce();
    for (const r of w.inflight) w.answer(r, "deliver");
    await quiesce();
    for (let i = 0; i < clients; i++) w.flush(i);
    await quiesce();
    if (w.inflight.length === 0 && w.dbs.every((db) => db.length === 0)) break;
  }
  await quiesce();
}

function check(clients: number): void {
  // 2: one key per write for life, no key shared by two writes, at most one application
  const seen = new Map<string, string>();
  for (const [write, keys] of w.keysOf) {
    expect([...keys].length, `write ${write} used more than one idempotency key`).toBe(1);
    const key = [...keys][0]!;
    expect(seen.get(key), `key ${key} shared by writes ${seen.get(key)} and ${write}`).toBeUndefined();
    seen.set(key, write);
  }
  const counts = new Map<string, number>();
  for (const a of w.applied) counts.set(`${a.client}:${a.seq}`, (counts.get(`${a.client}:${a.seq}`) ?? 0) + 1);
  for (const [write, n] of counts) expect(n, `write ${write} applied ${n} times`).toBe(1);

  for (let c = 0; c < clients; c++) {
    const mine = [...w.logical.values()].filter((l) => l.client === c).sort((a, b) => a.seq - b.seq);
    // 1, 4
    for (const l of mine) {
      const id = `${c}:${l.seq}`;
      const onServer = counts.has(id);
      if (l.ack === "synced") expect(l.appliedAtAck, `write ${id} was told synced before the server had it`).toBe(true);
      if (l.ack === "synced" || l.ack === "queued") {
        expect(onServer || w.refused.has(id), `write ${id} (${l.ack}) never reached the server`).toBe(true);
      }
    }
    // 3: acknowledged writes arrive in submission order
    const acked = new Set(mine.filter((l) => l.ack === "synced" || l.ack === "queued").map((l) => l.seq));
    const order = w.applied.filter((a) => a.client === c && acked.has(a.seq)).map((a) => a.seq);
    expect(order, `client ${c} writes arrived out of order`).toEqual([...order].sort((a, b) => a - b));
  }
  // 5
  expect(w.dbs.slice(0, clients).map((db) => db.length)).toEqual(Array(clients).fill(0));
  expect(w.inflight).toHaveLength(0);
  if (clients === 1) {
    const model = new Map<string, number>();
    for (const l of [...w.logical.values()].sort((a, b) => a.seq - b.seq)) {
      if (counts.has(`0:${l.seq}`)) model.set(l.reg, l.seq);
    }
    // Only writes the page was told about (or that were on the wire) can be on the server; replay those in order.
    for (const [reg, value] of w.registers) {
      const lastApplied = [...w.applied].reverse().find((a) => a.reg === reg)!;
      expect(value.seq).toBe(lastApplied.seq);
    }
    for (const [reg, seq] of model) {
      const acked = [...w.logical.values()].filter((l) => l.reg === reg && counts.has(`0:${l.seq}`) && (l.ack === "synced" || l.ack === "queued"));
      if (acked.length) expect(w.registers.get(reg)!.seq, `register ${reg} regressed (model says ${seq})`).toBeGreaterThanOrEqual(Math.max(...acked.map((l) => l.seq)));
    }
  }
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  stubTabStorage(); // the test config restores globals after each test
  w.reset();
});
afterEach(() => { vi.useRealTimers(); w.gen.fill(1_000_000); });

describe("write queue model", () => {
  for (const clients of [1, 2, 3]) {
    it(`${clients} client(s) against one server: nothing acknowledged is lost, nothing applies twice, order holds`, async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(cmd, { minLength: 1, maxLength: 40 }), async (cmds) => {
          w.reset();
          for (let i = 0; i < CLIENTS; i++) await w.load(i);
          await run(cmds, clients);
          check(clients);
        }),
        { seed: PROPS_SEED, numRuns: Math.max(10, Math.floor(PROPS_RUNS / 4)) },
      );
    }, 120_000);
  }
});

// Nightly 2026-10-27, seed 175070874 (PROPS_RUNS=5000 → 1250 runs here): a later write
// overtook an earlier one still on the wire (an attempt given up at the deadline, or
// the request of a page that was reloaded). Fixed in writeQueue.ts (settleAbandonedAttempts,
// adoptInterruptedWrite); kept as fixed cases.
describe("write queue model: nightly findings (fixed)", () => {
  const replay = async (clients: number, cmds: Cmd[]) => {
    w.reset();
    for (let i = 0; i < CLIENTS; i++) await w.load(i);
    await run(cmds, clients);
    check(clients);
  };

  // Invariant 5: with one client the server ends as a replay of the accepted writes in order.
  it("nightly 2026-10-27 seed 175070874: a write sent before a reload does not overwrite the newer write to the same register", async () => {
    await replay(1, [
      { t: "submit", client: 0, reg: 2, offline: false },
      { t: "reload", client: 0 },
      { t: "submit", client: 0, reg: 2, offline: false },
      { t: "answer", pick: 1044270181, outcome: "deliver" },
      { t: "deadline" },
    ]);
  });

  // Invariant 3: acknowledged writes reach the server in submission order.
  it("nightly 2026-10-27 seed 175070874: a refused first attempt does not let the second write arrive before the first", async () => {
    await replay(2, [
      { t: "submit", client: 0, reg: 0, offline: false },
      { t: "submit", client: 0, reg: 0, offline: false },
      { t: "flush", client: 0 },
      { t: "deadline" },
      { t: "answer", pick: 990096045, outcome: "refuse" },
      { t: "answer", pick: 38538555, outcome: "deliver" },
      { t: "answer", pick: 0, outcome: "deliver" },
    ]);
  });
});
