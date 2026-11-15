import { act } from "@testing-library/react";
import { vi } from "vitest";

// The browser's CloseWatcher, faked for jsdom (it has none): `requestClose()` is what Android's Back (or Esc)
// asks of the newest watcher. Install in beforeEach with `installFakeCloseWatcher()`; vi.unstubAllGlobals() in afterEach.

export class FakeCloseWatcher {
  static all: FakeCloseWatcher[] = [];
  onclose: (() => void) | null = null;
  destroyed = false;
  constructor() { FakeCloseWatcher.all.push(this); }
  destroy() { this.destroyed = true; }
}

export const liveWatchers = (): FakeCloseWatcher[] => FakeCloseWatcher.all.filter((w) => !w.destroyed);

export function installFakeCloseWatcher(): void {
  FakeCloseWatcher.all = [];
  vi.stubGlobal("CloseWatcher", FakeCloseWatcher);
}

/** Back: the newest watcher closes (false when there is none, where the browser would go back in history). */
export function requestClose(): boolean {
  const top = liveWatchers().pop();
  if (!top) return false;
  top.destroyed = true;
  act(() => { top.onclose?.(); });
  return true;
}
