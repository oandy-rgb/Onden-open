// D92: the native app goes through server setup, then the same LoginGate and
// account binding as the web. Against a server without the native bypass
// (production) every request answers 401: the sign-in form shows, not a blank
// workspace or a 401 loop.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.stubEnv("VITE_NATIVE", "true");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

// Each test imports the whole app graph afresh (resetModules): ~4 s alone, more
// when other files run first, so the 5 s default timed out and the late render
// then leaked into the next test.
const COLD_IMPORT_MS = 30_000;

describe("native entry", () => {
  it("shows the sign-in form against a server that answers 401", async () => {
    localStorage.setItem("onden_api_base", "https://prod.example");
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetcher);
    const { default: AppRoot } = await import("../AppRoot");
    render(<AppRoot />);
    expect(await screen.findByRole("button", { name: "Sign in" }, { timeout: 5000 })).toBeTruthy();
    // Only the sign-in check (and the provider list) was asked: the workspace
    // did not mount, so no request went out to loop on 401.
    const paths = fetcher.mock.calls.map(([url]) => new URL(url instanceof Request ? url.url : String(url)).pathname);
    expect(paths.every((p) => p.startsWith("/api/auth/"))).toBe(true);
    const { boundAccountId } = await import("../lib/accountStorage");
    expect(boundAccountId()).toBeNull();
  }, COLD_IMPORT_MS);

  it("asks for the server first when none is saved", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const { default: AppRoot } = await import("../AppRoot");
    render(<AppRoot />);
    expect(screen.getByPlaceholderText("https://your-server.com")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Advanced / connect to a different server" })).toBeNull();
  }, COLD_IMPORT_MS);
});
