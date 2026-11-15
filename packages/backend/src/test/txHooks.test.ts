import { describe, it, expect, vi } from "vitest";
import { afterCommit, afterRollback, withTxHookScope } from "../spine/txHooks.js";

describe("transaction outcome hooks", () => {
  it("defers released children's success until the root outcome, in registration order", async () => {
    const calls: string[] = [];
    await withTxHookScope(async () => {
      afterCommit(() => { calls.push("parent before"); });
      await withTxHookScope(async () => {
        afterCommit(() => { calls.push("child"); });
        afterRollback(() => { calls.push("invalidated child"); });
      });
      afterCommit(() => { calls.push("parent after"); });
      expect(calls).toEqual([]);
    });
    expect(calls).toEqual(["parent before", "child", "parent after"]);
  });

  it("invalidates released descendants on outer failure, in reverse order", async () => {
    const calls: string[] = [];
    const failure = new Error("outer rollback");
    await expect(withTxHookScope(async () => {
      afterRollback(() => { calls.push("parent before"); });
      await withTxHookScope(async () => {
        afterCommit(() => { calls.push("must not notify"); });
        afterRollback(() => { calls.push("child"); });
      });
      afterRollback(() => { calls.push("parent after"); });
      throw failure;
    })).rejects.toBe(failure);
    expect(calls).toEqual(["parent after", "child", "parent before"]);
  });

  it("a failed child invalidates only itself and does not leave hooks in the parent", async () => {
    const calls: string[] = [];
    await withTxHookScope(async () => {
      afterCommit(() => { calls.push("parent committed"); });
      afterRollback(() => { calls.push("parent invalidated"); });
      await expect(withTxHookScope(async () => {
        afterCommit(() => { calls.push("child committed"); });
        afterRollback(() => { calls.push("child invalidated"); });
        throw new Error("child rejected");
      })).rejects.toThrow("child rejected");
      expect(calls).toEqual(["child invalidated"]);
    });
    expect(calls).toEqual(["child invalidated", "parent committed"]);
  });

  it("autocommit notification remains immediate, with no rollback to subscribe to", () => {
    const notified = vi.fn(), invalidated = vi.fn();
    afterCommit(notified);
    afterRollback(invalidated);
    expect(notified).toHaveBeenCalledOnce();
    expect(invalidated).not.toHaveBeenCalled();
  });

  it("a notification exception cannot change a confirmed success", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {}), next = vi.fn();
    try {
      await expect(withTxHookScope(async () => {
        afterCommit(() => { throw new Error("notification failed"); });
        afterCommit(next);
        return "committed";
      })).resolves.toBe("committed");
      expect(next).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledOnce();
    } finally { log.mockRestore(); }
  });

  it("an invalidation exception cannot mask the failure or prevent other invalidations", async () => {
    const failure = new Error("original transaction error");
    const log = vi.spyOn(console, "error").mockImplementation(() => {}), next = vi.fn();
    try {
      await expect(withTxHookScope(async () => {
        afterRollback(next);
        afterRollback(() => { throw new Error("invalidation failed"); });
        throw failure;
      })).rejects.toBe(failure);
      expect(next).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledOnce();
    } finally { log.mockRestore(); }
  });
});
