import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../lib/api";

// A tag's functions go through the one online operation (onlineWrite.ts): never queued, and a retry
// reuses its key (W6).
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn() }));
vi.mock("../lib/localDb", () => ({ getPendingWrites: vi.fn(async () => []) }));
const { makeTagConfigWriter } = await import("../lib/data/tagConfigWriter");
const { createDomainContext } = await import("../lib/data/domainWriters");

beforeEach(() => vi.mocked(api).mockReset());
const writer = (online = true) => makeTagConfigWriter(createDomainContext(vi.fn(), online));

describe("tag function writer", () => {
  it("does not submit while offline", async () => {
    await expect(writer(false).addFunction("tag", "review")).rejects.toThrow(/Connect/);
    expect(api).not.toHaveBeenCalled();
  });

  it("retries an unconfirmed add with the same key and only confirms a server reply", async () => {
    const w = writer();
    vi.mocked(api).mockRejectedValueOnce(new ApiError(503, "unavailable"))
      .mockResolvedValueOnce({ id: "tag", function_id: "review", ref_id: "ref", added: true });
    await expect(w.addFunction("tag", "review")).rejects.toThrow();
    expect(await w.addFunction("tag", "review")).toMatchObject({ status: "saved", value: { id: "tag", function_id: "review" } });
    const keys = vi.mocked(api).mock.calls.map(([, init]) => new Headers(init?.headers).get("Idempotency-Key"));
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it("adds with a PUT and removes with a DELETE of the function's own path", async () => {
    vi.mocked(api).mockResolvedValue({ id: "tag", function_id: "review" });
    await writer().addFunction("tag", "review");
    await writer().removeFunction("tag", "review");
    expect(vi.mocked(api).mock.calls.map(([path, init]) => [path, init?.method])).toEqual([
      ["/api/tags/tag/functions/review", "PUT"], ["/api/tags/tag/functions/review", "DELETE"],
    ]);
  });
});
