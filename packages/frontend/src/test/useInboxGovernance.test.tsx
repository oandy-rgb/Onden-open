import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInboxGovernance } from "../hooks/useInboxGovernance";
import { api, ApiError, type InboxEvent, type PendingApproval } from "../lib/api";
import { addToast } from "../lib/appStore";

vi.mock("../lib/api", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/api")>(), api: vi.fn(),
}));
vi.mock("../lib/appStore", async (original) => ({ ...await original<typeof import("../lib/appStore")>(), addToast: vi.fn() }));

function event(id: string): InboxEvent {
  return { id, actor_type: "ai_agent", actor_id: "agent", event_type: "NODE_UPDATED",
    target_type: "node", target_id: "note", payload: {}, created_at: "2026-09-30T00:00:00Z",
    external: false, restorable: true };
}
function approval(id: string): PendingApproval {
  return { id, effect_kind: "publish", payload: {}, created_at: "2026-09-30T00:00:00Z",
    updated_at: "2026-09-30T00:00:00Z" };
}
function page(id: string) {
  return { events: [event(id)], groups: [], facets: { by_actor: [], by_type: [] } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const mockApi = vi.mocked(api);
const refresh = vi.fn(async () => {});
const initialProps: Parameters<typeof useInboxGovernance>[0] = {
  enabled: true, workspaceId: "workspace-a", refresh,
};
function useQueue(props = initialProps) { return useInboxGovernance(props); }
function respond(id: string) {
  mockApi.mockResolvedValueOnce(page(id)).mockResolvedValueOnce({ approvals: [approval(id)] });
}

beforeEach(() => { mockApi.mockReset(); refresh.mockClear(); vi.mocked(addToast).mockClear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("inbox safe workspace readiness", () => {
  it("waits for safe readiness, then loads once without reacting to unrelated renders", async () => {
    respond("ready");
    const { result, rerender } = renderHook(useQueue, {
      initialProps: { ...initialProps, enabled: false },
    });
    await act(async () => { await result.current.loadInboxReview(); });
    expect(mockApi).not.toHaveBeenCalled();
    rerender(initialProps);
    await waitFor(() => expect(result.current.inboxApprovals[0]?.id).toBe("ready"));
    expect(mockApi.mock.calls.map(([url]) => url)).toEqual(["/api/inbox", "/api/inbox/approvals"]);
    const initialLoader = result.current.loadInboxReview;
    rerender({ ...initialProps, refresh: async () => {} });
    await act(async () => {});
    expect(mockApi).toHaveBeenCalledTimes(2);
    expect(result.current.loadInboxReview).toBe(initialLoader);
  });

  it("does not read without a workspace identity", async () => {
    respond("wrong");
    const { result } = renderHook(useQueue, { initialProps: { ...initialProps, workspaceId: "" } });
    await act(async () => { await result.current.loadInboxReview(); });
    expect(mockApi).not.toHaveBeenCalled();
  });

  it("hides all queues on gating and discards late approvals before rechecking", async () => {
    respond("old");
    const { result, rerender } = renderHook(useQueue, { initialProps });
    await waitFor(() => expect(result.current.inboxApprovals[0]?.id).toBe("old"));
    const late = deferred<{ approvals: PendingApproval[] }>();
    mockApi.mockResolvedValueOnce(page("stale")).mockReturnValueOnce(late.promise);
    let reloaded!: Promise<void>;
    act(() => { reloaded = result.current.loadInboxReview(); });
    await waitFor(() => expect(mockApi).toHaveBeenCalledTimes(4));
    const signal = mockApi.mock.lastCall![1]?.signal;
    const staleReload = result.current.loadInboxReview;
    rerender({ ...initialProps, enabled: false });
    expect(result.current.inboxReview).toEqual([]);
    expect(result.current.inboxGroups).toEqual([]);
    expect(result.current.inboxFacets).toBeNull();
    expect(result.current.inboxApprovals).toEqual([]);
    expect(signal?.aborted).toBe(true);
    await act(async () => { late.resolve({ approvals: [approval("stale")] }); await reloaded; });
    expect(result.current.inboxReview).toEqual([]);
    await act(async () => { await staleReload(); });
    expect(mockApi).toHaveBeenCalledTimes(4);
    respond("checked");
    rerender(initialProps);
    await waitFor(() => expect(result.current.inboxApprovals[0]?.id).toBe("checked"));
    expect(result.current.inboxReview[0]?.id).toBe("checked");
    expect(mockApi).toHaveBeenCalledTimes(6);
  });
});

describe("inbox query ownership", () => {
  it.each(["success", "failure"])("retires a previous workspace's late %s", async outcome => {
    const first = deferred<ReturnType<typeof page>>();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mockApi.mockReturnValueOnce(first.promise);
    const { result, rerender } = renderHook(useQueue, { initialProps });
    const staleReload = result.current.loadInboxReview;
    respond("workspace-b");
    rerender({ ...initialProps, workspaceId: "workspace-b" });
    await waitFor(() => expect(result.current.inboxApprovals[0]?.id).toBe("workspace-b"));
    await act(async () => {
      if (outcome === "success") first.resolve(page("workspace-a"));
      else first.reject(new Error("old workspace failed"));
    });
    await act(async () => { await staleReload(); });
    expect(result.current.inboxReview[0]?.id).toBe("workspace-b");
    expect(result.current.inboxApprovals[0]?.id).toBe("workspace-b");
    expect(mockApi).toHaveBeenCalledTimes(3);
    expect(log).not.toHaveBeenCalled();
  });

  it("filters at the server and never revives the first A after A → B → A", async () => {
    const first = deferred<ReturnType<typeof page>>();
    mockApi.mockReturnValueOnce(first.promise);
    const { result } = renderHook(useQueue);
    const firstReload = result.current.loadInboxReview;
    respond("filtered");
    act(() => result.current.setInboxFilters({ actorId: "agent / 1", eventType: "NODE_UPDATED" }));
    expect(result.current.inboxReview).toEqual([]);
    await waitFor(() => expect(result.current.inboxApprovals[0]?.id).toBe("filtered"));
    const query = new URL(mockApi.mock.calls[1][0], "http://test").searchParams;
    expect(query.get("actor_id")).toBe("agent / 1");
    expect(query.get("event_type")).toBe("NODE_UPDATED");
    respond("fresh-a");
    act(() => result.current.setInboxFilters({ actorId: null, eventType: null }));
    expect(result.current.inboxReview).toEqual([]);
    await waitFor(() => expect(result.current.inboxApprovals[0]?.id).toBe("fresh-a"));
    await act(async () => { first.resolve(page("stale-a")); await firstReload(); });
    expect(result.current.inboxReview[0]?.id).toBe("fresh-a");
    expect(mockApi).toHaveBeenCalledTimes(5);
    act(() => result.current.setInboxFilters({ actorId: null, eventType: null }));
    await act(async () => {});
    expect(mockApi).toHaveBeenCalledTimes(5);
  });

  it("aborts on unmount and settles queued reloads even if transport ignores cancellation", async () => {
    const pending = deferred<ReturnType<typeof page>>();
    mockApi.mockReturnValueOnce(pending.promise);
    const { result, unmount } = renderHook(useQueue);
    let reloaded!: Promise<void>;
    act(() => { reloaded = result.current.loadInboxReview(); });
    const signal = mockApi.mock.calls[0][1]?.signal;
    unmount();
    expect(signal?.aborted).toBe(true);
    await reloaded;
    await act(async () => pending.resolve(page("unmounted")));
    expect(mockApi).toHaveBeenCalledTimes(1);
  });
});

describe("inbox invalidation ordering", () => {
  it("coalesces ticks during a read into one fresh follow-up without parallel requests", async () => {
    const first = deferred<ReturnType<typeof page>>();
    const followup = deferred<ReturnType<typeof page>>();
    mockApi.mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ approvals: [approval("first")] })
      .mockReturnValueOnce(followup.promise)
      .mockResolvedValueOnce({ approvals: [approval("latest")] });
    const { result } = renderHook(useQueue);
    let reloads!: Promise<void>[];
    act(() => { reloads = Array.from({ length: 3 }, () => result.current.loadInboxReview()); });
    expect(mockApi).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve(page("first")));
    expect(mockApi.mock.calls.map(([url]) => url)).toEqual([
      "/api/inbox", "/api/inbox/approvals", "/api/inbox",
    ]);
    await act(async () => { followup.resolve(page("latest")); await Promise.all(reloads); });
    expect(result.current.inboxReview[0]?.id).toBe("latest");
    expect(result.current.inboxApprovals[0]?.id).toBe("latest");
    expect(mockApi).toHaveBeenCalledTimes(4);
  });

  it("keeps the last complete queues on refresh failure, then recovers", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    respond("saved");
    const { result } = renderHook(useQueue);
    await waitFor(() => expect(result.current.inboxApprovals[0]?.id).toBe("saved"));
    mockApi.mockResolvedValueOnce(page("partial")).mockRejectedValueOnce(new Error("unavailable"));
    await act(async () => { await result.current.loadInboxReview(); });
    expect(result.current.inboxReview[0]?.id).toBe("saved");
    expect(result.current.inboxApprovals[0]?.id).toBe("saved");
    expect(log).toHaveBeenCalledTimes(1);
    respond("recovered");
    await act(async () => { await result.current.loadInboxReview(); });
    expect(result.current.inboxReview[0]?.id).toBe("recovered");
    expect(result.current.inboxApprovals[0]?.id).toBe("recovered");
  });
});

describe("inbox load failure", () => {
  it("reports a failed first read instead of looking like an empty queue, and clears on retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockApi.mockRejectedValueOnce(new Error("unavailable"));
    const { result } = renderHook(useQueue);
    await waitFor(() => expect(result.current.inboxLoadFailed).toBe(true));
    expect(result.current.inboxReview).toEqual([]);
    respond("recovered");
    await act(async () => { await result.current.loadInboxReview(); });
    expect(result.current.inboxLoadFailed).toBe(false);
    expect(result.current.inboxReview[0]?.id).toBe("recovered");
  });

  it("keeps the last queues but still reports a failed refresh", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    respond("saved");
    const { result } = renderHook(useQueue);
    await waitFor(() => expect(result.current.inboxReview[0]?.id).toBe("saved"));
    expect(result.current.inboxLoadFailed).toBe(false);
    mockApi.mockResolvedValueOnce(page("partial")).mockRejectedValueOnce(new Error("unavailable"));
    await act(async () => { await result.current.loadInboxReview(); });
    expect(result.current.inboxReview[0]?.id).toBe("saved");
    expect(result.current.inboxLoadFailed).toBe(true);
  });
});

describe("bounded inbox reads", () => {
  it.each([
    ["events", "success"], ["events", "failure"],
    ["approvals", "success"], ["approvals", "failure"],
  ] as const)("releases stalled %s after 15 seconds and ignores its late %s", async (stage, outcome) => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    respond("saved");
    const { result } = renderHook(useQueue);
    await act(async () => {});
    expect(result.current.inboxApprovals[0]?.id).toBe("saved");

    const stalled = deferred<ReturnType<typeof page> | { approvals: PendingApproval[] }>();
    if (stage === "approvals") mockApi.mockResolvedValueOnce(page("partial"));
    mockApi.mockReturnValueOnce(stalled.promise);
    let stalledReload!: Promise<void>;
    act(() => { stalledReload = result.current.loadInboxReview(); });
    await act(async () => {});
    const callsBeforeTimeout = stage === "events" ? 3 : 4;
    expect(mockApi).toHaveBeenCalledTimes(callsBeforeTimeout);
    const signal = mockApi.mock.lastCall![1]?.signal;
    respond("fresh");
    let followup!: Promise<void>;
    act(() => { followup = result.current.loadInboxReview(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(14_999); });
    expect(signal?.aborted).toBe(false);
    expect(mockApi).toHaveBeenCalledTimes(callsBeforeTimeout);
    expect(result.current.inboxReview[0]?.id).toBe("saved");

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(signal?.aborted).toBe(true);
    await act(async () => { await Promise.all([stalledReload, followup]); });
    expect(result.current.inboxReview[0]?.id).toBe("fresh");
    expect(result.current.inboxApprovals[0]?.id).toBe("fresh");
    expect(mockApi).toHaveBeenCalledTimes(callsBeforeTimeout + 2);
    expect(log).toHaveBeenCalledTimes(1);

    if (outcome === "failure") {
      respond("filtered");
      act(() => result.current.setInboxFilters({ actorId: "next-agent", eventType: null }));
      await act(async () => {});
      expect(result.current.inboxReview[0]?.id).toBe("filtered");
    }
    const callsBeforeLateResult = mockApi.mock.calls.length;
    await act(async () => {
      if (outcome === "failure") stalled.reject(new Error("late retired read failed"));
      else stalled.resolve(stage === "events" ? page("stale") : { approvals: [approval("stale")] });
    });
    const current = outcome === "failure" ? "filtered" : "fresh";
    expect(result.current.inboxReview[0]?.id).toBe(current);
    expect(result.current.inboxApprovals[0]?.id).toBe(current);
    expect(log).toHaveBeenCalledTimes(1);
    expect(mockApi).toHaveBeenCalledTimes(callsBeforeLateResult);

    // A later independent invalidation still reads after the timed-out batch.
    respond("next");
    await act(async () => { await result.current.loadInboxReview(); });
    expect(result.current.inboxReview[0]?.id).toBe("next");
    expect(result.current.inboxApprovals[0]?.id).toBe("next");
  });
});

describe("inbox decisions retain explicit refresh", () => {
  it.each(["event", "group", "batch", "held"] as const)("refreshes after a %s decision", async kind => {
    respond("before");
    const { result } = renderHook(useQueue);
    await waitFor(() => expect(result.current.inboxApprovals[0]?.id).toBe("before"));
    mockApi.mockResolvedValueOnce({ decided: 1, skipped: [] });
    respond("after");
    await act(async () => {
      if (kind === "event") await result.current.reviewEvent("event", "reject");
      else if (kind === "group") await result.current.decideGroup("group", "reject");
      else if (kind === "batch") await result.current.batchReview(["event"], "reject");
      else await result.current.decideHeldEffect("effect", "approve");
    });
    expect(mockApi.mock.calls[2][1]?.method).toBe("POST");
    expect(refresh).toHaveBeenCalledTimes(kind === "held" ? 0 : 1);
    expect(result.current.inboxReview[0]?.id).toBe("after");
    expect(result.current.inboxApprovals[0]?.id).toBe("after");
    expect(result.current.inboxBusyId).toBeNull();
  });

  it("refreshes stale cards after a rejected decision", async () => {
    respond("stale");
    const { result } = renderHook(useQueue);
    await waitFor(() => expect(result.current.inboxApprovals[0]?.id).toBe("stale"));
    mockApi.mockRejectedValueOnce(new ApiError(409, JSON.stringify({ error: "already_reviewed" })));
    respond("current");
    await act(async () => { await result.current.reviewEvent("stale", "approve"); });
    expect(addToast).toHaveBeenCalledWith("This was already reviewed.", "error");
    expect(result.current.inboxReview[0]?.id).toBe("current");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes the current filter when an in-flight reject finishes", async () => {
    respond("before");
    const { result } = renderHook(useQueue);
    await waitFor(() => expect(result.current.inboxApprovals[0]?.id).toBe("before"));
    const decision = deferred<object>();
    mockApi.mockReturnValueOnce(decision.promise);
    let decided!: Promise<void>;
    act(() => { decided = result.current.reviewEvent("event", "reject"); });
    respond("during");
    act(() => result.current.setInboxFilters({ actorId: "agent-b", eventType: null }));
    await waitFor(() => expect(result.current.inboxApprovals[0]?.id).toBe("during"));
    respond("after");
    await act(async () => { decision.resolve({}); await decided; });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(mockApi.mock.calls[5][0]).toBe("/api/inbox?actor_id=agent-b");
    expect(result.current.inboxReview[0]?.id).toBe("after");
  });

  it("does not replay old decision UI effects into another workspace or while disabled", async () => {
    respond("old");
    const { result, rerender } = renderHook(useQueue, { initialProps });
    await waitFor(() => expect(result.current.inboxApprovals[0]?.id).toBe("old"));
    const decision = deferred<object>();
    mockApi.mockReturnValueOnce(decision.promise);
    let decided!: Promise<void>;
    act(() => { decided = result.current.reviewEvent("old", "reject"); });
    respond("new");
    rerender({ ...initialProps, workspaceId: "workspace-b" });
    await waitFor(() => expect(result.current.inboxApprovals[0]?.id).toBe("new"));
    expect(result.current.inboxBusyId).toBeNull();
    await act(async () => { decision.resolve({}); await decided; });
    expect(refresh).not.toHaveBeenCalled();
    expect(result.current.inboxReview[0]?.id).toBe("new");
    expect(mockApi).toHaveBeenCalledTimes(5);
    rerender({ ...initialProps, enabled: false });
    await act(async () => { await result.current.reviewEvent("old", "approve"); });
    expect(mockApi).toHaveBeenCalledTimes(5);
  });
});
