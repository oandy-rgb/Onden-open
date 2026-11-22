import { describe, expect, it, vi } from "vitest";
import { createDomainContext } from "./domainWriters";
import { loadedOnFirstUse } from "./loadedOnFirstUse";
import { blockChildWriterFor, blockLinkWriterFor, historyWriterFor } from "./onlineWriters";
import { makeBlockChildWriter } from "./blockChildWriter";
import { makeBlockLinkWriter } from "./blockLinkWriter";
import { makeNoteHistoryWriter } from "./noteHistoryWriter";

// A method added to a writer but not to its list in onlineWriters.ts would be missing from the
// lazy copy the app uses: the lists must name exactly the real writer's methods.
describe("onlineWriters method lists", () => {
  const ctx = createDomainContext(() => {});
  const cases: Array<[string, object, object]> = [
    ["history", historyWriterFor(ctx), makeNoteHistoryWriter(ctx)],
    ["block child", blockChildWriterFor(ctx), makeBlockChildWriter(ctx)],
    ["block link", blockLinkWriterFor(ctx), makeBlockLinkWriter(ctx)],
  ];
  it.each(cases)("%s writer", (_name, lazy, real) => {
    expect(Object.keys(lazy).sort()).toEqual(Object.keys(real).sort());
  });
});

describe("loadedOnFirstUse", () => {
  it("loads once, on the first call, and passes arguments and the answer through", async () => {
    const add = vi.fn(async (a: number, b: number) => a + b);
    const load = vi.fn(async () => ({ add }));
    const api = loadedOnFirstUse(load, ["add"]);
    expect(load).not.toHaveBeenCalled();
    expect(await api.add(1, 2)).toBe(3);
    expect(await api.add(2, 3)).toBe(5);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not remember a failed load: the next call tries again", async () => {
    const load = vi.fn<() => Promise<{ ping: () => Promise<string> }>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ ping: async () => "pong" });
    const api = loadedOnFirstUse(load, ["ping"]);
    await expect(api.ping()).rejects.toThrow("offline");
    await expect(api.ping()).resolves.toBe("pong");
    expect(load).toHaveBeenCalledTimes(2);
  });
});
