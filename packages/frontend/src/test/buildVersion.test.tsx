// "A newer version is out" (lib/buildVersion.ts): the server's X-Onden-Build
// against this page's build id, the reload that saves the open draft first, and
// the notice that offers it (components/DeviceNotices).

// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../lib/lazyWithReload", async (orig) => ({ ...(await orig<typeof import("../lib/lazyWithReload")>()), BUILD_ID: "build-a" }));

import { isNewerServerBuild, reloadForNewBuild, watchServerBuild } from "../lib/buildVersion";
import { apiFetch, setClientTooOldListener, setServerBuildListener } from "../lib/api";
import { chunkReloadPage, resetChunkReloadForTests, setBeforeChunkReload } from "../lib/lazyWithReload";
import { getAppState, resetAppState } from "../lib/appStore";
import { bindAccountStorage } from "../lib/accountStorage";
import { resetProtocolGate } from "../lib/protocolGate";
import DeviceNotices from "../components/DeviceNotices";
import { setLocalCopy, _resetLocalCopyForTests } from "../lib/localCopyState";

describe("isNewerServerBuild", () => {
  it("a different server build is newer; the same, none, or a local build is not", () => {
    expect(isNewerServerBuild("build-b", "build-a", null)).toBe(true);
    expect(isNewerServerBuild("build-a", "build-a", null)).toBe(false);
    expect(isNewerServerBuild(null, "build-a", null)).toBe(false);
    expect(isNewerServerBuild("build-b", "dev", null)).toBe(false);
  });

  it("does not ask again for the server build the person already reloaded for", () => {
    expect(isNewerServerBuild("build-b", "build-a", "build-b")).toBe(false);
    expect(isNewerServerBuild("build-c", "build-a", "build-b")).toBe(true);
  });
});

describe("watching the server's build on API responses", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    resetAppState();
    bindAccountStorage("u", "");
    watchServerBuild();
  });
  afterEach(() => { setServerBuildListener(null); setClientTooOldListener(null); resetProtocolGate(); vi.unstubAllGlobals(); });

  const respondWith = (build: string | null) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { headers: build ? { "X-Onden-Build": build } : {} })));

  it("flags a newer version when the server says another build", async () => {
    respondWith("build-b");
    await apiFetch("/api/health");
    expect(getAppState().newVersionAvailable).toBe(true);
  });

  it("offers the reload when the server refuses this page as too old (426), whatever the builds say", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"client_too_old"}', { status: 426, headers: { "X-Onden-Build": "build-a" } })));
    await apiFetch("/api/nodes/n", { method: "PATCH", body: "{}" });
    expect(getAppState().newVersionAvailable).toBe(true);
  });

  it("stays quiet for the same build, or a server that does not say", async () => {
    respondWith("build-a");
    await apiFetch("/api/health");
    respondWith(null);
    await apiFetch("/api/health");
    expect(getAppState().newVersionAvailable).toBe(false);
  });
});

describe("reloading for the new version", () => {
  let reload: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetChunkReloadForTests();
    window.sessionStorage.clear();
    reload = vi.spyOn(chunkReloadPage, "reload").mockImplementation(() => {});
  });
  afterEach(() => { reload.mockRestore(); resetChunkReloadForTests(); });

  it("saves the open draft first, then reloads", async () => {
    const order: string[] = [];
    setBeforeChunkReload(async () => { order.push("save"); return { kind: "safe", recovered: [] }; });
    reload.mockImplementation(() => { order.push("reload"); });
    expect((await reloadForNewBuild()).kind).toBe("safe");
    expect(order).toEqual(["save", "reload"]);
  });

  it("stays put when text lives only in memory, so it is not lost", async () => {
    setBeforeChunkReload(async () => ({ kind: "memory-only", notes: [{ title: "A", text: "words" }] }));
    expect((await reloadForNewBuild()).kind).toBe("memory-only");
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads with a notice after it when refused text sits in recovery", async () => {
    setBeforeChunkReload(async () => ({ kind: "safe", recovered: ["A"] }));
    expect((await reloadForNewBuild()).kind).toBe("safe");
    expect(reload).toHaveBeenCalledTimes(1);
    resetAppState();
    render(<DeviceNotices />);
    expect(getAppState().toasts.map((toast) => toast.message)).toEqual(["1 note(s) had changes that weren't saved. They are in the recovery panel."]);
    cleanup();
    resetAppState();
    render(<DeviceNotices />);
    expect(getAppState().toasts).toEqual([]); // told once
  });
});

describe("the notices", () => {
  let reload: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetAppState();
    _resetLocalCopyForTests();
    resetChunkReloadForTests();
    reload = vi.spyOn(chunkReloadPage, "reload").mockImplementation(() => {});
  });
  afterEach(() => { reload.mockRestore(); });

  it("shows nothing when all is well", () => {
    render(<DeviceNotices />);
    expect(document.body.textContent).toBe("");
  });

  it("says the local copy is temporarily unavailable, or that there is none — in plain words", () => {
    resetAppState({ localCopy: "restarting" });
    const { rerender } = render(<DeviceNotices />);
    expect(document.body.textContent).toBe("Local copy temporarily unavailable");
    act(() => { resetAppState({ localCopy: "none" }); });
    rerender(<DeviceNotices />);
    expect(document.body.textContent).toBe("This device has no offline copy");
    setLocalCopy("ok");
  });

  it("offers the reload, and reloads when clicked", async () => {
    resetAppState({ newVersionAvailable: true });
    render(<DeviceNotices />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "New version available — reload" })); });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  const clickReload = async () => {
    resetAppState({ newVersionAvailable: true });
    render(<DeviceNotices />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "New version available — reload" })); });
    expect(reload).not.toHaveBeenCalled();
    return getAppState().toasts;
  };

  it("names the note whose text lives only in memory, and offers to copy it", async () => {
    setBeforeChunkReload(async () => ({ kind: "memory-only", notes: [{ title: "Thesis", text: "my words" }] }));
    const [toast] = await clickReload();
    expect(toast.kind).toBe("error");
    expect(toast.message).toContain("Thesis");
    expect(toast.action?.label).toBe("Copy text");
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    await act(async () => { toast.action!.onClick(); });
    expect(writeText).toHaveBeenCalledWith("my words");
    vi.unstubAllGlobals();
  });

  it("an untitled note is named 'Untitled', never by id", async () => {
    setBeforeChunkReload(async () => ({ kind: "memory-only", notes: [{ title: "", text: "x" }] }));
    expect((await clickReload())[0].message).toContain("Untitled");
  });

  it("each other reason has its own words", async () => {
    setBeforeChunkReload(async () => ({ kind: "local-queue", waiting: 3 }));
    const queue = (await clickReload())[0].message;
    cleanup(); resetAppState();
    setBeforeChunkReload(async () => ({ kind: "typing" }));
    const typing = (await clickReload())[0].message;
    cleanup(); resetAppState();
    setBeforeChunkReload(async () => ({ kind: "unknown" }));
    const unknown = (await clickReload())[0].message;
    expect(new Set([queue, typing, unknown]).size).toBe(3);
  });
});
