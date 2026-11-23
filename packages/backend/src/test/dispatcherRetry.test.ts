// Bounded in-process retry of a failed post-commit cascade. Fake clock: the
// backoff never really sleeps. Same DB mock shape as dispatcherQueue.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const eventCalls: Array<{ type: string; targetId: string; payload?: Record<string, unknown> }> = [];
const eventFn = vi.fn(async (
  _ws: string, type: string, _tt: string, targetId: string, payload?: Record<string, unknown>,
): Promise<string> => { eventCalls.push({ type, targetId, payload }); return "evt-mock"; });
const poolQuery = vi.fn(async (_text: string, _params?: unknown[]) => ({ rows: [] as unknown[] }));

vi.mock("../db.js", () => ({ pool: { query: poolQuery }, q: vi.fn(async () => ({ rows: [] })), event: eventFn }));
// The failure audit is written under the event lock (withEventTransaction); there is no database here, so the lock is the call itself.
// The actor ids here are not uuid-shaped, so signatureForCapturedActor signs with them as given and reads nothing.
vi.mock("../spine/eventTransaction.js", () => ({ withEventTransaction: async (_ws: string, fn: () => Promise<unknown>) => fn() }));

const { queueDispatcher, _resetDispatcherQueueForTests } = await import("../services/dispatcherQueue.js");

const transient = () => Object.assign(new Error("could not serialize access"), { code: "40001" });
const ctx = (nodeId: string, extra: object = {}) =>
  ({ workspaceId: "ws-1", nodeId, actorId: "actor-1", label: "test", triggerEventId: "7", ...extra });
const failed = () => eventCalls.filter((e) => e.type === "DISPATCHER_FAILED");
const intentDeletes = () => poolQuery.mock.calls.filter(([sql]) => /DELETE FROM dispatcher_pending/.test(sql)).length;

beforeEach(() => {
  vi.useFakeTimers();
  eventCalls.length = 0;
  eventFn.mockClear();
  poolQuery.mockClear();
  _resetDispatcherQueueForTests();
});
afterEach(() => vi.useRealTimers());

describe("dispatcher retry", () => {
  it("transient failure twice then success: no FAILED event, effect applied once, intent settled once", async () => {
    let calls = 0;
    const effects: string[] = [];
    const p = queueDispatcher(ctx("n-1"), async () => {
      calls++;
      if (calls < 3) throw transient();
      effects.push("applied");
    });
    await vi.advanceTimersByTimeAsync(200 + 1000);
    await p;
    expect(calls).toBe(3);
    expect(effects).toEqual(["applied"]);
    expect(failed()).toHaveLength(0);
    expect(intentDeletes()).toBe(1);
  });

  it("backs off 200ms then 1s then 3s", async () => {
    let calls = 0;
    const p = queueDispatcher(ctx("n-1"), async () => { calls++; throw transient(); });
    await vi.advanceTimersByTimeAsync(199);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(3000);
    await p;
    expect(calls).toBe(4);
  });

  it("always-transient: tries 1 + 3 times, then exactly one FAILED event carrying the attempt count", async () => {
    let calls = 0;
    const p = queueDispatcher(ctx("n-1"), async () => { calls++; throw transient(); });
    await vi.advanceTimersByTimeAsync(200 + 1000 + 3000);
    await p;
    expect(calls).toBe(4);
    expect(failed()).toHaveLength(1);
    expect(failed()[0].payload).toMatchObject({ label: "test", attempts: 4 });
    expect(intentDeletes()).toBe(1);
  });

  it("deterministic error: one attempt, FAILED with attempts 1, no waiting", async () => {
    let calls = 0;
    await queueDispatcher(ctx("n-1"), async () => { calls++; throw new Error("validation"); });
    expect(calls).toBe(1);
    expect(failed()).toHaveLength(1);
    expect(failed()[0].payload).toMatchObject({ attempts: 1 });
  });

  it("retryTransient:false (boot catch-up) never retries", async () => {
    let calls = 0;
    await queueDispatcher(ctx("n-1", { retryTransient: false }), async () => { calls++; throw transient(); });
    expect(calls).toBe(1);
    expect(failed()).toHaveLength(1);
  });

  it("a later task on the same node waits through the retries; other nodes do not", async () => {
    const order: string[] = [];
    let calls = 0;
    const a = queueDispatcher(ctx("n-1"), async () => {
      calls++; order.push(`a${calls}`);
      if (calls < 2) throw transient();
    });
    const b = queueDispatcher(ctx("n-1"), async () => { order.push("b"); });
    const other = queueDispatcher(ctx("n-2"), async () => { order.push("other"); });
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["a1", "other"]);
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([a, b, other]);
    expect(order).toEqual(["a1", "other", "a2", "b"]);
  });
});
