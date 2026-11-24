// A write the server refused is never sent again, even when taking its row out of the queue fails (lib/data/
// storageSteps.ts refusedWriteStep; docs/agents/mistakes.md「儲存失敗被吞掉」). Only lib/api and lib/localDb are fake.
import { bindAccountStorage } from "../lib/accountStorage";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/api")>();
  return { ...mod, api: apiMock };
});
vi.mock("../lib/localDb", () => ({
  storeRejectedWrite: vi.fn(),
  addPendingWrite: vi.fn(),
  getPendingWrites: vi.fn(),
  clearPendingWrite: vi.fn(),
  bumpPendingWriteAttempt: vi.fn(),
  getOldestPendingWriteAt: vi.fn(),
  catchUpWithOtherTabs: vi.fn(),
}));

import { ApiError } from "../lib/api";
import { addPendingWrite, bumpPendingWriteAttempt, catchUpWithOtherTabs, clearPendingWrite, getOldestPendingWriteAt, getPendingWrites, storeRejectedWrite } from "../lib/localDb";
import { memoryQueue } from "./helpers/memoryQueue";
import { flushPendingWrites, sendOrQueue } from "../lib/data/writeQueue";
import { getPendingCount, refreshPendingCount, setPending } from "../lib/data/syncStatus";

const refused = () => Promise.reject(new ApiError(403, JSON.stringify({ error: "forbidden" })));
const sentTo = (path: string) => apiMock.mock.calls.filter(([p]) => p === path).length;

let queue: { rows: unknown[] };
beforeEach(() => {
  vi.resetAllMocks();
  bindAccountStorage("u-refused", "");
  queue = memoryQueue({ addPendingWrite, getPendingWrites, clearPendingWrite });
  vi.mocked(storeRejectedWrite).mockImplementation(async (request, rejection) => ({ ...request, id: 900, attempts: 0, rejection }));
  vi.mocked(bumpPendingWriteAttempt).mockImplementation(async () => 1);
  vi.mocked(getOldestPendingWriteAt).mockImplementation(async () => null);
  vi.mocked(catchUpWithOtherTabs).mockImplementation(async () => undefined as never);
  setPending(0);
});

describe("a refused write whose row could not be cleared", () => {
  it("is not sent again by the next drain, and the next drain clears the row once it can", async () => {
    // A delete (no typed text, so no recovery entry marks the row): only the clear takes it out of the queue.
    vi.mocked(clearPendingWrite).mockRejectedValueOnce(new Error("the local copy is restarting"));
    apiMock.mockImplementation((path: string) => (path === "/api/nodes/n1" ? refused() : Promise.resolve({})));

    await expect(sendOrQueue("DELETE", "/api/nodes/n1", null)).rejects.toMatchObject({ status: 403 });
    expect(queue.rows).toHaveLength(1); // the clear failed: the row is still there
    expect(sentTo("/api/nodes/n1")).toBe(1);

    await flushPendingWrites();
    expect(sentTo("/api/nodes/n1")).toBe(1); // at most once
    expect(queue.rows).toHaveLength(0); // the drain tried the clear again, and this time it held
  });

  it("is not counted as a change waiting to sync while its row stays", async () => {
    vi.mocked(clearPendingWrite).mockRejectedValue(new Error("storage is full"));
    apiMock.mockImplementation(refused);

    await expect(sendOrQueue("DELETE", "/api/nodes/n2", null)).rejects.toMatchObject({ status: 403 });
    await flushPendingWrites();
    await refreshPendingCount();
    expect(sentTo("/api/nodes/n2")).toBe(1);
    expect(queue.rows).toHaveLength(1);
    expect(getPendingCount()).toBe(0);
  });

  it("does not hold back the writes queued after it", async () => {
    vi.mocked(clearPendingWrite).mockRejectedValueOnce(new Error("the local copy is restarting"));
    apiMock.mockImplementation((path: string) => (path === "/api/nodes/n3" ? refused() : Promise.reject(new TypeError("offline"))));
    await expect(sendOrQueue("DELETE", "/api/nodes/n3", null)).rejects.toMatchObject({ status: 403 });
    await sendOrQueue("PATCH", "/api/nodes/n4", JSON.stringify({ title: "later" })); // queued (offline)

    apiMock.mockImplementation((path: string) => (path === "/api/nodes/n3" ? refused() : Promise.resolve({})));
    await flushPendingWrites();
    expect(sentTo("/api/nodes/n3")).toBe(1);
    expect(sentTo("/api/nodes/n4")).toBe(2);
    expect(queue.rows).toHaveLength(0);
  });
});
