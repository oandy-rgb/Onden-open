// The request-context interface (requestContext.ts) is all the backend uses from AsyncLocalStorage:
// run() and getStore(). These tests state what a provider must do and run them over BOTH providers,
// so the serial-stack one a browser host would install is proven to be enough for that contract.
// The last block pins down where it is NOT enough (docs/architecture/portable-backend.md).
import { describe, expect, it } from "vitest";
import { createNodeContextProvider, createSerialContextProvider, type ContextProvider } from "../requestContext.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe.each<[string, () => ContextProvider]>([
  ["async-local-storage", createNodeContextProvider],
  ["serial-stack", createSerialContextProvider],
])("context provider contract: %s", (_name, make) => {
  it("has no value outside run()", () => {
    expect(make().createSlot<string>().getStore()).toBeUndefined();
  });

  it("carries the value across awaits, microtasks and timers inside run()", async () => {
    const slot = make().createSlot<string>();
    const seen = await slot.run("tx-1", async () => {
      const a = slot.getStore();
      await Promise.resolve();
      await tick();
      const b = slot.getStore();
      const c = await (async () => { await tick(); return slot.getStore(); })();
      return [a, b, c];
    });
    expect(seen).toEqual(["tx-1", "tx-1", "tx-1"]);
    expect(slot.getStore()).toBeUndefined();
  });

  it("nests: the inner value shadows, the outer returns after", async () => {
    const slot = make().createSlot<string>();
    const trail: Array<string | undefined> = [];
    await slot.run("outer", async () => {
      trail.push(slot.getStore());
      await slot.run("inner", async () => { await tick(); trail.push(slot.getStore()); });
      trail.push(slot.getStore());
    });
    expect(trail).toEqual(["outer", "inner", "outer"]);
  });

  it("restores the outer value when the inner run throws, and rethrows", async () => {
    const slot = make().createSlot<string>();
    await slot.run("outer", async () => {
      await expect(slot.run("inner", async () => { await tick(); throw new Error("boom"); })).rejects.toThrow("boom");
      expect(slot.getStore()).toBe("outer");
    });
    expect(() => slot.run("sync", () => { throw new Error("sync boom"); })).toThrow("sync boom");
    expect(slot.getStore()).toBeUndefined();
  });

  it("returns what a synchronous function returns", () => {
    const slot = make().createSlot<number>();
    expect(slot.run(7, () => slot.getStore()! * 2)).toBe(14);
    expect(slot.getStore()).toBeUndefined();
  });

  it("keeps slots apart", async () => {
    const provider = make();
    const a = provider.createSlot<string>();
    const b = provider.createSlot<string>();
    await a.run("only-a", async () => {
      await tick();
      expect(a.getStore()).toBe("only-a");
      expect(b.getStore()).toBeUndefined();
    });
  });

  it("serial flows (one request at a time, the browser host's shape) never see each other", async () => {
    const slot = make().createSlot<string>();
    const seen: Array<string | undefined> = [];
    for (const id of ["req-1", "req-2", "req-3"]) {
      await slot.run(id, async () => { await tick(); seen.push(slot.getStore()); });
      seen.push(slot.getStore());
    }
    expect(seen).toEqual(["req-1", undefined, "req-2", undefined, "req-3", undefined]);
  });
});

describe("what only AsyncLocalStorage gives (the limits of the serial stack)", () => {
  it("overlapping flows keep their own value on AsyncLocalStorage", async () => {
    const slot = createNodeContextProvider().createSlot<string>();
    const run = (id: string, delay: number) => slot.run(id, async () => { await new Promise((r) => setTimeout(r, delay)); return slot.getStore(); });
    expect(await Promise.all([run("a", 15), run("b", 1)])).toEqual(["a", "b"]);
  });

  it("overlapping flows DO see each other's value on the serial stack: the host must not overlap flows", async () => {
    const slot = createSerialContextProvider().createSlot<string>();
    const run = (id: string, delay: number) => slot.run(id, async () => { await new Promise((r) => setTimeout(r, delay)); return slot.getStore(); });
    const [a, b] = await Promise.all([run("a", 1), run("b", 30)]);
    expect(b).toBe("b");
    expect(a).toBe("b"); // flow "a" resumed while "b" was innermost: wrong transaction in real use
  });

  it("a timer started inside run() sees the context on AsyncLocalStorage, and on the stack only while the run is open", async () => {
    const node = createNodeContextProvider().createSlot<string>();
    const stack = createSerialContextProvider().createSlot<string>();
    const lateNode = new Promise<string | undefined>((resolve) => node.run("tx", () => { setTimeout(() => resolve(node.getStore()), 5); }));
    const lateStack = new Promise<string | undefined>((resolve) => stack.run("tx", () => { setTimeout(() => resolve(stack.getStore()), 5); }));
    expect(await lateNode).toBe("tx");
    expect(await lateStack).toBeUndefined(); // work that outlives its request (outbox, setTimeout) runs with no context
  });
});
