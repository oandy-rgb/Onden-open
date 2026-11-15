// GAP-253: when Postgres restarts, idle pooled connections are terminated and
// the pool emits 'error'. Without a listener Node throws it as an uncaught
// exception and the backend exits. The pool must swallow-and-log it.

import { describe, it, expect, vi } from "vitest";
import { pool } from "../db.js";

describe("pool idle-connection error", () => {
  it("has an error listener, so a dropped idle connection does not crash the process", () => {
    expect(pool.listenerCount("error")).toBeGreaterThan(0);
  });

  it("logs instead of throwing", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const err = new Error("terminating connection due to administrator command");
      expect(() => pool.emit("error", err, undefined as never)).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});
