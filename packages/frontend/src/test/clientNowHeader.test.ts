import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_NOW_HEADER } from "@onden/markdown";

// Every request names this device's clock at the moment it is SENT, so the server can turn an edit's device-dated time into an age
// (the device's own clock error cancels) instead of comparing it with its own clock. A write replayed from the queue carries the
// reading of the replay, not of the edit.

const queue = vi.hoisted(() => ({ rows: [] as Array<{ id: number; method: string; path: string; body: string | null; idem_key: string | null; attempts: number }> }));
vi.mock("../lib/localDb", () => ({
  addPendingWrite: vi.fn(async (method: string, path: string, body: string | null, idemKey: string | null) => {
    queue.rows.push({ id: queue.rows.length + 1, method, path, body, idem_key: idemKey, attempts: 0 });
  }),
  getPendingWrites: vi.fn(async () => queue.rows.map((row) => ({ ...row }))),
  clearPendingWrite: vi.fn(async (id: number) => { queue.rows = queue.rows.filter((row) => row.id !== id); }),
  bumpPendingWriteAttempt: vi.fn(async () => 1),
  countPendingWrites: vi.fn(async () => queue.rows.length),
}));

describe("the device's clock reading on every request", () => {
  beforeEach(() => { queue.rows = []; vi.resetModules(); vi.useFakeTimers({ toFake: ["Date"] }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("is the device's Date.now() at the moment of sending, fresh for each request", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("../lib/api");
    vi.setSystemTime(new Date("2030-01-01T10:00:00Z"));
    await apiFetch("/api/me/prefs/nav", { method: "PUT", body: "{}" });
    vi.setSystemTime(new Date("2030-01-01T10:00:07Z"));
    await apiFetch("/api/me/prefs/nav", { method: "PUT", body: "{}" });
    const sent = fetchMock.mock.calls.map((call) => new Headers((call as unknown as [string, RequestInit])[1].headers).get(CLIENT_NOW_HEADER));
    expect(sent).toEqual([String(Date.parse("2030-01-01T10:00:00Z")), String(Date.parse("2030-01-01T10:00:07Z"))]);
  });
});
