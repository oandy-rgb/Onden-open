// A 426 (this page is too old for the server, or the server for this page) is not a rejection: the write waits in the
// queue with its input, nothing retries on a timer, and it goes out once the other side is updated.
import { bindAccountStorage } from "../lib/accountStorage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ api: vi.fn(), toast: vi.fn() }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: mocks.api }));
vi.mock("../lib/appStore", () => ({ addToast: mocks.toast, getAppState: () => ({ online: false }) }));
vi.mock("../lib/localDb", () => ({
  catchUpWithOtherTabs: vi.fn(), getOldestPendingWriteAt: vi.fn(), addPendingWrite: vi.fn(), getPendingWrites: vi.fn(), clearPendingWrite: vi.fn(), bumpPendingWriteAttempt: vi.fn(), rejectPendingWrite: vi.fn(), storeRejectedWrite: vi.fn(), getRejectedWrites: vi.fn(), dismissRejectedWrite: vi.fn(),
}));

import { ApiError } from "../lib/api";
import { addPendingWrite, getPendingWrites, clearPendingWrite, bumpPendingWriteAttempt, rejectPendingWrite, storeRejectedWrite, getRejectedWrites, type PendingWrite } from "../lib/localDb";
import { submitWrite, flushPendingWrites, forgetAbandonedAttempts, stopWriteRetry } from "../lib/data/writeQueue";
import { setPending } from "../lib/data/syncStatus";
import { setLocalePref } from "../lib/i18n";
import { refreshRecoveryWrites } from "../lib/data/writeRecovery";
import { noteServerProtocol, resetProtocolGate } from "../lib/protocolGate";
import { CLIENT_PROTOCOL } from "@onden/markdown";

let writes: PendingWrite[];
const request = { method: "PATCH" as const, path: "/api/nodes/n1", body: '{"markdown":"typed text"}' };
const tooOld = () => new ApiError(426, '{"error":"client_too_old"}');

beforeEach(async () => {
  vi.useFakeTimers();
  bindAccountStorage("unit-test-account", "");
  forgetAbandonedAttempts();
  vi.resetAllMocks();
  resetProtocolGate();
  localStorage.clear();
  setLocalePref("en");
  setPending(0);
  writes = [];
  vi.mocked(getRejectedWrites).mockResolvedValue([]);
  await refreshRecoveryWrites();
  vi.mocked(getPendingWrites).mockImplementation(async () => [...writes]);
  vi.mocked(addPendingWrite).mockImplementation(async (method, path, body, idem_key) => {
    writes.push({ id: (writes.at(-1)?.id ?? 0) + 1, method, path, body, idem_key: idem_key ?? null, attempts: 0 });
  });
  vi.mocked(clearPendingWrite).mockImplementation(async (id) => { writes = writes.filter((write) => write.id !== id); });
});
afterEach(() => { stopWriteRetry(); vi.useRealTimers(); });

describe("a write the server refuses with 426", () => {
  it("is queued with its input, not rejected into recovery, and no timer retries it", async () => {
    mocks.api.mockRejectedValue(tooOld());
    await expect(submitWrite({ ...request, idemKey: "key-1" })).resolves.toEqual({ status: "queued" });
    expect(writes).toMatchObject([{ method: "PATCH", path: request.path, body: request.body, idem_key: "key-1" }]);
    expect(rejectPendingWrite).not.toHaveBeenCalled();
    expect(storeRejectedWrite).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stays queued through a drain: not rejected, not counted as a failed attempt, not retried on a timer", async () => {
    mocks.api.mockRejectedValue(tooOld());
    await submitWrite({ ...request, idemKey: "key-1" });
    await flushPendingWrites();
    expect(writes).toHaveLength(1);
    expect(bumpPendingWriteAttempt).not.toHaveBeenCalled();
    expect(rejectPendingWrite).not.toHaveBeenCalled();
    expect(storeRejectedWrite).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("goes out with its original key once the page is current, and leaves the queue", async () => {
    mocks.api.mockRejectedValue(tooOld());
    await submitWrite({ ...request, idemKey: "key-1" });
    mocks.api.mockReset();
    mocks.api.mockResolvedValue({});
    await flushPendingWrites();
    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(mocks.api.mock.calls[0]![1]).toMatchObject({ method: "PATCH", headers: { "Idempotency-Key": "key-1" } });
    expect(writes).toHaveLength(0);
  });
});

describe("a server older than this page accepts", () => {
  it("sends the queue by itself once an updated server answers", async () => {
    mocks.api.mockRejectedValue(new ApiError(426, '{"error":"server_too_old"}'));
    await submitWrite({ ...request, idemKey: "key-2" });
    noteServerProtocol(String(CLIENT_PROTOCOL - 1));
    mocks.api.mockReset();
    mocks.api.mockResolvedValue({});
    noteServerProtocol(String(CLIENT_PROTOCOL));
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(writes).toHaveLength(0));
  });
});
