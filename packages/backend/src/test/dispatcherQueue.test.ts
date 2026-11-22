// A2 — dispatcherQueue tests. Verify serialization per node + DISPATCHER_FAILED
// emission on task error + parallelism across different nodes.
// M1 — durable-intent lifecycle (settle-DELETE) + the needs-replay derivation
// (pendingCascadeIntents: grace window + in-flight skip), DB mocked. The full
// crash→replay round-trip lives in dispatcherCatchup.integration.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";

const eventCalls: Array<{ type: string; targetId: string; payload?: Record<string, unknown> }> = [];
const eventFn = vi.fn(async (
  _ws: string, type: string, _tt: string, targetId: string,
  payload?: Record<string, unknown>,
): Promise<string> => {
  eventCalls.push({ type, targetId, payload });
  return "evt-mock";
});

const poolQuery = vi.fn(async (_text: string, _params?: unknown[]) => ({ rows: [] as unknown[] }));

vi.mock("../db.js", () => ({
  pool: { query: poolQuery },
  q: vi.fn(async () => ({ rows: [] })),
  event: eventFn,
}));
// The failure audit is written under the event lock (withEventTransaction); there is no database here, so the lock is the call itself.
// The actor ids here are not uuid-shaped, so signatureForCapturedActor signs with them as given and reads nothing.
vi.mock("../spine/eventTransaction.js", () => ({ withEventTransaction: async (_ws: string, fn: () => Promise<unknown>) => fn() }));

const {
  queueDispatcher, awaitAllDispatchers, awaitNodeDispatcher,
  inflightNodeIds, _resetDispatcherQueueForTests, pendingCascadeIntents,
} = await import("../services/dispatcherQueue.js");

beforeEach(() => {
  eventCalls.length = 0;
  eventFn.mockClear();
  poolQuery.mockClear();
  poolQuery.mockImplementation(async () => ({ rows: [] }));
  _resetDispatcherQueueForTests();
});

const ctx = (nodeId: string) => ({
  workspaceId: "ws-1", nodeId, actorId: "actor-1", label: "test",
});

describe("A2 dispatcherQueue", () => {
  it("runs a single task to completion", async () => {
    let ran = false;
    await queueDispatcher(ctx("n-1"), async () => { ran = true; });
    expect(ran).toBe(true);
  });

  it("serializes multiple tasks on the same node — second waits for first", async () => {
    const order: string[] = [];
    const t1 = queueDispatcher(ctx("n-1"), async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("first-done");
    });
    const t2 = queueDispatcher(ctx("n-1"), async () => {
      order.push("second-start");
    });
    await Promise.all([t1, t2]);
    expect(order).toEqual(["first-done", "second-start"]);
  });

  it("different nodes run in parallel", async () => {
    const order: string[] = [];
    const t1 = queueDispatcher(ctx("n-1"), async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("n1-done");
    });
    // n-2 should not wait for n-1.
    const t2 = queueDispatcher(ctx("n-2"), async () => {
      order.push("n2-done");
    });
    await Promise.all([t1, t2]);
    // n-2 finished before n-1 because they ran in parallel.
    expect(order[0]).toBe("n2-done");
    expect(order[1]).toBe("n1-done");
  });

  it("a failed task emits DISPATCHER_FAILED and does NOT propagate", async () => {
    // Caller awaits the returned promise but doesn't reject.
    await expect(queueDispatcher(ctx("n-1"), async () => {
      throw new Error("simulated cascade failure");
    })).resolves.toBeUndefined();
    expect(eventCalls).toHaveLength(1);
    expect(eventCalls[0]).toMatchObject({
      type: "DISPATCHER_FAILED",
      targetId: "n-1",
    });
    expect(eventCalls[0].payload?.error).toBe("simulated cascade failure");
  });

  it("a failed task does not block subsequent tasks on the same node", async () => {
    let secondRan = false;
    await queueDispatcher(ctx("n-1"), async () => {
      throw new Error("boom");
    });
    await queueDispatcher(ctx("n-1"), async () => { secondRan = true; });
    expect(secondRan).toBe(true);
    // 1 failure event from the first task.
    expect(eventCalls.filter((e) => e.type === "DISPATCHER_FAILED")).toHaveLength(1);
  });

  it("inflightNodeIds tracks active nodes; clears on completion", async () => {
    expect(inflightNodeIds()).toEqual([]);
    const tail = queueDispatcher(ctx("n-1"), async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(inflightNodeIds()).toContain("n-1");
    await tail;
    // Self-clean once the chain drains.
    expect(inflightNodeIds()).toEqual([]);
  });

  it("awaitNodeDispatcher waits for the specific node only", async () => {
    let n1Done = false, n2Done = false;
    void queueDispatcher(ctx("n-1"), async () => {
      await new Promise((r) => setTimeout(r, 20));
      n1Done = true;
    });
    void queueDispatcher(ctx("n-2"), async () => {
      await new Promise((r) => setTimeout(r, 40));
      n2Done = true;
    });
    await awaitNodeDispatcher("n-1");
    expect(n1Done).toBe(true);
    // n-2 may still be in flight.
    await awaitNodeDispatcher("n-2");
    expect(n2Done).toBe(true);
  });

  it("awaitAllDispatchers drains everything in flight", async () => {
    let count = 0;
    void queueDispatcher(ctx("n-1"), async () => { count++; });
    void queueDispatcher(ctx("n-2"), async () => { count++; });
    void queueDispatcher(ctx("n-3"), async () => { count++; });
    await awaitAllDispatchers();
    expect(count).toBe(3);
  });

  it("label appears in DISPATCHER_FAILED payload (for admin audit)", async () => {
    await queueDispatcher(
      { workspaceId: "ws", nodeId: "n", actorId: "a", label: "tag.recompute" },
      async () => { throw new Error("x"); },
    );
    expect(eventCalls[0].payload?.label).toBe("tag.recompute");
  });
});

describe("M1 durable intents", () => {
  const deleteCalls = () =>
    poolQuery.mock.calls.filter(([text]) => /DELETE FROM dispatcher_pending/.test(text));

  it("settle on SUCCESS deletes the durable intent", async () => {
    await queueDispatcher(
      { ...ctx("n-1"), triggerEventId: "42" },
      async () => { /* completed */ },
    );
    expect(deleteCalls()).toHaveLength(1);
    expect(deleteCalls()[0][1]).toEqual(["42"]);
  });

  it("settle on AUDITED FAILURE also deletes the intent — a deterministic throw must not be replayed at every boot", async () => {
    await queueDispatcher(
      { ...ctx("n-1"), triggerEventId: "43" },
      async () => { throw new Error("boom"); },
    );
    // Failure audited first, then the intent consumed.
    expect(eventCalls.filter((e) => e.type === "DISPATCHER_FAILED")).toHaveLength(1);
    expect(deleteCalls()).toHaveLength(1);
    expect(deleteCalls()[0][1]).toEqual(["43"]);
  });

  it("no triggerEventId (legacy fire-and-forget) → no intent cleanup attempted", async () => {
    await queueDispatcher(ctx("n-1"), async () => {});
    expect(deleteCalls()).toHaveLength(0);
  });

  it("a failing cleanup DELETE is contained (logged, chain stays usable)", async () => {
    poolQuery.mockImplementation(async (text: string) => {
      if (/DELETE FROM dispatcher_pending/.test(text)) throw new Error("pg down");
      return { rows: [] };
    });
    await expect(queueDispatcher(
      { ...ctx("n-1"), triggerEventId: "44" },
      async () => {},
    )).resolves.toBeUndefined();
    let ran = false;
    await queueDispatcher(ctx("n-1"), async () => { ran = true; });
    expect(ran).toBe(true);
  });

  it("needs-replay derivation: in-flight nodes are excluded; grace window reaches the SQL", async () => {
    poolQuery.mockImplementation(async (text: string) => {
      if (/FROM dispatcher_pending/.test(text)) {
        return { rows: [
          { event_id: "1", workspace_id: "ws", node_id: "n-busy", actor_id: "a", token_id: null, label: "l" },
          { event_id: "2", workspace_id: "ws", node_id: "n-idle", actor_id: "a", token_id: null, label: "l" },
        ] };
      }
      return { rows: [] };
    });
    // Hold a live chain open on n-busy.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const inflight = queueDispatcher(ctx("n-busy"), () => gate);

    const due = await pendingCascadeIntents({ graceMs: 1234 });
    expect(due.map((i) => i.node_id)).toEqual(["n-idle"]);
    // grace window is enforced IN the query (created_at cutoff), not in JS.
    const scan = poolQuery.mock.calls.find(([text]) => /FROM dispatcher_pending/.test(text))!;
    expect(scan[1]).toEqual(["1234"]);

    release();
    await inflight;
  });
});
