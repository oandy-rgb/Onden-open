// D92: one checked setApiBase for ServerSetup and Settings › Backend URL. It
// refuses a server that is not Onden (saving nothing) and reloads onto a
// changed server, whose account-scoped store and queue are its own.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => { vi.resetModules(); localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("setApiBase", () => {
  it.each([
    ["an HTML page", () => new Response("<!doctype html><title>Not Onden</title>", { headers: { "content-type": "text/html" } }), "This address is not an Onden server."],
    ["another JSON API", () => json({ ok: true }), "This address is not an Onden server."],
    ["a 404", () => json({ error: "not found" }, 404), "This address is not an Onden server."],
    ["no answer", () => { throw new TypeError("Failed to fetch"); }, "Unable to connect. Check URL and network."],
  ])("refuses %s and saves nothing", async (_name, reply, error) => {
    const { setApiBase, getApiBase } = await import("../lib/api");
    const fetchImpl = vi.fn(async () => reply());
    const reload = vi.fn();
    await expect(setApiBase("https://other.example/", { fetchImpl, reload })).resolves.toEqual({ ok: false, error });
    expect(fetchImpl).toHaveBeenCalledWith("https://other.example/api/auth/providers", expect.anything());
    expect(getApiBase()).toBe("");
    expect(reload).not.toHaveBeenCalled();
  });

  it("saves an Onden server and reloads onto it", async () => {
    const { setApiBase, getApiBase } = await import("../lib/api");
    const reload = vi.fn();
    const result = await setApiBase(" https://other.example/ ", { fetchImpl: async () => json({ providers: ["github"] }), reload });
    expect(result).toEqual({ ok: true, changed: true });
    expect(getApiBase()).toBe("https://other.example");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("the same server is checked but not reloaded", async () => {
    const { setApiBase } = await import("../lib/api");
    const reload = vi.fn();
    await expect(setApiBase("", { fetchImpl: async () => json({ providers: [] }), reload })).resolves.toEqual({ ok: true, changed: false });
    expect(reload).not.toHaveBeenCalled();
  });

  it("Settings › Backend URL uses it: a refused server shows the reason and keeps the settings open", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html></html>", { headers: { "content-type": "text/html" } })));
    const { SETTINGS } = await import("../settings/registry");
    const { getApiBase } = await import("../lib/api");
    const def = SETTINGS.find((d) => d.id === "server.url");
    if (!def || def.type !== "text" || !def.action) throw new Error("server.url setting missing");
    const ctx = { online: true, onClose: vi.fn(), onConnect: vi.fn(), onImportDone: vi.fn(), openTab: vi.fn() };
    await expect(def.action.run("https://not-onden.example", ctx)).resolves.toBe("This address is not an Onden server.");
    expect(getApiBase()).toBe("");
    expect(ctx.onClose).not.toHaveBeenCalled();
    // The test imports the whole settings registry again after resetModules (about 5 s of module loading, on the 5 s default): the
    // flake was the timeout, not the behaviour.
  }, 30_000);
});
