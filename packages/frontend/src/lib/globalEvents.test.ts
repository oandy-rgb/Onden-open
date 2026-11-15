import { describe, expect, it, vi } from "vitest";
import { emitWindowEvent, onDocument, onWindow } from "./globalEvents";

describe("globalEvents", () => {
  it("onWindow listens until the returned stop is called", () => {
    const seen = vi.fn();
    const stop = onWindow("onden-test", seen);
    emitWindowEvent("onden-test");
    stop();
    emitWindowEvent("onden-test");
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("emitWindowEvent carries detail", () => {
    let detail: unknown;
    const stop = onWindow("onden-detail", (e) => { detail = (e as CustomEvent).detail; });
    emitWindowEvent("onden-detail", "abc");
    stop();
    expect(detail).toBe("abc");
  });

  it("removes a capture listener with the same capture flag", () => {
    const seen = vi.fn();
    const stop = onDocument("keydown", seen, true);
    document.dispatchEvent(new KeyboardEvent("keydown"));
    stop();
    document.dispatchEvent(new KeyboardEvent("keydown"));
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
