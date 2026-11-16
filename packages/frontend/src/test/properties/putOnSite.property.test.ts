// 「放回網站」 (modules/website/putOnSite.ts): whatever the write's timing and
// outcome, the promise settles only after the write settled, says true only for
// an accepted write, and a failed write is reported once (scan 13 中等 6: the
// preview used to re-ask the server before the write had gone out).
import { describe, it, expect, vi, beforeEach } from "vitest";
import fc from "fast-check";

const h = vi.hoisted(() => ({ log: [] as string[], toasts: [] as string[], settle: null as null | ((ok: boolean) => void), calls: [] as string[] }));
vi.mock("../../lib/data/domainWriters", async (original) => {
  const pending = (name: string) => (..._args: unknown[]) => {
    h.calls.push(name);
    return new Promise<boolean>((resolve, reject) => { h.settle = (ok) => { h.log.push("write settled"); if (ok) resolve(true); else reject(new Error("write failed")); }; });
  };
  return { ...await original<typeof import("../../lib/data/domainWriters")>(), propertyWriter: { set: pending("set"), remove: pending("remove") } };
});
vi.mock("../../lib/appStore", async (original) => ({ ...await original<typeof import("../../lib/appStore")>(), addToast: (m: string) => { h.toasts.push(m); } }));

import { putOnSite } from "../../modules/website/putOnSite";

beforeEach(() => { h.log = []; h.toasts = []; h.settle = null; h.calls = []; });

describe("putOnSite", () => {
  it("fixed: a note kept off is put back by removing the flag, and the result waits for the write", async () => {
    const done = putOnSite({ id: "n", attrs: { _published: "false" } }).then((ok) => { h.log.push(`result ${ok}`); return ok; });
    await Promise.resolve(); await Promise.resolve();
    expect(h.calls).toEqual(["remove"]);
    expect(h.log).toEqual([]); // not resolved before the write
    h.settle!(true);
    expect(await done).toBe(true);
    expect(h.log).toEqual(["write settled", "result true"]);
  });

  it("fixed: a rejected write resolves false and is reported", async () => {
    const done = putOnSite({ id: "n" });
    await Promise.resolve();
    h.settle!(false);
    expect(await done).toBe(false);
    expect(h.calls).toEqual(["set"]);
    expect(h.toasts).toHaveLength(1);
  });

  it("any attrs, delay and outcome: settles after the write, true iff accepted, one report per failure", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom<Record<string, string> | undefined>(undefined, {}, { _published: "false" }, { _published: "true" }),
      fc.integer({ min: 0, max: 5 }), fc.boolean(),
      async (attrs, ticks, ok) => {
        h.log = []; h.toasts = []; h.calls = [];
        const done = putOnSite({ id: "n", attrs }).then((r) => { h.log.push("result"); return r; });
        for (let i = 0; i < ticks; i++) await Promise.resolve();
        expect(h.log).toEqual([]);
        expect(h.calls).toEqual([attrs?._published === "false" ? "remove" : "set"]);
        h.settle!(ok);
        expect(await done).toBe(ok);
        expect(h.log).toEqual(["write settled", "result"]);
        expect(h.toasts).toHaveLength(ok ? 0 : 1);
      }), { numRuns: process.env.PROPS_RUNS ? Number(process.env.PROPS_RUNS) : 50 });
  });
});
