// @vitest-environment jsdom
// The boot watchdog: no loading screen between opening the app and the workspace spins forever. Real components, real
// protocol gate and reload guard; only the network edge (lib/api) and the local database are faked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Suspense } from "react";
import { render, screen, act, cleanup } from "@testing-library/react";
import { CLIENT_PROTOCOL } from "@onden/markdown";

vi.mock("../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/api")>();
  return { ...mod, api: vi.fn(async () => ({})), apiFetch: vi.fn(async () => new Response("{}")) };
});
vi.mock("../lib/localDb", () => ({
  getPendingWrites: vi.fn(async () => []),
  flushLocalDbSync: vi.fn(async () => {}),
}));

import BootScreen from "../components/BootScreen";
import { lazyWithReload, chunkReloadPage, resetChunkReloadForTests } from "../lib/lazyWithReload";
import { noteServerProtocol, resetProtocolGate } from "../lib/protocolGate";
import { resetAppState } from "../lib/appStore";

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  resetChunkReloadForTests();
  resetProtocolGate();
  resetAppState();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** BootWatchdog's limit: about 12 seconds without the screen changing. */
const BOOT_STALL_MS = 12_000;
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const reloadButton = () => screen.queryByRole("button", { name: "Reload page" });

describe("boot watchdog", () => {
  it("shows no card while boot is moving (under the limit)", async () => {
    render(<BootScreen />);
    await advance(BOOT_STALL_MS - 1);
    expect(screen.queryByText("This is taking longer than expected")).toBeNull();
    expect(reloadButton()).toBeNull();
  });

  it("a boot that never finishes (bootstrap never answers) ends in a reload card whose button reloads", async () => {
    const reload = vi.spyOn(chunkReloadPage, "reload").mockImplementation(() => {});
    render(<BootScreen />);
    await advance(BOOT_STALL_MS);
    expect(screen.getByText("This is taking longer than expected")).toBeTruthy();
    await act(async () => { reloadButton()!.click(); await vi.advanceTimersByTimeAsync(0); });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("a code chunk whose download never ends ends in the same card", async () => {
    const Never = lazyWithReload(() => new Promise<{ default: () => null }>(() => {}));
    render(<Suspense fallback={<BootScreen />}><Never /></Suspense>);
    await advance(BOOT_STALL_MS);
    expect(reloadButton()).toBeTruthy();
  });

  it("a newer protocol heard during boot reloads once by itself; the second time only offers the button", async () => {
    const reload = vi.spyOn(chunkReloadPage, "reload").mockImplementation(() => {});
    render(<BootScreen />);
    await act(async () => { noteServerProtocol(String(CLIENT_PROTOCOL + 1)); await vi.advanceTimersByTimeAsync(0); });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByText("A new version is out. Reloading…")).toBeTruthy();
    expect(reloadButton()).toBeNull();

    // The reloaded page is still too old (a frontend that was not rebuilt): no second automatic reload.
    cleanup();
    resetChunkReloadForTests();
    resetProtocolGate();
    render(<BootScreen />);
    await act(async () => { noteServerProtocol(String(CLIENT_PROTOCOL + 1)); await vi.advanceTimersByTimeAsync(0); });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByText("A new version is out")).toBeTruthy();
    expect(reloadButton()).toBeTruthy();
  });
});
