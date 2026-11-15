// @vitest-environment node
// 「分享 → Onden」 for the installed PWA: the manifest's share_target, the
// service worker that receives the POST (public/sw.js), and the workspace
// taking the stashed share (lib/share/shareInbox.ts takeWebShares).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INBOX_CACHE, takeWebShares } from "../lib/share/shareSources";

const PUBLIC = resolve(process.cwd(), "public");

type ShareTarget = {
  action: string;
  method: string;
  enctype: string;
  params: { title: string; text: string; url: string; files: Array<{ name: string; accept: string[] }> };
};

describe("manifest share_target", () => {
  const manifest = JSON.parse(readFileSync(resolve(PUBLIC, "manifest.webmanifest"), "utf8")) as { share_target: ShareTarget };
  const target = manifest.share_target;

  it("POSTs multipart to /share-target with title, text, url and images", () => {
    expect(target.action).toBe("/share-target");
    expect(target.method).toBe("POST");
    expect(target.enctype).toBe("multipart/form-data");
    expect(target.params).toMatchObject({ title: "title", text: "text", url: "url" });
    expect(target.params.files).toEqual([expect.objectContaining({ name: "images" })]);
    expect(target.params.files[0]!.accept).toContain("image/*");
  });

  it("names the same action and inbox as the service worker", () => {
    const sw = readFileSync(resolve(PUBLIC, "sw.js"), "utf8");
    expect(sw).toContain(`const SHARE_ACTION = "${target.action}"`);
    expect(sw).toContain(`const SHARE_INBOX = "${INBOX_CACHE}"`);
  });
});

// A Cache Storage good enough for the worker and the page.
function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    return {
      put: async (req: Request | string, res: Response) => { store.set(typeof req === "string" ? req : req.url, res); },
      add: async (url: string) => { store.set(url, new Response("shell")); },
      match: async (req: Request | string) => store.get(typeof req === "string" ? req : req.url)?.clone(),
      keys: async () => [...store.keys()].map((url) => new Request(url)),
      delete: async (req: Request | string) => store.delete(typeof req === "string" ? req : req.url),
    };
  };
  return {
    stores,
    api: {
      open,
      has: async (name: string) => stores.has(name),
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
      match: async () => undefined,
    },
  };
}

// Load public/sw.js with a fake `self` and return its event listeners.
function loadWorker(caches: ReturnType<typeof fakeCaches>["api"]) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const self = {
    location: new URL("https://onden.example/sw.js"),
    addEventListener: (type: string, fn: (event: unknown) => void) => { listeners[type] = fn; },
    skipWaiting: () => {},
    clients: { claim: () => {} },
  };
  runInNewContext(readFileSync(resolve(PUBLIC, "sw.js"), "utf8"), {
    self, caches, fetch: vi.fn(), Request, Response, URL, Date, Math, Promise,
  });
  return listeners;
}

async function dispatchFetch(listeners: Record<string, (event: unknown) => void>, request: Request) {
  let responded: Promise<Response> | undefined;
  listeners.fetch!({ request, respondWith: (r: Promise<Response>) => { responded = r; } });
  return responded;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("service worker share receiver", () => {
  it("stashes the shared form and redirects to quick capture; the page takes it once", async () => {
    const caches = fakeCaches();
    const listeners = loadWorker(caches.api);
    const form = new FormData();
    form.set("title", "A page");
    form.set("url", "https://example.com/p");
    form.append("images", new File([new Uint8Array([1, 2])], "a.png", { type: "image/png" }));
    form.append("images", new File([new Uint8Array([3])], "b.jpg", { type: "image/jpeg" }));

    const response = await dispatchFetch(listeners, new Request("https://onden.example/share-target", { method: "POST", body: form }));
    expect(response).toBeDefined();
    const res = await response!;
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("https://onden.example/?capture=1");
    expect(caches.stores.get(INBOX_CACHE)?.size).toBe(1);

    vi.stubGlobal("caches", caches.api);
    const [share, ...rest] = await takeWebShares();
    expect(rest).toEqual([]);
    expect(share).toMatchObject({ title: "A page", url: "https://example.com/p", text: null });
    expect(share!.files!.map((f) => [f.name, f.type, f.size])).toEqual([["a.png", "image/png", 2], ["b.jpg", "image/jpeg", 1]]);
    // Taken: a second look finds nothing.
    expect(await takeWebShares()).toEqual([]);
  });

  it("leaves other requests alone: API calls and other POSTs", async () => {
    const listeners = loadWorker(fakeCaches().api);
    expect(await dispatchFetch(listeners, new Request("https://onden.example/api/nodes", { method: "POST", body: "{}" }))).toBeUndefined();
    expect(await dispatchFetch(listeners, new Request("https://other.example/share-target", { method: "POST", body: "x" }))).toBeUndefined();
  });

  it("keeps the share inbox when a new worker clears old caches", async () => {
    const caches = fakeCaches();
    await caches.api.open("onden-v3");
    await caches.api.open(INBOX_CACHE);
    const listeners = loadWorker(caches.api);
    let done: Promise<unknown> | undefined;
    listeners.activate!({ waitUntil: (p: Promise<unknown>) => { done = p; } });
    await done;
    expect([...caches.stores.keys()]).toEqual([INBOX_CACHE]);
  });
});
