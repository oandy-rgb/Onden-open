// The main-thread client of the local DB worker (lib/localDb.ts): a worker that
// hangs or dies is replaced instead of leaving every call pending, and a copy
// that cannot be opened leaves a memory-only page that writes straight to the
// server.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_DB_CALL_TIMEOUT_MS, _resetLocalDbForTests, getPendingWrites, initLocalDb,
  loadBootstrapList, persistBootstrap, useMemoryOnlyLocalCopy,
} from "../lib/localDb";
import { _resetLocalCopyForTests, getLocalCopyState, subscribeLocalCopy, type LocalCopyState } from "../lib/localCopyState";
import { localDbErrorCode } from "../lib/localDbErrors";
import { bindAccountStorage } from "../lib/accountStorage";
import type { Bootstrap } from "../lib/api";

class FakeWorker {
  static all: FakeWorker[] = [];
  terminated = false;
  sent: Array<{ id: number; op: string }> = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  constructor() { FakeWorker.all.push(this); }
  postMessage(req: { id: number; op: string }) { this.sent.push(req); }
  terminate() { this.terminated = true; }
  reply(result: unknown, index = this.sent.length - 1) { this.onmessage?.({ data: { id: this.sent[index]!.id, ok: true, result } }); }
}

beforeEach(() => {
  FakeWorker.all = [];
  bindAccountStorage("u", "");
  vi.stubGlobal("Worker", FakeWorker);
  vi.useFakeTimers();
});
afterEach(() => {
  _resetLocalDbForTests();
  _resetLocalCopyForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a local DB worker that hangs or dies", () => {
  it("a call that never answers fails after the timeout, the worker is replaced, and the state says so", async () => {
    const states: LocalCopyState[] = [];
    subscribeLocalCopy((s) => states.push(s));
    const stuck = loadBootstrapList();
    const stuckToo = getPendingWrites();
    const failures = Promise.allSettled([stuck, stuckToo]);
    await vi.advanceTimersByTimeAsync(LOCAL_DB_CALL_TIMEOUT_MS);
    const settled = await failures;
    expect(settled.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(FakeWorker.all).toHaveLength(1);
    expect(FakeWorker.all[0]!.terminated).toBe(true);
    expect(getLocalCopyState()).toBe("restarting");

    // The next call starts a new worker; once it answers, the copy is back.
    const next = getPendingWrites();
    expect(FakeWorker.all).toHaveLength(2);
    FakeWorker.all[1]!.reply([]);
    await expect(next).resolves.toEqual([]);
    expect(getLocalCopyState()).toBe("ok");
    expect(states).toEqual(["restarting", "ok"]);
  });

  it("a worker error fails what is in flight at once and starts over on the next call", async () => {
    const inFlight = getPendingWrites();
    const failed = inFlight.catch((e: Error) => e.message);
    FakeWorker.all[0]!.onerror?.({ message: "boom" });
    expect(await failed).toBe("boom");
    expect(FakeWorker.all[0]!.terminated).toBe(true);
    expect(getLocalCopyState()).toBe("restarting");
    void getPendingWrites().catch(() => null);
    expect(FakeWorker.all).toHaveLength(2);
  });

  it("an answer after the timeout (from the terminated worker) is ignored", async () => {
    const stuck = getPendingWrites().catch(() => "failed");
    await vi.advanceTimersByTimeAsync(LOCAL_DB_CALL_TIMEOUT_MS);
    expect(await stuck).toBe("failed");
    FakeWorker.all[0]!.reply([]); // too late
    expect(getLocalCopyState()).toBe("restarting");
  });

  // The fault e2e workerDeath.spec.ts (scenario 7) at this level: a worker that ended itself (`self.close()`, the
  // closest Playwright has to a crash) sends no `error` event, so the page learns of it only from the call timeout.
  // For that whole minute a save waits on the dead worker and nothing is shown. A fix must tell "dead" from "busy"
  // (an export can take seconds on a phone, LOCAL_DB_CALL_TIMEOUT_MS): a shorter timeout alone would end a live
  // worker in the middle of its work. The busy fake below answers every other message at once (its thread is free;
  // the call itself waits on storage). Known open; FAULTS_FLIP=1 runs it as `it` to show why.
  const knownOpen = process.env.FAULTS_FLIP ? it : it.fails;
  knownOpen("a worker that ended itself is noticed within 30 seconds, and a busy one is left alone for 40", async () => {
    const outcomeOf = (call: Promise<unknown>) => {
      const seen = { value: "waiting" };
      void call.then(() => { seen.value = "answered"; }, () => { seen.value = "failed"; });
      return seen;
    };
    // Dead: it never answers and raises no event.
    const dead = outcomeOf(getPendingWrites());
    await vi.advanceTimersByTimeAsync(30_000);
    const deadResult = { outcome: dead.value, state: getLocalCopyState() };
    _resetLocalDbForTests();
    _resetLocalCopyForTests();

    // Busy: the call is answered after 40 s; anything else it is sent is answered at once.
    const busy = outcomeOf(getPendingWrites());
    const worker = FakeWorker.all.at(-1)!;
    const post = worker.postMessage.bind(worker);
    worker.postMessage = (req) => { post(req); if (worker.sent.length > 1) worker.reply(null); };
    await vi.advanceTimersByTimeAsync(40_000);
    if (!worker.terminated) worker.reply([], 0);
    await vi.advanceTimersByTimeAsync(0);
    const busyResult = { outcome: busy.value, terminated: worker.terminated };

    expect({ dead: deadResult, busy: busyResult }).toEqual({
      dead: { outcome: "failed", state: "restarting" },
      busy: { outcome: "answered", terminated: false },
    });
  });
});

describe("a copy that cannot be opened (memory-only)", () => {
  it("shows the server's data as the projection, has no queue, and refuses the rest with a code", async () => {
    useMemoryOnlyLocalCopy();
    expect(getLocalCopyState()).toBe("none");
    const data = { nodes: [{ id: "n1" }] } as unknown as Bootstrap;
    await expect(persistBootstrap(data)).resolves.toBe(data);
    await expect(getPendingWrites()).resolves.toEqual([]);
    const refused = await loadBootstrapList().catch((e: unknown) => e);
    expect(localDbErrorCode(refused)).toBe("local_copy_unavailable");
    expect(FakeWorker.all.every((w) => w.sent.length === 0)).toBe(true); // nothing reached a worker
  });

  it("a later successful open ends it", async () => {
    useMemoryOnlyLocalCopy();
    const opening = initLocalDb();
    FakeWorker.all[FakeWorker.all.length - 1]!.reply(undefined);
    await opening;
    expect(getLocalCopyState()).toBe("ok");
  });
});
