import { bindAccountStorage } from "../lib/accountStorage";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ api: vi.fn(), toast: vi.fn(), online: false }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: mocks.api }));
vi.mock("../lib/appStore", () => ({ addToast: mocks.toast, getAppState: () => ({ online: mocks.online }) }));
// Hoisted so a test that reloads the modules (a new page life) gets the same fakes: the queue they hold is the disk.
const localDbFakes = vi.hoisted(() => ({
  catchUpWithOtherTabs: vi.fn(), getOldestPendingWriteAt: vi.fn(), addPendingWrite: vi.fn(), getPendingWrites: vi.fn(), clearPendingWrite: vi.fn(), bumpPendingWriteAttempt: vi.fn(), rejectPendingWrite: vi.fn(), storeRejectedWrite: vi.fn(), getRejectedWrites: vi.fn(), dismissRejectedWrite: vi.fn(),
}));
vi.mock("../lib/localDb", () => localDbFakes);

import { ApiError } from "../lib/api";
import { addPendingWrite, catchUpWithOtherTabs, getOldestPendingWriteAt, getPendingWrites, clearPendingWrite, bumpPendingWriteAttempt, rejectPendingWrite, storeRejectedWrite, getRejectedWrites, type PendingWrite } from "../lib/localDb";
import { submitWrite, flushPendingWrites, forgetAbandonedAttempts, getReplayRejectionRevision, moveStuckWritesToRecovery, stopWriteRetry, OFFLINE_QUEUE_FAILED_EVENT, WRITE_ATTEMPT_DEADLINE_MS } from "../lib/data/writeQueue";
import { WriteStorageError } from "../lib/data/writeErrors";
import { getPendingCount, getPendingStuck, setPending, STUCK_AFTER_ATTEMPTS, usePendingRetry } from "../lib/data/syncStatus";
import { renderHook } from "@testing-library/react";
import { setLocalePref } from "../lib/i18n";
import { getRecoveryWrites, rememberUnconfirmedWrite, refreshRecoveryWrites } from "../lib/data/writeRecovery";

let writes: PendingWrite[];
let rejected: Array<PendingWrite & { rejection: string }>;
const request = { method: "PATCH" as const, path: "/api/nodes/n1", body: '{"markdown":"new"}' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  mocks.online = false;
  bindAccountStorage("unit-test-account", "");
  forgetAbandonedAttempts(); // an earlier test may have left a request unanswered
  vi.resetAllMocks();
  localStorage.clear();
  setLocalePref("en");
  setPending(0);
  writes = [];
  rejected = [];
  vi.mocked(getRejectedWrites).mockImplementation(async () => rejected);
  await refreshRecoveryWrites();
  vi.mocked(getPendingWrites).mockImplementation(async () => [...writes]);
  vi.mocked(addPendingWrite).mockImplementation(async (method, path, body, idem_key) => {
    writes.push({ id: (writes.at(-1)?.id ?? 0) + 1, method, path, body, idem_key: idem_key ?? null, attempts: 0 });
  });
  vi.mocked(rejectPendingWrite).mockImplementation(async (write, reason) => {
    const id = write.id;
    const row = { ...writes.find(w => w.id === id)!, rejection: reason };
    rejected.push(row);
    writes = writes.filter(w => w.id !== id);
    return row;
  });
  vi.mocked(storeRejectedWrite).mockImplementation(async (request, reason) => {
    const row = { ...request, id: 100 + rejected.length, attempts: 0, rejection: reason };
    rejected.push(row);
    return row;
  });
  vi.mocked(clearPendingWrite).mockImplementation(async (id) => { writes = writes.filter((write) => write.id !== id); });
  vi.mocked(bumpPendingWriteAttempt).mockImplementation(async (id) => ++writes.find((write) => write.id === id)!.attempts);
});

describe("durable write submission", () => {
  it("does not report queued until persistence commits", async () => {
    const commit = deferred<void>();
    vi.mocked(addPendingWrite).mockReturnValueOnce(commit.promise);
    const settled = vi.fn();
    const saving = submitWrite({ ...request, online: false }).then(settled);
    await vi.waitFor(() => expect(addPendingWrite).toHaveBeenCalledOnce());
    expect(settled).not.toHaveBeenCalled();
    commit.resolve();
    await saving;
    expect(settled).toHaveBeenCalledWith({ status: "queued" });
  });

  it("rejects failed persistence and gives recovery the original request and key", async () => {
    const cause = new Error("quota exhausted");
    mocks.api.mockRejectedValue(new TypeError("lost response"));
    // Storage that cannot take the row: neither the record made before sending nor the queue after the failure.
    vi.mocked(addPendingWrite).mockRejectedValue(cause);
    const recovery = vi.fn();
    window.addEventListener(OFFLINE_QUEUE_FAILED_EVENT, recovery);
    try {
      await expect(submitWrite({ ...request, idemKey: "stable-key" })).rejects.toMatchObject({ name: "WriteStorageError", cause });
      expect(recovery).toHaveBeenCalledOnce();
      expect((recovery.mock.calls[0]![0] as CustomEvent).detail).toEqual({ ...request, idemKey: "stable-key" });
      expect(getPendingCount()).toBe(0);
      expect(new Headers(mocks.api.mock.calls[0]![1].headers).get("Idempotency-Key")).toBe("stable-key");
    } finally { window.removeEventListener(OFFLINE_QUEUE_FAILED_EVENT, recovery); }
  });

  it.each([401, 408, 425, 429, 503])("retains HTTP %i for a later retry", async (status) => {
    mocks.api.mockRejectedValue(new ApiError(status, "temporarily unavailable"));
    await expect(submitWrite(request)).resolves.toEqual({ status: "queued" });
    expect(writes).toHaveLength(1);
  });

  it.each([403, 404, 409, 422])("rejects HTTP %i without creating a retry loop", async (status) => {
    const failure = new ApiError(status, "rejected");
    mocks.api.mockRejectedValue(failure);
    await expect(submitWrite(request)).rejects.toBe(failure);
    expect(writes).toEqual([]);
    const sentKey = new Headers(mocks.api.mock.calls[0]![1].headers).get("Idempotency-Key");
    expect(getRecoveryWrites()).toContainEqual(expect.objectContaining({ body: request.body, idemKey: sentKey, rejection: expect.any(String) }));
    expect(storeRejectedWrite).toHaveBeenCalledWith(expect.objectContaining({ idem_key: sentKey, body: request.body }), expect.any(String));
    const calls = mocks.api.mock.calls.length;
    await flushPendingWrites();
    expect(mocks.api).toHaveBeenCalledTimes(calls);
  });

  it("uses exactly one idempotency key while preserving Headers input", async () => {
    mocks.api.mockResolvedValue("saved");
    const result = await submitWrite({ ...request, idemKey: "chosen", init: { headers: new Headers({ "Accept": "text/plain", "idempotency-key": "old" }) } });
    const headers = new Headers(mocks.api.mock.calls[0]![1].headers);
    expect(headers.get("Idempotency-Key")).toBe("chosen");
    expect(headers.get("Accept")).toBe("text/plain");
    expect(result).toEqual({ status: "synced", value: "saved" });
  });

  it("keeps a terminal copy during rejection persistence, never downgrades it on exit, and still returns the original refusal", async () => {
    const failure = new ApiError(403, "Denied");
    mocks.api.mockRejectedValueOnce(failure);
    const disk = deferred<Awaited<ReturnType<typeof storeRejectedWrite>>>();
    vi.mocked(storeRejectedWrite).mockReturnValueOnce(disk.promise);
    const operation = submitWrite({ ...request, idemKey: "direct-pending" });
    const result = operation.catch(error => error);
    await vi.waitFor(() => expect(storeRejectedWrite).toHaveBeenCalled());
    rememberUnconfirmedWrite({ ...request, idemKey: "direct-pending" });
    const waiting = getRecoveryWrites().find(w => w.idemKey === "direct-pending");
    disk.resolve({ ...request, id: 201, attempts: 0, idem_key: "direct-pending", rejection: "Denied" });
    expect(await result).toBe(failure);
    expect(waiting).toMatchObject({ rejection: expect.any(String), unpersisted: true });
    expect(getRecoveryWrites().filter(w => w.idemKey === "direct-pending")).toEqual([
      expect.objectContaining({ id: "rejected:201", rejection: "Denied" }),
    ]);
    rememberUnconfirmedWrite({ ...request, idemKey: "direct-pending" });
    expect(getRecoveryWrites().filter(w => w.idemKey === "direct-pending")).toHaveLength(1);
  });

  it("reports recovery storage failure but retains the rejection and input without enqueueing", async () => {
    const failure = new ApiError(409, "Conflict");
    mocks.api.mockRejectedValueOnce(failure);
    vi.mocked(storeRejectedWrite).mockRejectedValueOnce(new Error("disk full"));
    await expect(submitWrite({ ...request, idemKey: "direct-disk-failed", init: { headers: { "X-Private-Test": "must-not-be-copied" } } })).rejects.toBe(failure);
    const copy = getRecoveryWrites().find(w => w.idemKey === "direct-disk-failed");
    expect(copy).toMatchObject({ body: request.body, rejection: expect.any(String), unpersisted: true });
    expect(JSON.stringify(copy)).not.toContain("must-not-be-copied");
    // The save was recorded before it was sent; the refusal leaves nothing to replay.
    expect(writes).toEqual([]);
    expect(getPendingCount()).toBe(0);
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("Could not save on this device"), "error");
  });

  it("does not send a new edit past a queued edit, even before the counter is seeded", async () => {
    writes = [{ id: 1, ...request, body: '{"markdown":"old"}', idem_key: "old-key", attempts: 0 }];
    expect(getPendingCount()).toBe(0);
    await expect(submitWrite(request)).resolves.toEqual({ status: "queued" });
    expect(mocks.api).not.toHaveBeenCalled();
    await flushPendingWrites();
    expect(mocks.api.mock.calls.map((call) => call[1].body)).toEqual(['{"markdown":"old"}', request.body]);
    expect(writes).toEqual([]);
  });

  it("serializes overlapping submissions when the first loses its response", async () => {
    const response = deferred<unknown>();
    mocks.api.mockReturnValueOnce(response.promise.then(() => { throw new TypeError("lost response"); }));
    const first = submitWrite({ ...request, body: "old" });
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
    const second = submitWrite(request);
    response.resolve(null);
    await Promise.all([first, second]);
    expect(mocks.api).toHaveBeenCalledOnce();
    expect(writes.map((write) => write.body)).toEqual(["old", request.body]);
  });

  it("does not bypass an unreadable queue or report success when storage also fails", async () => {
    vi.mocked(getPendingWrites).mockRejectedValueOnce(new Error("read failed"));
    vi.mocked(addPendingWrite).mockRejectedValue(new Error("write failed"));
    await expect(submitWrite(request)).rejects.toBeInstanceOf(WriteStorageError);
    expect(mocks.api).not.toHaveBeenCalled();
  });
});

describe("queue replay", () => {
  beforeEach(() => {
    writes = [
      { id: 1, method: "POST", path: "/api/nodes", body: '{"id":"n1","title":"New note"}', idem_key: "create-key", attempts: 5 },
      { id: 2, ...request, idem_key: "edit-key", attempts: 0 },
    ];
  });

  it.each([401, 408, 425, 429, 503])("preserves the head and dependent writes on HTTP %i", async (status) => {
    mocks.api.mockRejectedValue(new ApiError(status, "unavailable"));
    await flushPendingWrites();
    expect(mocks.api).toHaveBeenCalledOnce();
    expect(writes.map((write) => write.id)).toEqual([1, 2]);
    expect(clearPendingWrite).not.toHaveBeenCalled();
    expect(getPendingCount()).toBe(2);
    if (status === 503) expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("remain queued"), "error");
  });

  it("retries beyond six server failures and eventually drains in order with the original keys", async () => {
    mocks.api.mockRejectedValue(new ApiError(503, "down"));
    await flushPendingWrites();
    await flushPendingWrites();
    expect(writes[0]!.attempts).toBe(7);
    mocks.api.mockResolvedValue({ ok: true });
    await flushPendingWrites();
    const sentKeys = mocks.api.mock.calls.map((call) => new Headers(call[1].headers).get("Idempotency-Key"));
    expect(sentKeys).toEqual(["create-key", "create-key", "create-key", "edit-key"]);
    expect(writes).toEqual([]);
    expect(getPendingCount()).toBe(0);
  });

  it("keeps a write the server answered workspace_busy in the queue, then sends it again with the same key", async () => {
    mocks.api.mockRejectedValue(new ApiError(503, '{"error":"workspace_busy","retry_after_seconds":5}'));
    await flushPendingWrites();
    expect(writes.map((write) => write.id)).toEqual([1, 2]);
    expect(rejectPendingWrite).not.toHaveBeenCalled();
    expect(storeRejectedWrite).not.toHaveBeenCalled();
    mocks.api.mockResolvedValue({ ok: true });
    await flushPendingWrites();
    const keys = mocks.api.mock.calls.map((call) => new Headers(call[1].headers).get("Idempotency-Key"));
    expect(keys).toEqual(["create-key", "create-key", "edit-key"]);
    expect(writes).toEqual([]);
  });

  it("coalesces drains and holds a new submission until replay completes", async () => {
    const response = deferred<unknown>();
    mocks.api.mockReturnValueOnce(response.promise);
    const first = flushPendingWrites();
    expect(flushPendingWrites()).toBe(first);
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
    const saving = submitWrite({ ...request, body: "latest" });
    response.resolve({ ok: true });
    await Promise.all([first, saving]);
    expect(mocks.api.mock.calls.map((call) => call[1].body)).toEqual(['{"id":"n1","title":"New note"}', request.body, "latest"]);
  });

  it("keeps a server-accepted write retryable when its local acknowledgement fails", async () => {
    vi.mocked(clearPendingWrite).mockRejectedValueOnce(new Error("disk error"));
    await flushPendingWrites();
    expect(writes).toHaveLength(2);
    expect(mocks.api).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("local sync queue"), "error");
    await flushPendingWrites();
    expect(new Headers(mocks.api.mock.calls[1]![1].headers).get("Idempotency-Key")).toBe("create-key");
    expect(writes).toEqual([]);
  });

  it("preserves a permanently rejected queued change before removing it from automatic replay", async () => {
    const before = getReplayRejectionRevision();
    mocks.api.mockRejectedValueOnce(new ApiError(422, '{"error":"invalid","detail":"Title is required"}'));
    await flushPendingWrites();
    expect(rejectPendingWrite).toHaveBeenCalledWith(expect.objectContaining({ id: 1, idem_key: "create-key" }), expect.stringContaining("Title is required"));
    expect(clearPendingWrite).not.toHaveBeenCalledWith(1);
    expect(rejected[0]).toMatchObject({ body: '{"id":"n1","title":"New note"}', idem_key: "create-key" });
    expect(writes).toEqual([]);
    expect(getReplayRejectionRevision()).toBe(before + 1);
    const calls = mocks.api.mock.calls.length;
    await flushPendingWrites();
    expect(mocks.api).toHaveBeenCalledTimes(calls);
    expect(getReplayRejectionRevision()).toBe(before + 1);
  });
  it("retains the original pending request and stops replay when rejection preservation fails", async () => {
    const before = getReplayRejectionRevision();
    mocks.api.mockRejectedValueOnce(new ApiError(403, "permission revoked"));
    vi.mocked(rejectPendingWrite).mockRejectedValueOnce(new Error("disk full"));
    await flushPendingWrites();
    expect(writes.map(w => w.id)).toEqual([1, 2]);
    expect(clearPendingWrite).not.toHaveBeenCalled();
    expect(mocks.api).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("local sync queue"), "error");
    expect(getReplayRejectionRevision()).toBe(before);
  });

  it("drops a refused change that has no typed text, with one plain message and no recovery entry", async () => {
    writes = [{ id: 1, method: "POST", path: "/api/nodes/n1/duplicate", body: '{"id":"n1"}', idem_key: "dup-key", attempts: 0 }];
    mocks.api.mockRejectedValueOnce(new ApiError(403, "role 'viewer' denied 'write_node'"));
    await flushPendingWrites();
    expect(rejectPendingWrite).not.toHaveBeenCalled();
    expect(clearPendingWrite).toHaveBeenCalledWith(1, "dup-key");
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith("You don't have permission to do that.", "error");
    expect(getRecoveryWrites()).toEqual([]);
  });

  it("retains a permission-refused request with a human-readable reason", async () => {
    mocks.api.mockRejectedValueOnce(new ApiError(403, "role 'editor' denied 'write_node' on node private-id"));
    await flushPendingWrites();
    expect(rejected[0]).toMatchObject({ rejection: "You don't have permission to do that.", idem_key: "create-key" });
  });

});

beforeEach(() => { bindAccountStorage("unit-test-account", ""); });

describe("a request that never answers", () => {
  it("is abandoned after its deadline and queued under the same key, so later saves are not blocked", async () => {
    vi.useFakeTimers();
    try {
      mocks.api.mockImplementationOnce(() => new Promise(() => {}));
      const first = submitWrite({ ...request, idemKey: "first-key" });
      const second = submitWrite({ ...request, body: '{"markdown":"newer"}', idemKey: "second-key" });
      const settled = vi.fn();
      void second.then(settled);
      await vi.advanceTimersByTimeAsync(WRITE_ATTEMPT_DEADLINE_MS - 1_000);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(first).resolves.toEqual({ status: "queued" });
      await expect(second).resolves.toEqual({ status: "queued" });
      expect(writes.map((write) => write.idem_key)).toEqual(["first-key", "second-key"]);
      expect(mocks.api).toHaveBeenCalledOnce(); // the second one found the backlog and did not go out ahead
    } finally { vi.useRealTimers(); }
  });

  // The fault e2e closeMidSave.spec.ts 5b at the queue level: a save is on the wire and unanswered, and the tab is
  // killed without pagehide (a browser crash, the OS killing the process). Required: the next page load sends it, or
  // shows it in recovery. Fixed: the save was recorded in the queue before it was sent (recordWrite); every kill
  // point is in saveSurvivesKill.test.ts. The mirror half is in localDbJournal.test.ts.
  it("a save on the wire when the tab is killed is sent by the next page load, or shown in recovery", async () => {
    vi.useFakeTimers();
    const wire = deferred<unknown>();
    let dead: Promise<unknown> = Promise.resolve();
    try {
      mocks.online = true;
      mocks.api.mockImplementation(() => wire.promise);
      dead = submitWrite({ ...request, idemKey: "on-the-wire" }).catch(() => null);
      await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
      // The tab dies: its timers and module state go, so do its session storage; the queue and localStorage stay.
      vi.clearAllTimers();
      sessionStorage.clear();
      vi.resetModules();
      const nextLife = await import("../lib/data/writeQueue");
      const nextRecovery = await import("../lib/data/writeRecovery");
      (await import("../lib/accountStorage")).bindAccountStorage("unit-test-account", "");
      mocks.api.mockReset().mockResolvedValue({});
      await nextLife.flushPendingWrites();
      await nextRecovery.refreshRecoveryWrites();
      const sent = mocks.api.mock.calls.some((call) => call[1]?.headers && new Headers(call[1].headers).get("Idempotency-Key") === "on-the-wire");
      const shown = nextRecovery.getRecoveryWrites().some((write) => write.idemKey === "on-the-wire");
      expect({ sent, shown }, "the next page load neither sends the unanswered save nor shows it").not.toEqual({ sent: false, shown: false });
      nextLife.stopWriteRetry();
    } finally {
      // The dead page's lane is this module's, which later tests share: let its request end so the lane frees.
      wire.resolve({});
      await dead;
      stopWriteRetry();
      forgetAbandonedAttempts();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("gives up on a stalled replay too, and keeps the write queued", async () => {
    vi.useFakeTimers();
    try {
      writes = [{ id: 1, method: "PATCH", path: "/api/nodes/n1", body: "{}", idem_key: "k", attempts: 0 }];
      mocks.api.mockImplementation(() => new Promise(() => {}));
      const flushing = flushPendingWrites();
      await vi.advanceTimersByTimeAsync(WRITE_ATTEMPT_DEADLINE_MS + 1_000);
      await flushing;
      expect(writes).toHaveLength(1);
      expect(writes[0]!.attempts).toBe(1);
    } finally { vi.useRealTimers(); }
  });
});

describe("a queue head that keeps failing", () => {
  const poison = { id: 1, method: "PATCH", path: "/api/nodes/n1", body: '{"title":"a"}', idem_key: "poison", attempts: 0 };
  const dependent = { id: 2, method: "PATCH", path: "/api/nodes/n1", body: '{"title":"b"}', idem_key: "dependent", attempts: 0 };
  const unrelated = { id: 3, method: "PATCH", path: "/api/nodes/n2", body: '{"title":"c"}', idem_key: "unrelated", attempts: 0 };

  it("counts network errors too and shows the queue as stuck, with how long it has waited", async () => {
    writes = [{ ...poison }, { ...dependent }, { ...unrelated }];
    vi.mocked(getOldestPendingWriteAt).mockResolvedValue("2026-10-23 08:00:00");
    mocks.api.mockRejectedValue(new TypeError("Failed to fetch"));
    for (let i = 0; i < STUCK_AFTER_ATTEMPTS - 1; i++) await flushPendingWrites();
    expect(getPendingStuck()).toBeNull();
    await flushPendingWrites();
    expect(writes[0]!.attempts).toBe(STUCK_AFTER_ATTEMPTS);
    expect(getPendingStuck()).toEqual({ count: 3, oldestAt: Date.parse("2026-10-23T08:00:00Z"), reason: "connection", noteId: "n1" });
  });

  it("tells why the last send failed before the queue counts as stuck, and forgets it once a send works", async () => {
    writes = [{ ...poison }];
    const retry = renderHook(() => usePendingRetry());
    mocks.api.mockRejectedValue(new ApiError(401, JSON.stringify({ error: "unauthorized" })));
    await flushPendingWrites();
    expect(retry.result.current).toEqual({ reason: "signin", attempts: 0 });
    mocks.api.mockRejectedValue(new ApiError(500, "{}"));
    await flushPendingWrites();
    expect(retry.result.current).toEqual({ reason: "server", attempts: 1 });
    mocks.api.mockResolvedValue({});
    await flushPendingWrites();
    expect(retry.result.current).toBeNull();
    retry.unmount();
  });

  it("a server error is reported as such", async () => {
    writes = [{ ...poison, attempts: STUCK_AFTER_ATTEMPTS - 1 }];
    vi.mocked(getOldestPendingWriteAt).mockResolvedValue(null);
    mocks.api.mockRejectedValue(new ApiError(500, "{}"));
    await flushPendingWrites();
    expect(getPendingStuck()).toMatchObject({ count: 1, reason: "server" });
  });

  it("moves the head and the later writes to the same note to recovery, and lets the rest through", async () => {
    writes = [{ ...poison, attempts: STUCK_AFTER_ATTEMPTS }, { ...dependent }, { ...unrelated }];
    await expect(moveStuckWritesToRecovery()).resolves.toBe(2);
    expect(rejected.map((row) => row.idem_key)).toEqual(["poison", "dependent"]);
    expect(writes.map((write) => write.idem_key)).toEqual(["unrelated"]);
    expect(getPendingStuck()).toBeNull();
    mocks.api.mockResolvedValue({});
    await flushPendingWrites();
    expect(writes).toEqual([]);
  });

  it("moves nothing when the head is not stuck", async () => {
    writes = [{ ...poison, attempts: 1 }];
    await expect(moveStuckWritesToRecovery()).resolves.toBe(0);
    expect(rejected).toEqual([]);
  });

  // The fault e2e stuckWrite.spec.ts (scenario 4) at the queue level, on fake timers: the server answers 500 for one
  // note every time, and a write to ANOTHER note waits behind it. drain() stops at the first retryable failure, so the
  // other write is not sent, and the queue only counts as stuck (the sync status' way out) after
  // STUCK_AFTER_ATTEMPTS tries on the retry ladder, minutes later. Known open; FAULTS_FLIP=1 runs it as `it` to show why.
  const knownOpen = process.env.FAULTS_FLIP ? it : it.fails;
  knownOpen("a write to another note behind a head answered 500 goes out, or the queue says it is stuck, within a minute", async () => {
    vi.useFakeTimers();
    try {
      writes = [{ ...poison }, { ...unrelated }];
      vi.mocked(getOldestPendingWriteAt).mockResolvedValue(null); // without it refreshPendingCount throws and the stuck notice is never computed
      mocks.api.mockImplementation(async (path: string) => {
        if (path === poison.path) throw new ApiError(500, "{}");
        return {};
      });
      await flushPendingWrites();
      await vi.advanceTimersByTimeAsync(60_000);
      const otherSent = mocks.api.mock.calls.some((call) => call[0] === unrelated.path);
      const outcome = otherSent ? "other write landed" : getPendingStuck() ? "stuck item with a way out" : "trapped";
      expect(outcome, `head tried ${writes[0]!.attempts} times`).not.toBe("trapped");
    } finally { stopWriteRetry(); vi.useRealTimers(); }
  });
});

describe("page exit and other tabs", () => {
  it("sends a body over the keepalive limit without keepalive, after keeping a synchronous recovery copy", async () => {
    mocks.api.mockResolvedValue({});
    const big = JSON.stringify({ markdown: "字".repeat(30_000) });
    const sending = submitWrite({ ...request, body: big, idemKey: "big", init: { keepalive: true } });
    expect(getRecoveryWrites().map((write) => write.idemKey)).toEqual(["big"]); // before anything is awaited
    await sending;
    expect(mocks.api.mock.calls[0]![1]).toMatchObject({ keepalive: false });
  });

  it("keeps keepalive for a small body", async () => {
    mocks.api.mockResolvedValue({});
    await submitWrite({ ...request, idemKey: "small", init: { keepalive: true } });
    expect(mocks.api.mock.calls[0]![1]).toMatchObject({ keepalive: true });
  });

  it("takes in the other tabs' queue before judging the queue empty, so it does not send ahead of their older edit", async () => {
    // The queue lists rows in the order they were made: the other tab's older edit comes first, whatever its id here.
    vi.mocked(catchUpWithOtherTabs).mockImplementation(async () => {
      writes.unshift({ id: 7, method: "PATCH", path: "/api/nodes/n1", body: '{"markdown":"older"}', idem_key: "older-in-other-tab", attempts: 0 });
    });
    await expect(submitWrite({ ...request, idemKey: "newer" })).resolves.toEqual({ status: "queued" });
    expect(mocks.api).not.toHaveBeenCalled();
    expect(writes.map((write) => write.idem_key)).toEqual(["older-in-other-tab", "newer"]);
  });
});

describe("writes an earlier page life left without an answer", () => {
  /** What pagehide leaves in recovery: made before this page life started. */
  function leftByEarlierPage(write: { path: string; body: string; idemKey: string }, leftOnTheWayOut = true) {
    rememberUnconfirmedWrite({ method: "PATCH", ...write });
    // What an earlier page load stored: the entry names that page, not this one.
    const key = Object.keys(localStorage).find((k) => k.includes("lostWrites"))!;
    const stored = (JSON.parse(localStorage.getItem(key)!) as Array<{ idemKey: string; life?: string }>).map((e) => e.idemKey === write.idemKey ? { ...e, life: "earlier-page-load", exited: leftOnTheWayOut } : e);
    localStorage.setItem(key, JSON.stringify(stored));
  }

  it("queues them again under their own keys, in order, before the new write, and the person presses nothing", async () => {
    leftByEarlierPage({ path: "/api/nodes/a", body: '{"markdown":"甲"}', idemKey: "old-1" });
    leftByEarlierPage({ path: "/api/nodes/b", body: '{"markdown":"乙"}', idemKey: "old-2" });
    mocks.api.mockResolvedValue({});
    await flushPendingWrites();
    expect(mocks.api.mock.calls.map(([path, init]) => [path, init.headers["Idempotency-Key"]])).toEqual([["/api/nodes/a", "old-1"], ["/api/nodes/b", "old-2"]]);
    expect(getRecoveryWrites()).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("goes ahead of a write the new page life makes first", async () => {
    leftByEarlierPage({ path: "/api/nodes/a", body: '{"markdown":"舊"}', idemKey: "old" });
    mocks.api.mockResolvedValue({});
    await submitWrite({ ...request, body: '{"markdown":"新"}', idemKey: "new" });
    expect(writes.map((write) => write.idem_key)).toEqual(["old", "new"]);
    expect(getRecoveryWrites()).toEqual([]);
  });

  it("leaves what this page life made itself alone: that write is still on its way", async () => {
    rememberUnconfirmedWrite({ method: "PATCH", path: "/api/nodes/a", body: '{"markdown":"現在"}', idemKey: "mine" });
    mocks.api.mockResolvedValue({});
    await flushPendingWrites();
    expect(mocks.api).not.toHaveBeenCalled();
    expect(getRecoveryWrites().map((write) => write.idemKey)).toEqual(["mine"]);
  });

  it("leaves alone what another page load kept while it was alive (a crash, another open tab): it may still be on its way", async () => {
    leftByEarlierPage({ path: "/api/nodes/a", body: '{"markdown":"甲"}', idemKey: "other-tab" }, false);
    mocks.api.mockResolvedValue({});
    await flushPendingWrites();
    expect(mocks.api).not.toHaveBeenCalled();
    expect(getRecoveryWrites().map((write) => write.idemKey)).toEqual(["other-tab"]);
  });

  it("marks what a page makes on its way out, and only that, as adoptable by the next page load", async () => {
    rememberUnconfirmedWrite({ method: "PATCH", path: "/api/nodes/a", body: '{"markdown":"活著"}', idemKey: "alive" });
    window.dispatchEvent(new Event("pagehide"));
    rememberUnconfirmedWrite({ method: "PATCH", path: "/api/nodes/b", body: '{"markdown":"離開"}', idemKey: "leaving" });
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); // back from the cache: alive again
    const [alive, leaving] = getRecoveryWrites();
    expect([alive!.exited, leaving!.exited]).toEqual([undefined, true]);
  });

  it("keeps the entry in recovery when the queue cannot take it", async () => {
    leftByEarlierPage({ path: "/api/nodes/a", body: '{"markdown":"甲"}', idemKey: "old" });
    vi.mocked(addPendingWrite).mockRejectedValueOnce(new Error("quota"));
    mocks.api.mockResolvedValue({});
    await flushPendingWrites();
    expect(getRecoveryWrites().map((write) => write.idemKey)).toEqual(["old"]);
  });

  it("puts the text back in recovery, refused, when the server refuses it; nothing is sent twice", async () => {
    leftByEarlierPage({ path: "/api/nodes/a", body: '{"markdown":"甲"}', idemKey: "old" });
    mocks.api.mockRejectedValue(new ApiError(422, "bad"));
    await flushPendingWrites();
    expect(mocks.api).toHaveBeenCalledOnce();
    expect(getRecoveryWrites().map((write) => [write.idemKey, Boolean(write.rejection)])).toEqual([["old", true]]);
  });
});

// scan-03: a save queued while the drain ahead of it in the lane is sending. The caller said "offline" (or saw a backlog)
// before the drain finished and the drain had read the queue before the row existed; with the app online nothing else sends it.
describe("a write queued while the queue is being sent", () => {
  const first = { method: "PATCH" as const, path: "/api/nodes/first", body: '{"markdown":"1"}' };
  const later = (n: number) => ({ method: "PATCH" as const, path: `/api/nodes/later-${n}`, body: `{"markdown":"${n}"}`, online: false });
  const callsTo = (path: string) => mocks.api.mock.calls.filter((call) => call[0] === path).length;

  it("is sent when the app is online: one API call for it", async () => {
    mocks.online = true;
    writes.push({ id: 1, method: first.method, path: first.path, body: first.body, idem_key: "first-key", attempts: 0 });
    const answer = deferred<unknown>();
    mocks.api.mockImplementation((path: string) => (path === first.path ? answer.promise : Promise.resolve({ ok: true })));
    const draining = flushPendingWrites();
    await vi.waitFor(() => expect(callsTo(first.path)).toBe(1));
    const saving = submitWrite(later(1));
    answer.resolve({ ok: true });
    await Promise.all([draining, saving]);
    await vi.waitFor(() => expect(writes).toEqual([]));
    expect(callsTo("/api/nodes/later-1")).toBe(1);
    expect(callsTo(first.path)).toBe(1);
    expect(getPendingCount()).toBe(0);
  });

  it("stays queued while the app is offline: no send is asked for", async () => {
    mocks.online = false;
    writes.push({ id: 1, method: first.method, path: first.path, body: first.body, idem_key: "first-key", attempts: 0 });
    const answer = deferred<unknown>();
    mocks.api.mockImplementation((path: string) => (path === first.path ? answer.promise : Promise.resolve({ ok: true })));
    const draining = flushPendingWrites();
    await vi.waitFor(() => expect(callsTo(first.path)).toBe(1));
    const saving = submitWrite(later(1));
    answer.resolve({ ok: true });
    await Promise.all([draining, saving]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(callsTo("/api/nodes/later-1")).toBe(0);
    expect(writes.map((write) => write.path)).toEqual(["/api/nodes/later-1"]);
  });

  it("20 such writes cost at most two drains (the one running and one after them), each sent once", async () => {
    mocks.online = true;
    writes.push({ id: 1, method: first.method, path: first.path, body: first.body, idem_key: "first-key", attempts: 0 });
    const answer = deferred<unknown>();
    mocks.api.mockImplementation((path: string) => (path === first.path ? answer.promise : Promise.resolve({ ok: true })));
    const draining = flushPendingWrites();
    await vi.waitFor(() => expect(callsTo(first.path)).toBe(1));
    // catchUpWithOtherTabs runs once per drain (an `online: false` submission does not call it).
    const drainsBefore = vi.mocked(catchUpWithOtherTabs).mock.calls.length;
    const saves = Array.from({ length: 20 }, (_, i) => submitWrite(later(i + 1)));
    answer.resolve({ ok: true });
    await Promise.all([draining, ...saves]);
    await vi.waitFor(() => expect(writes).toEqual([]));
    // Submissions wait in the lane behind the running drain, so every flush they ask for joins the one that starts after
    // all twenty rows exist: the bound does not grow with the number of writes.
    expect(vi.mocked(catchUpWithOtherTabs).mock.calls.length - drainsBefore).toBeLessThanOrEqual(1);
    for (let i = 1; i <= 20; i++) expect(callsTo(`/api/nodes/later-${i}`)).toBe(1);
  });

  it("a server answering 5xx while online does not spin: the old backoff decides the next send", async () => {
    mocks.online = true;
    writes.push({ id: 1, method: first.method, path: first.path, body: first.body, idem_key: "first-key", attempts: 0 });
    const answer = deferred<unknown>();
    mocks.api.mockImplementation((path: string) => (path === first.path ? answer.promise.then(() => { throw new ApiError(503, "down"); }) : Promise.reject(new ApiError(503, "down"))));
    try {
      const draining = flushPendingWrites();
      await vi.waitFor(() => expect(callsTo(first.path)).toBe(1));
      const saving = submitWrite(later(1));
      answer.resolve(null);
      await Promise.all([draining, saving]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const settled = mocks.api.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Nothing re-flushes by itself inside the first backoff step (WRITE_RETRY_DELAYS_MS[0]); both rows are still queued.
      expect(mocks.api.mock.calls.length).toBe(settled);
      expect(settled).toBeLessThanOrEqual(3);
      expect(writes.map((write) => write.path)).toEqual([first.path, "/api/nodes/later-1"]);
    } finally { stopWriteRetry(); }
  });
});
