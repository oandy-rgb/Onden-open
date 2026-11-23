// Sidebar pins go through one writer: an existing pin counts as success and
// is not reported, a refusal is reported once and rethrown, and an unpin
// rides the offline queue.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const submitWrite = vi.fn();
vi.mock("../lib/data/writeQueue", async (original) => ({
  ...await original<typeof import("../lib/data/writeQueue")>(),
  submitWrite: (...args: unknown[]) => submitWrite(...args),
}));

import { pinPointer, unpinPointer } from "../lib/data/pointerWriter";
import { ApiError } from "../lib/api";
import { getAppState, resetAppState } from "../lib/appStore";

const errors = () => getAppState().toasts.filter((toast) => toast.kind === "error");
function respond(status: number, body: unknown = {}) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

beforeEach(() => { resetAppState(); submitWrite.mockReset().mockResolvedValue({ status: "synced", value: undefined }); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("pointer writer", () => {
  it("creates a pin", async () => {
    respond(201, { id: "p1" });
    await expect(pinPointer("t1", "parent-1")).resolves.toBe("created");
    expect(errors()).toHaveLength(0);
  });

  it("treats an existing pin (409) as the requested state, without an error", async () => {
    respond(409, { error: "pointer already exists at this location" });
    await expect(pinPointer("t1", "parent-1")).resolves.toBe("exists");
    expect(errors()).toHaveLength(0);
  });

  it("reports a pin under a tag (409 parent_kind_mismatch) as a refusal, not an existing pin (D101)", async () => {
    respond(409, { error: "parent_kind_mismatch" });
    await expect(pinPointer("t1", "tag-1")).rejects.toBeInstanceOf(ApiError);
    expect(errors()).toHaveLength(1);
  });

  it("reports a refused pin once and rethrows", async () => {
    respond(403, { error: "forbidden" });
    await expect(pinPointer("t1", "parent-1")).rejects.toBeInstanceOf(ApiError);
    expect(errors()).toHaveLength(1);
  });

  it("unpins through the offline queue and reports a refusal", async () => {
    await unpinPointer("p1");
    expect(submitWrite.mock.calls[0]![0]).toMatchObject({ method: "DELETE", path: "/api/pointers/p1", body: null });
    submitWrite.mockRejectedValueOnce(new ApiError(403, JSON.stringify({ error: "forbidden" })));
    await expect(unpinPointer("p2")).rejects.toBeInstanceOf(ApiError);
    expect(errors()).toHaveLength(1);
  });
});
