// @vitest-environment jsdom
// "Reload now" (lib/data/draftActions prepareEditorForReload) against random
// save outcomes. The question the gate answers: does any text of the person
// live ONLY in memory? Reloading then destroys it, so the gate must block;
// when every text is already on the server, in the durable offline queue, or in
// a recovery entry that a reload keeps, it must let the reload through.
//
// Per run: 1-3 waves of typing in the open note (each lets autosave fire), each
// wave's save ends one of: accepted; refused (403); network failure (the write
// goes to the offline queue); or, for the last wave, is still in flight when the
// reload is asked for (then it is accepted / refused / network failure while the
// gate waits). Around that: the storage can fail (the queue commit, the refused-
// write row, browser storage for the recovery copy), the local copy can be
// ok / none / restarting and answer or not, changes can be waiting in its
// queue, and the person may have removed recovery entries first.
//
// Ground truth is read from what the fakes actually persisted, not from the
// gate: text is DURABLE when the server accepted a request carrying it, the
// queue commit carrying it succeeded, a refused-write row carrying it is still
// stored, or browser storage's recovery list carries it.
//
// Invariants:
//   block  the latest text of the note is not durable        -> the gate is not "safe"
//   pass   it is durable, and the local copy does not hold changes it cannot
//          flush                                              -> the gate is "safe"
//   exit   whenever sign-out (prepareEditorForExit) would let the person go,
//          the reload gate on the same state is "safe": sign-out is never weaker
//
// Replay:  PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/reloadGate

import { stopWriteRetry } from "../../lib/data/writeQueue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { renderHook, act } from "@testing-library/react";

type Row = { id: number; method: string; path: string; body: string | null; idem_key: string; rejection: string; targets?: unknown };
const db = vi.hoisted(() => ({
  rejected: [] as Row[],
  queued: [] as { method: string; path: string; body: string | null; idemKey: string }[],
  nextId: 1,
  addQueueFails: false,
  storeRejectedFails: false,
  flushFails: false,
}));
vi.mock("../../lib/api", async (importOriginal) => ({ ...await importOriginal<typeof import("../../lib/api")>(), api: vi.fn(async () => ({})) }));
vi.mock("../../lib/localDb", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/localDb")>(),
  storeRejectedWrite: vi.fn(async (request: { method: string; path: string; body: string | null; idem_key: string }, rejection: string) => {
    if (db.storeRejectedFails) throw new Error("no space");
    const row = { ...request, id: db.nextId++, rejection, attempts: 0 } as Row;
    db.rejected.push(row);
    return row;
  }),
  getRejectedWrites: vi.fn(async () => [...db.rejected]),
  dismissRejectedWrite: vi.fn(async (row: Row) => { db.rejected = db.rejected.filter((r) => r.id !== row.id); }),
  getPendingWrites: vi.fn(async () => db.queued.map((w, i) => ({ id: i + 1, attempts: 0, ...w, idem_key: w.idemKey }))),
  addPendingWrite: vi.fn(async (method: string, path: string, body: string | null, idemKey: string) => {
    if (db.addQueueFails) throw new Error("queue commit failed");
    db.queued.push({ method, path, body, idemKey });
    return null;
  }),
  // Every save is recorded in the queue before it is sent and leaves it once answered (writeQueue.recordWrite).
  clearPendingWrite: vi.fn(async (_id: number, idemKey?: string | null) => { db.queued = db.queued.filter((w) => w.idemKey !== idemKey); }),
  catchUpWithOtherTabs: vi.fn(async () => {}),
  flushLocalDbSync: vi.fn(async () => { if (db.flushFails) throw new Error("local copy did not answer"); }),
  searchNodes: vi.fn(async () => []),
  upsertNode: vi.fn(async () => null),
}));

import { api, ApiError, noWorkspaceData, type Bootstrap, type ContentNode } from "../../lib/api";
import { useOverviewMode } from "../../hooks/useOverviewMode";
import { resetAppState } from "../../lib/appStore";
import { typeIntoDraft, prepareEditorForExit, prepareEditorForReload, __resetDraftStateForTests } from "../../lib/data/draftActions";
import { getPendingCount, setPending } from "../../lib/data/syncStatus";
import { getRecoveryWrites, refreshRecoveryWrites, removeRecoveryWrite } from "../../lib/data/writeRecovery";
import { setLocalCopy, _resetLocalCopyForTests, type LocalCopyState } from "../../lib/localCopyState";
import { bindAccountStorage } from "../../lib/accountStorage";
import { PREFS, getPref } from "../../lib/prefs";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";

const apiMock = vi.mocked(api);
// each run builds a page and walks timers: a short default, PROPS_RUNS raises it
const cfg = { numRuns: process.env.PROPS_RUNS ? PROPS_RUNS : 30, seed: PROPS_SEED };

const node = (id: string, markdown: string): ContentNode => ({
  id, title: `Node ${id}`, slug: `node-${id}`, markdown, source_type: "manual", node_type: "content",
});

// ── scenario ────────────────────────────────────────────────────────────────

type Outcome = "accepted" | "refused" | "network";
type Scenario = {
  waves: Outcome[];
  /** The last save is still in flight when the reload is asked for. */
  lastInFlight: boolean;
  copy: LocalCopyState;
  flushFails: boolean;
  waiting: number;
  addQueueFails: boolean;
  storeRejectedFails: boolean;
  browserStorageFails: boolean;
  /** Which recovery entries the person removes first (by position, modulo). */
  removed: number[];
};
const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  waves: fc.array(fc.constantFrom<Outcome>("accepted", "refused", "network"), { minLength: 1, maxLength: 3 }),
  lastInFlight: fc.boolean(),
  copy: fc.constantFrom<LocalCopyState>("ok", "none", "restarting"),
  flushFails: fc.boolean(),
  waiting: fc.constantFrom(0, 0, 1, 2),
  addQueueFails: fc.boolean(),
  storeRejectedFails: fc.boolean(),
  browserStorageFails: fc.boolean(),
  removed: fc.array(fc.nat(3), { maxLength: 2 }),
});

const respond = (outcome: Outcome) => outcome === "accepted" ? Promise.resolve({})
  : outcome === "refused" ? Promise.reject(new ApiError(403, "Denied"))
  : Promise.reject(new TypeError("Failed to fetch"));

type Result = { gate: Awaited<ReturnType<typeof prepareEditorForReload>> | null; exit: boolean | "threw" | null; durable: boolean; waiting: number; copy: LocalCopyState; flushFails: boolean };

const storedRecovery = (): { body: string | null }[] => {
  try { return JSON.parse(getPref(PREFS.lostWrites) ?? "[]"); }
  catch { return []; }
};
const carries = (body: string | null, text: string) => { try { return (JSON.parse(body ?? "null") as { markdown?: string } | null)?.markdown === text; } catch { return false; } };

async function runScenario(s: Scenario, ask: "reload" | "exit"): Promise<Result> {
  // a fresh world
  localStorage.clear();
  bindAccountStorage("reload-property-account", "");
  Object.assign(db, { rejected: [], queued: [], nextId: 1, addQueueFails: s.addQueueFails, storeRejectedFails: s.storeRejectedFails, flushFails: s.flushFails });
  vi.useFakeTimers();
  stopWriteRetry();
  _resetLocalCopyForTests();
  setLocalCopy(s.copy);
  setPending(0);
  __resetDraftStateForTests();
  await refreshRecoveryWrites();
  const nodes = noWorkspaceData.nodes;
  resetAppState({ data: { ...noWorkspaceData, nodes: [...nodes, node("a", "# A\n\noriginal")] } as Bootstrap, online: true, selectedId: "a" });
  const accepted: string[] = [];
  const { unmount } = renderHook(() => useOverviewMode({ setMode: vi.fn(), setNotesView: vi.fn() }));
  let setItem: ReturnType<typeof vi.spyOn> | null = null;
  if (s.browserStorageFails) setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });

  let latest = "";
  let release: (() => void) | null = null;
  for (let i = 0; i < s.waves.length; i++) {
    latest = `typed wave ${i} of the note, run ${++runNo}`;
    const last = i === s.waves.length - 1;
    const outcome = s.waves[i];
    if (last && s.lastInFlight) {
      let held = false;
      apiMock.mockImplementation((_path, init) => {
        if (init?.method !== "PATCH") return Promise.resolve({});
        // Only the save that is in flight at the ask is held; a send the queue makes later (its own retry) is answered.
        if (held) return respond(outcome);
        held = true;
        return new Promise((resolve, reject) => {
          release = () => { void respond(outcome).then((v) => { accepted.push(latest); resolve(v); }, reject); };
        });
      });
    } else {
      apiMock.mockImplementation((_path, init) => {
        if (init?.method !== "PATCH") return Promise.resolve({});
        const text = latest;
        return respond(outcome).then((v) => { accepted.push(text); return v; });
      });
    }
    act(() => { typeIntoDraft("a", { markdown: latest }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
  }
  // the person removes some recovery entries
  for (const pick of s.removed) {
    const entries = getRecoveryWrites();
    if (entries.length) await act(async () => { await removeRecoveryWrite(entries[pick % entries.length].id).catch(() => {}); });
  }
  setPending(s.waiting + db.queued.length);

  let gate: Result["gate"] = null;
  let exit: Result["exit"] = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await act(async () => {
    const asking = ask === "reload"
      ? prepareEditorForReload().then((g) => { gate = g; })
      : prepareEditorForExit().then((ok) => { exit = ok; }, () => { exit = "threw"; });
    await vi.advanceTimersByTimeAsync(0);
    (release as (() => void) | null)?.();
    // This property asks about the moment of the ask; the queue's own retry (writeQueue.ts, tested in
    // writeQueueRetry.test.ts) would send the queued write again and take the one held request.
    stopWriteRetry();
    await vi.advanceTimersByTimeAsync(2000);
    await asking;
  });
  const waiting = getPendingCount();
  // ground truth, read from what the fakes hold
  const durable = accepted.includes(latest)
    || db.queued.some((w) => carries(w.body, latest))
    || db.rejected.some((r) => carries(r.body, latest))
    || (!s.browserStorageFails && storedRecovery().some((w) => carries(w.body, latest)));
  setItem?.mockRestore();
  unmount();
  vi.useRealTimers();
  return { gate, exit, durable, waiting, copy: s.copy, flushFails: s.flushFails };
}

beforeEach(() => { apiMock.mockReset().mockResolvedValue({}); });
afterEach(() => { __resetDraftStateForTests(); resetAppState(); _resetLocalCopyForTests(); vi.useRealTimers(); vi.restoreAllMocks(); });

const seen = new Set<string>();
const LONG = 600_000;
let runNo = 0;
describe("the reload gate against random save outcomes", () => {
  it("block / pass: memory-only text always blocks; durable text always passes", async () => {
    await fc.assert(fc.asyncProperty(scenarioArb, async (s) => {
      const r = await runScenario(s, "reload");
      seen.add(`${r.durable ? "durable" : "memory-only"}/${r.gate?.kind}`);
      expect(r.gate, "the gate returned").not.toBeNull();
      const kind = r.gate!.kind;
      if (!r.durable) expect(kind, `latest text is memory-only: ${JSON.stringify(r.gate)}`).not.toBe("safe");
      // a local copy that cannot flush while changes wait in its queue blocks for its own reason
      const queueBlocks = r.copy !== "none" && r.flushFails && r.waiting > 0;
      if (r.durable && !queueBlocks) expect(kind, `latest text is durable: ${JSON.stringify(r.gate)}`).toBe("safe");
    }), cfg);
    // the generator reaches both sides and several verdicts
    if (cfg.numRuns >= 30) expect([...seen].sort(), "classes reached").toEqual(expect.arrayContaining(["durable/safe", "memory-only/memory-only"]));
  }, LONG);

  it("exit: signing out is never allowed where the reload would be blocked", async () => {
    await fc.assert(fc.asyncProperty(scenarioArb, async (s) => {
      const reload = await runScenario(s, "reload");
      const exit = await runScenario(s, "exit");
      if (exit.exit === true) expect(reload.gate?.kind, `exit let the person go, reload says ${JSON.stringify(reload.gate)}`).toBe("safe");
    }), cfg);
  }, LONG);
});
