import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVICE_ID_HEADER, isUuid } from "@onden/markdown";

// The device id names this browser, not the signed-in account: made once, kept across reloads and account
// changes, and carried by every request (the server records it on the write's event).

const queue = vi.hoisted(() => ({ rows: [] as Array<{ id: number; method: string; path: string; body: string | null; idem_key: string | null; attempts: number }> }));
vi.mock("../lib/localDb", () => ({
  addPendingWrite: vi.fn(async (method: string, path: string, body: string | null, idemKey: string | null) => {
    queue.rows.push({ id: queue.rows.length + 1, method, path, body, idem_key: idemKey, attempts: 0 });
  }),
  getPendingWrites: vi.fn(async () => queue.rows.map((row) => ({ ...row }))),
  clearPendingWrite: vi.fn(async (id: number) => { queue.rows = queue.rows.filter((row) => row.id !== id); }),
  bumpPendingWriteAttempt: vi.fn(async () => 1),
  catchUpWithOtherTabs: vi.fn(async () => {}),
  getOldestPendingWriteAt: vi.fn(async () => null),
}));

beforeEach(() => { localStorage.clear(); queue.rows = []; vi.resetModules(); });
afterEach(() => vi.unstubAllGlobals());

describe("device id", () => {
  it("is a UUID made once and the same after a reload", async () => {
    const first = (await import("../lib/deviceId")).deviceId();
    expect(isUuid(first)).toBe(true);
    expect((await import("../lib/deviceId")).deviceId()).toBe(first);
    vi.resetModules(); // a reload: new module state, same localStorage
    expect((await import("../lib/deviceId")).deviceId()).toBe(first);
  });

  it("does not change when another account signs in on this browser", async () => {
    const accountStorage = await import("../lib/accountStorage");
    const { deviceId } = await import("../lib/deviceId");
    accountStorage.bindAccountStorage("user-a", "");
    const first = deviceId();
    accountStorage.bindAccountStorage("user-b", "");
    expect(deviceId()).toBe(first);
  });

  it("makes a new one when stored value is not a UUID (cleared or damaged site data)", async () => {
    localStorage.setItem("onden.deviceId", "garbage");
    const id = (await import("../lib/deviceId")).deviceId();
    expect(isUuid(id)).toBe(true);
    expect(localStorage.getItem("onden.deviceId")).toBe(id);
  });

  it("stays stable for the page when storage is blocked", async () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    const { deviceId } = await import("../lib/deviceId");
    expect(deviceId()).toBe(deviceId());
  });

  it("goes out on every request, a keepalive one included", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("../lib/api");
    const { deviceId } = await import("../lib/deviceId");
    await apiFetch("/api/nodes/n", { method: "PATCH", body: "{}", keepalive: true });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.keepalive).toBe(true);
    expect(new Headers(init.headers).get(DEVICE_ID_HEADER)).toBe(deviceId());
  });

  it("goes out with a queued write when the queue sends it again", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockImplementation(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const { sendOrQueue, flushPendingWrites, stopWriteRetry } = await import("../lib/data/writeQueue");
    const { deviceId } = await import("../lib/deviceId");
    await sendOrQueue("PATCH", "/api/nodes/n1", JSON.stringify({ title: "x" }));
    expect(queue.rows).toHaveLength(1);
    await flushPendingWrites();
    stopWriteRetry();
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of fetchMock.mock.calls) {
      expect(new Headers((call as unknown as [string, RequestInit])[1].headers).get(DEVICE_ID_HEADER)).toBe(deviceId());
    }
  });
});
