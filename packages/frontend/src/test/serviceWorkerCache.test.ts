import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// public/sw.js run in a fake service-worker scope: what it stores, and what
// it answers when the network is gone (an offline reload must still start the
// local database and open the screens).

const ORIGIN = "https://onden.test";
const source = readFileSync(resolve(__dirname, "../../public/sw.js"), "utf8");

type Req = { url: string; method: string; mode?: string };
const keyOf = (r: string | Req) => (typeof r === "string" ? new URL(r, ORIGIN).href : r.url);

function makeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name)!;
    return {
      put: async (r: string | Req, res: Response) => { m.set(keyOf(r), res); },
      match: async (r: string | Req) => m.get(keyOf(r))?.clone(),
      add: async (r: string) => {
        const res = await (globalThis as unknown as { swFetch: (r: Req) => Promise<Response> }).swFetch({ url: keyOf(r), method: "GET" });
        if (!res.ok) throw new Error("add failed");
        m.set(keyOf(r), res);
      },
      keys: async () => [...m.keys()].map((url) => ({ url, method: "GET" })),
      delete: async (r: string | Req) => m.delete(keyOf(r)),
    };
  };
  return {
    stores,
    api: {
      open,
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
      match: async (r: string | Req) => {
        for (const m of stores.values()) { const hit = m.get(keyOf(r)); if (hit) return hit.clone(); }
        return undefined;
      },
    },
  };
}

let listeners: Record<string, (event: unknown) => void>;
let caches: ReturnType<typeof makeCaches>;
let network: "up" | "down";
let fetched: string[];

function boot() {
  listeners = {};
  caches = makeCaches();
  network = "up";
  fetched = [];
  const fetchImpl = vi.fn(async (r: Req | string) => {
    const path = new URL(keyOf(r)).pathname;
    fetched.push(path);
    if (network === "down") throw new TypeError("Failed to fetch");
    return new Response(`body of ${path}`, { status: 200 });
  });
  (globalThis as unknown as { swFetch: typeof fetchImpl }).swFetch = fetchImpl;
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (event: unknown) => void) => { listeners[type] = fn; },
    skipWaiting: () => {},
    clients: { claim: () => {}, matchAll: async () => [] },
    registration: { showNotification: async () => {} },
  };
  new Function("self", "caches", "fetch", source)(self, caches.api, fetchImpl);
}

async function lifecycle(type: "install" | "activate") {
  const waits: Promise<unknown>[] = [];
  listeners[type]({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
  await Promise.all(waits);
}

/** Dispatch a fetch; resolves with the response (or null when not intercepted). */
async function request(path: string, init: { mode?: string; method?: string } = {}) {
  const waits: Promise<unknown>[] = [];
  let answer: Promise<Response> | null = null;
  listeners.fetch({
    request: { url: ORIGIN + path, method: init.method ?? "GET", mode: init.mode ?? "cors" },
    respondWith: (p: Promise<Response>) => { answer = p; },
    waitUntil: (p: Promise<unknown>) => waits.push(p),
  });
  const res = answer ? await (answer as Promise<Response>) : null;
  await Promise.all(waits);
  return res;
}

beforeEach(async () => {
  boot();
  await lifecycle("install");
  await lifecycle("activate");
});

describe("service worker offline cache", () => {
  it("installs the shell and the local database engine", async () => {
    const cached = [...caches.stores.values()].flatMap((m) => [...m.keys()].map((u) => new URL(u).pathname));
    expect(cached).toEqual(expect.arrayContaining(["/", "/sql.js/sql-wasm-browser.wasm"]));
  });

  it("an offline reload gets the shell, the wasm and every build file it loaded before", async () => {
    await request("/?view=notes", { mode: "navigate" });
    await request("/_astro/AppRoot.abc123.js");
    await request("/fonts/plex-sans-400.woff2");
    network = "down";
    expect(await (await request("/?view=notes&node=x", { mode: "navigate" }))!.text()).toBe("body of /");
    expect((await request("/sql.js/sql-wasm-browser.wasm"))!.status).toBe(200);
    expect(await (await request("/_astro/AppRoot.abc123.js"))!.text()).toBe("body of /_astro/AppRoot.abc123.js");
    expect((await request("/fonts/plex-sans-400.woff2"))!.status).toBe(200);
  });

  it("serves a hashed build file from the cache without the network", async () => {
    await request("/_astro/TagsOverview.D_0x.js");
    fetched = [];
    await request("/_astro/TagsOverview.D_0x.js");
    expect(fetched).toEqual([]);
  });

  it("asks the network first for files whose name does not change with the content", async () => {
    await request("/sql.js/sql-wasm-browser.wasm");
    fetched = [];
    await request("/sql.js/sql-wasm-browser.wasm");
    expect(fetched).toEqual(["/sql.js/sql-wasm-browser.wasm"]);
  });

  it("refreshes the offline shell on every successful app load, but not from other pages", async () => {
    await request("/", { mode: "navigate" });
    const shell = () => caches.api.match("/").then((r) => r!.text());
    expect(await shell()).toBe("body of /");
    await request("/site/about", { mode: "navigate" });
    expect(await shell()).toBe("body of /");
  });

  it("an update drops its own older caches and keeps everyone else's", async () => {
    await caches.api.open("onden-v4");
    await caches.api.open("onden-share-inbox");
    await caches.api.open("onden-fonts-v1");
    await lifecycle("activate");
    expect((await caches.api.keys()).sort()).toEqual(["onden-fonts-v1", "onden-share-inbox", "onden-v5"]);
  });

  it("stores what a first visit loaded before the worker took over", async () => {
    const waits: Promise<unknown>[] = [];
    listeners.message({
      data: { type: "remember", urls: [`${ORIGIN}/_astro/client.x1.js`, `${ORIGIN}/fonts/plex-sans-400.woff2`, `${ORIGIN}/api/bootstrap`, "https://cdn.example/a.js"] },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    await Promise.all(waits);
    network = "down";
    expect((await request("/_astro/client.x1.js"))!.status).toBe(200);
    expect((await request("/fonts/plex-sans-400.woff2"))!.status).toBe(200);
    expect(fetched).not.toContain("/api/bootstrap");
  });

  it("leaves the API, writes and other origins to the page", async () => {
    expect(await request("/api/bootstrap")).toBeNull();
    expect(await request("/api/nodes", { method: "POST" })).toBeNull();
    const waits: unknown[] = [];
    let answered = false;
    listeners.fetch({ request: { url: "https://cdn.example/x.js", method: "GET", mode: "cors" }, respondWith: () => { answered = true; }, waitUntil: (p: unknown) => waits.push(p) });
    expect(answered).toBe(false);
  });

  it("a file never fetched online fails offline instead of hanging", async () => {
    network = "down";
    const res = await request("/_astro/NeverLoaded.js");
    expect(res!.type).toBe("error");
  });
});
