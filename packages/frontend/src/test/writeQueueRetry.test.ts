import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The browser stays online, one send fails for a passing reason (502, timeout,
// dropped connection) and the write waits in the queue. Nothing else happens:
// no edit, no online event, no reload. The queue must send it again by itself,
// with a growing wait, and must not keep sending what a retry cannot fix.

const { apiMock, queue } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  queue: { rows: [] as Array<{ id: number; method: string; path: string; body: string | null; idem_key: string | null; attempts: number }>, nextId: 1 },
}));
vi.mock("../lib/api", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/api")>(), api: apiMock }));
vi.mock("../lib/localDb", () => ({
  addPendingWrite: vi.fn(async (method: string, path: string, body: string | null, idemKey: string | null) => {
    queue.rows.push({ id: queue.nextId++, method, path, body, idem_key: idemKey, attempts: 0 });
  }),
  getPendingWrites: vi.fn(async () => queue.rows.map((row) => ({ ...row }))),
  clearPendingWrite: vi.fn(async (id: number) => { queue.rows = queue.rows.filter((row) => row.id !== id); }),
  bumpPendingWriteAttempt: vi.fn(async (id: number) => {
    const row = queue.rows.find((candidate) => candidate.id === id);
    if (row) row.attempts += 1;
    return row?.attempts ?? 0;
  }),
  catchUpWithOtherTabs: vi.fn(async () => {}),
  getOldestPendingWriteAt: vi.fn(async () => null),
  storeRejectedWrite: vi.fn(async (request: object, rejection: string) => ({ ...request, id: 900, attempts: 0, rejection })),
  rejectPendingWrite: vi.fn(async (write: { id: number }, rejection: string) => {
    queue.rows = queue.rows.filter((row) => row.id !== write.id);
    return { ...write, rejection };
  }),
}));

import { ApiError } from "../lib/api";
import { submitWrite, stopWriteRetry } from "../lib/data/writeQueue";

const unavailable = () => new ApiError(503, "unavailable");
const sent = () => apiMock.mock.calls.length;
/** Writes only: after a refused delete the device also reads the note back from the server. */
const sentWrites = () => apiMock.mock.calls.filter((call) => call[1]?.method && call[1].method !== "GET").length;
const setVisibility = (state: "visible" | "hidden") => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
};

beforeEach(() => {
  vi.useFakeTimers();
  apiMock.mockReset();
  queue.rows = [];
  queue.nextId = 1;
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  setVisibility("visible");
});
afterEach(() => {
  stopWriteRetry();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a queued write while the browser is online", () => {
  it("is sent again by itself after a temporary failure", async () => {
    apiMock.mockRejectedValueOnce(unavailable()).mockResolvedValue({ ok: true });
    const result = await submitWrite({ method: "PATCH", path: "/api/nodes/a", body: JSON.stringify({ markdown: "x" }) });
    expect(result.status).toBe("queued");
    expect(queue.rows).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent()).toBe(2);
    expect(queue.rows).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent()).toBe(2);
  });

  it("waits longer after each failure: 2, 5, 15, then 60 seconds", async () => {
    apiMock.mockRejectedValue(unavailable());
    await submitWrite({ method: "PATCH", path: "/api/nodes/a", body: JSON.stringify({ markdown: "x" }) });
    expect(sent()).toBe(1);
    const gaps: number[] = [];
    for (const wait of [2_000, 5_000, 15_000, 60_000, 60_000]) {
      const before = sent();
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(sent()).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent()).toBe(before + 1);
      gaps.push(wait);
    }
    expect(gaps).toEqual([2_000, 5_000, 15_000, 60_000, 60_000]);
    expect(queue.rows).toHaveLength(1);
  });

  it("is not sent while the tab is in the background, and goes out when it comes back", async () => {
    apiMock.mockRejectedValueOnce(unavailable()).mockResolvedValue({ ok: true });
    await submitWrite({ method: "PATCH", path: "/api/nodes/a", body: JSON.stringify({ markdown: "x" }) });
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sent()).toBe(1);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(sent()).toBe(2);
    expect(queue.rows).toHaveLength(0);
  });

  it("is not retried when the server refuses it for good", async () => {
    apiMock.mockRejectedValueOnce(unavailable()).mockRejectedValue(new ApiError(404, "not found"));
    await submitWrite({ method: "DELETE", path: "/api/nodes/a", body: null });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sentWrites()).toBe(2);
    expect(queue.rows).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sentWrites()).toBe(2);
  });

  it("is left for the online event when the browser itself is offline", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    apiMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await submitWrite({ method: "PATCH", path: "/api/nodes/a", body: "{}" });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sent()).toBe(1);
    expect(queue.rows).toHaveLength(1);
  });

  it("a person's sign-in problem (401) is not retried on a timer", async () => {
    apiMock.mockRejectedValue(new ApiError(401, "unauthorized"));
    await submitWrite({ method: "PATCH", path: "/api/nodes/a", body: "{}" });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sent()).toBe(1);
  });
});
