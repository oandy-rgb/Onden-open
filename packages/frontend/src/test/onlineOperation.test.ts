import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../lib/api";

// The one online operation keeps a failed attempt's Idempotency-Key only for a
// retry of that same decision. A different decision on the resource, or any
// other write in between, makes the same request a new intent with a new key —
// otherwise the server answers {deduped:true} and nothing is applied.
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn() }));
vi.mock("../lib/localDb", () => ({ getPendingWrites: vi.fn(async () => []) }));
const { makeOnlineOperation } = await import("../lib/data/onlineWrite");
const { createDomainContext } = await import("../lib/data/domainWriters");
const { noteWriteStarted } = await import("../lib/data/writeQueue");

beforeEach(() => vi.mocked(api).mockReset());
const unavailable = () => new ApiError(503, "unavailable");
const keys = () => vi.mocked(api).mock.calls.map(([, init]) => new Headers(init?.headers).get("Idempotency-Key"));
const setImported = (operation: ReturnType<typeof makeOnlineOperation>, imported: boolean) =>
  operation("workspace:modules", "Connect", (submit) => submit("/api/workspace/modules/review", JSON.stringify({ imported }), "PUT"));

describe("online operation keys", () => {
  it("a retry of the same decision reuses its key", async () => {
    const operation = makeOnlineOperation(createDomainContext(vi.fn(), true));
    vi.mocked(api).mockRejectedValueOnce(unavailable()).mockResolvedValueOnce({ ok: true });
    await expect(setImported(operation, true)).rejects.toThrow();
    await setImported(operation, true);
    expect(keys()[1]).toBe(keys()[0]);
  });

  it("importing again after a removal sends a new key", async () => {
    const operation = makeOnlineOperation(createDomainContext(vi.fn(), true));
    // The first import was applied but its reply was lost; the removal lands.
    vi.mocked(api).mockRejectedValueOnce(unavailable()).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: true });
    await expect(setImported(operation, true)).rejects.toThrow();
    await setImported(operation, false);
    await setImported(operation, true);
    const [first, removal, again] = keys();
    expect(again).not.toBe(first);
    expect(again).not.toBe(removal);
  });

  it("a failed removal is replaced by the next decision too", async () => {
    const operation = makeOnlineOperation(createDomainContext(vi.fn(), true));
    vi.mocked(api).mockRejectedValueOnce(unavailable()).mockRejectedValueOnce(unavailable()).mockResolvedValueOnce({ ok: true });
    await expect(setImported(operation, true)).rejects.toThrow();
    await expect(setImported(operation, false)).rejects.toThrow();
    await setImported(operation, true);
    expect(new Set(keys()).size).toBe(3);
  });

  it("another write in between (a tag deleted after a pack install) makes the same request new", async () => {
    const operation = makeOnlineOperation(createDomainContext(vi.fn(), true));
    const install = () => operation("tag-packs", "Connect", (submit) => submit("/api/tag-packs/research/install"));
    vi.mocked(api).mockRejectedValueOnce(unavailable()).mockResolvedValueOnce({ ok: true });
    await expect(install()).rejects.toThrow();
    noteWriteStarted();
    await install();
    expect(keys()[1]).not.toBe(keys()[0]);
  });

  it("a retry resends only the steps after the acknowledged ones, with their keys", async () => {
    const operation = makeOnlineOperation(createDomainContext(vi.fn(), true));
    const run = () => operation("node:a", "Connect", async (submit) => {
      await submit("/api/nodes", JSON.stringify({ id: "child" }));
      return submit("/api/nodes/a", JSON.stringify({ markdown: "[[child]]" }), "PATCH");
    });
    vi.mocked(api).mockResolvedValueOnce({ id: "child" }).mockRejectedValueOnce(unavailable()).mockResolvedValueOnce({ id: "a" });
    await expect(run()).rejects.toThrow();
    await expect(run()).resolves.toEqual({ id: "a" });
    const paths = vi.mocked(api).mock.calls.map(([path]) => path);
    expect(paths).toEqual(["/api/nodes", "/api/nodes/a", "/api/nodes/a"]);
    expect(keys()[2]).toBe(keys()[1]);
  });
});
