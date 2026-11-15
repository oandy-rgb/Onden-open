import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  q: vi.fn(),
  inTransaction: vi.fn(() => true),
}));
vi.mock("../db.js", () => db);

import { IdempotentReplay, withIdempotencyClaim, withIdempotencyKey } from "../spine/idempotency.js";
import { withTxHookScope } from "../spine/txHooks.js";

beforeEach(() => {
  db.q.mockReset().mockResolvedValue({ rows: [{ key: "key" }], rowCount: 1 });
  db.inTransaction.mockReturnValue(true);
});

const operation = (work: () => Promise<unknown> = async () => "saved", explicitKey?: string) =>
  withIdempotencyClaim("workspace", (claim) => withTxHookScope(async () => {
    await claim();
    return work();
  }), explicitKey);

describe("shared transactional idempotency claim", () => {
  it("does no database work when no key is supplied", async () => {
    db.inTransaction.mockReturnValue(false);
    expect(await operation()).toBe("saved");
    expect(db.q).not.toHaveBeenCalled();
  });

  it("cannot persist an unguarded claim outside a transaction", async () => {
    db.inTransaction.mockReturnValue(false);
    await expect(withIdempotencyKey("request-key", () => operation())).rejects.toThrow("requires a transaction");
    expect(db.q).not.toHaveBeenCalled();
  });

  it("a committed cross-request replay rejects before running the operation again", async () => {
    const work = vi.fn(async () => "copied");
    expect(await withIdempotencyKey("copy-key", () => operation(work))).toBe("copied");
    db.q.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(withIdempotencyKey("copy-key", () => operation(work))).rejects.toBeInstanceOf(IdempotentReplay);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("sequential writes and nested restore children share the request claim", async () => {
    await withIdempotencyKey("request-key", async () => {
      await operation(async () => {
        await operation();
        await operation();
      });
      await operation();
    });
    expect(db.q).toHaveBeenCalledTimes(1);
  });

  it("a domain or savepoint rejection releases a newly acquired ambient claim for retry", async () => {
    const failure = new Error("rollback to savepoint");
    await withIdempotencyKey("retry-key", async () => {
      await expect(operation(async () => { throw failure; })).rejects.toBe(failure);
      expect(await operation()).toBe("saved");
    });
    expect(db.q).toHaveBeenCalledTimes(2);
  });

  it("COMMIT failure after the body returned still releases the claim", async () => {
    const failure = new Error("COMMIT failed");
    let bodyFinished = false;
    // Model the owner scope through its final SQL outcome, not just apply().
    const failedTransaction = (fn: () => Promise<void>) => withTxHookScope(async () => {
      await fn();
      bodyFinished = true;
      throw failure;
    });
    await withIdempotencyKey("commit-retry", async () => {
      await expect(withIdempotencyClaim("workspace", (claim) => failedTransaction(claim))).rejects.toBe(failure);
      expect(bodyFinished).toBe(true);
      expect(await operation()).toBe("saved");
    });
    expect(db.q).toHaveBeenCalledTimes(2);
  });

  it("a failed child savepoint cannot release its successful parent's claim", async () => {
    await withIdempotencyKey("parent-key", () => operation(async () => {
      await expect(operation(async () => { throw new Error("child rejected"); })).rejects.toThrow("child rejected");
      await operation();
    }));
    expect(db.q).toHaveBeenCalledTimes(1);
  });

  it("a parent failure releases its claim even after children completed", async () => {
    await withIdempotencyKey("cascade-key", async () => {
      await expect(operation(async () => {
        await operation();
        throw new Error("root conflict");
      })).rejects.toThrow("root conflict");
      await operation();
    });
    expect(db.q).toHaveBeenCalledTimes(2);
  });

  it("an explicit key overrides the request key without consuming the ambient claim", async () => {
    await withIdempotencyKey("request-key", async () => {
      await operation(undefined, "background-key");
      await operation();
    });
    expect(db.q.mock.calls.map((call) => call[1])).toEqual([
      ["background-key", "workspace"],
      ["request-key", "workspace"],
    ]);
  });

  it("a caught exception without rollback cannot invalidate the existing claim", async () => {
    await withIdempotencyKey("still-present", () => withTxHookScope(async () => {
      await expect(withIdempotencyClaim("workspace", async claim => {
        await claim();
        throw new Error("caught without a savepoint");
      })).rejects.toThrow("caught without a savepoint");
      await operation();
    }));
    expect(db.q).toHaveBeenCalledOnce();
  });
});
