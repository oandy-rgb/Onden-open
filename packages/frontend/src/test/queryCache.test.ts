import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/api", () => ({ api: vi.fn() }));

import { api } from "../lib/api";
import { dedupedGet, invalidateQueries, latestOnly } from "../lib/data/queryCache";

const apiMock = vi.mocked(api);

describe("queryCache", () => {
  beforeEach(() => {
    apiMock.mockReset();
    invalidateQueries();
  });

  it("dedupes concurrent GETs to the same path into one fetch", async () => {
    let release!: (v: unknown) => void;
    apiMock.mockReturnValue(new Promise((r) => { release = r; }));
    const p1 = dedupedGet("/api/events");
    const p2 = dedupedGet("/api/events");
    release({ ok: true });
    expect(await p1).toEqual({ ok: true });
    expect(await p2).toEqual({ ok: true });
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it("dedupes an in-flight GET even when the second call lands in a LATER millisecond", async () => {
    // Regression: ttl=0 used `Date.now() - at <= 0`, so two in-flight reads a few
    // ms apart each fired their own fetch. The entry only clears on settle, so a
    // surviving entry means in-flight → must dedupe regardless of elapsed ms.
    let release!: (v: unknown) => void;
    apiMock.mockReturnValue(new Promise((r) => { release = r; }));
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1000);
    const p1 = dedupedGet("/api/events");
    nowSpy.mockReturnValue(1005); // 5ms later, request still in flight
    const p2 = dedupedGet("/api/events");
    release({ ok: true });
    expect(await p1).toEqual({ ok: true });
    expect(await p2).toEqual({ ok: true });
    expect(apiMock).toHaveBeenCalledTimes(1);
    nowSpy.mockRestore();
  });

  it("with ttl, a follow-up read within the window reuses the response; after invalidate it refetches", async () => {
    apiMock.mockResolvedValue({ n: 1 });
    await dedupedGet("/api/events?since=0", { ttlMs: 60_000 });
    await dedupedGet("/api/events?since=0", { ttlMs: 60_000 });
    expect(apiMock).toHaveBeenCalledTimes(1);

    invalidateQueries("/api/events");
    await dedupedGet("/api/events?since=0", { ttlMs: 60_000 });
    expect(apiMock).toHaveBeenCalledTimes(2);
  });

  it("failures are never cached — the next call retries", async () => {
    apiMock.mockRejectedValueOnce(new Error("boom"));
    await expect(dedupedGet("/api/x")).rejects.toThrow("boom");
    apiMock.mockResolvedValueOnce("fine");
    expect(await dedupedGet("/api/x")).toBe("fine");
    expect(apiMock).toHaveBeenCalledTimes(2);
  });

  it("different paths never share a fetch", async () => {
    apiMock.mockResolvedValue("v");
    await Promise.all([dedupedGet("/api/a"), dedupedGet("/api/b")]);
    expect(apiMock).toHaveBeenCalledTimes(2);
  });
});

describe("latestOnly", () => {
  it("only the newest begin() is current, whatever order the answers come in", () => {
    const read = latestOnly();
    const first = read.begin();
    expect(first()).toBe(true);
    const second = read.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });
});
