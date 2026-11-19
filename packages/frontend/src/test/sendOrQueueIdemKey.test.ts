import { bindAccountStorage } from "../lib/accountStorage";
import { describe, it, expect, vi, beforeEach } from "vitest";

// M15: a keyless write that COMMITS server-side but loses its response must be
// queued with the SAME idempotency key it sent on attempt 1, so the reconnect
// drain's replay dedupes instead of re-executing (duplicate). sendOrQueue used to
// send no key on attempt 1 for keyless callers and let queueWrite mint a fresh
// one at queue time.

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/api")>();
  return { ...mod, api: apiMock };
});
vi.mock("../lib/localDb", () => ({
  storeRejectedWrite: async (request: import("../lib/localDb").RejectedRequest, rejection: string) => ({ ...request, id: 901, attempts: 0, rejection }),
  addPendingWrite: vi.fn(async () => null),
  getPendingWrites: vi.fn(async () => []),
  clearPendingWrite: vi.fn(async () => {}),
  upsertAttribute: vi.fn(async () => null),
}));

import { ApiError } from "../lib/api";
import { sendOrQueue } from "../lib/data/writeQueue";
import { addPendingWrite, clearPendingWrite, getPendingWrites } from "../lib/localDb";
import { memoryQueue } from "./helpers/memoryQueue";

// What is left queued once a write settled (every save is recorded first; see helpers/memoryQueue).
let queue: { rows: unknown[] };

beforeEach(() => {
  apiMock.mockReset();
  vi.mocked(addPendingWrite).mockClear(); queue = memoryQueue({ addPendingWrite, getPendingWrites, clearPendingWrite });
});

describe("sendOrQueue keyless exactly-once (M15)", () => {
  it("queues with the same key sent on attempt 1 when no key was supplied", async () => {
    let sentKey: string | undefined;
    apiMock.mockImplementation(async (_path: string, init?: RequestInit) => {
      sentKey = (init?.headers as Record<string, string> | undefined)?.["Idempotency-Key"];
      throw new ApiError(503, "gateway down");
    });

    const r = await sendOrQueue("PATCH", "/api/nodes/n1", JSON.stringify({ title: "x" }));
    expect(r).toBeUndefined(); // transport failure → queued

    // Attempt 1 carried a minted key...
    expect(sentKey, "the first attempt must carry an Idempotency-Key").toBeTruthy();
    // ...and the queued write carries the SAME key (addPendingWrite 4th arg).
    const call = vi.mocked(addPendingWrite).mock.calls[0];
    expect(call, "the write must be queued").toBeTruthy();
    expect(call![3]).toBe(sentKey);
  });

  it("a supplied key is used on attempt 1 and on the queued write", async () => {
    let sentKey: string | undefined;
    apiMock.mockImplementation(async (_path: string, init?: RequestInit) => {
      sentKey = (init?.headers as Record<string, string> | undefined)?.["Idempotency-Key"];
      throw new ApiError(500, "boom");
    });
    await sendOrQueue("PUT", "/api/nodes/n1/tags/t1", "{}", undefined, "caller-key-123");
    expect(sentKey).toBe("caller-key-123");
    expect(vi.mocked(addPendingWrite).mock.calls[0]![3]).toBe("caller-key-123");
  });

  it("a 4xx is rethrown and NOT queued (poison guard)", async () => {
    apiMock.mockRejectedValue(new ApiError(403, "forbidden"));
    await expect(sendOrQueue("PATCH", "/api/nodes/n1", "{}")).rejects.toBeInstanceOf(ApiError);
    expect(queue.rows).toEqual([]);
  });
});

beforeEach(() => { bindAccountStorage("unit-test-account", ""); });
