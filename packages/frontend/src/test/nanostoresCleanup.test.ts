import { describe, expect, it, vi } from "vitest";
import { atom, onMount } from "nanostores";
import { flushNanostoresUnmountTimers } from "./helpers/nanostoresCleanup";

describe("nanostores deferred unmount (setup runs it before jsdom is torn down)", () => {
  it("flush runs a store's teardown at once instead of 1s later", () => {
    const teardown = vi.fn();
    const $store = atom(0);
    onMount($store, () => teardown);
    $store.listen(() => {})(); // subscribe, then unsubscribe: unmount is now scheduled
    expect(teardown).not.toHaveBeenCalled();
    expect(flushNanostoresUnmountTimers()).toBe(1);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(flushNanostoresUnmountTimers()).toBe(0); // nothing left to fire later
  });
});
