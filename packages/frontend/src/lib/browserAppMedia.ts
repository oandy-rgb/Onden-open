// How an uploaded file reaches an <img>, <audio> or <video> in the browser app.
//
// The browser fetches `/api/media/<id>` by itself, and the page's fetch bridge (browserAppBridge.ts) cannot see that.
// So a small Service Worker (browser-sw/media-sw.js) catches exactly those GETs and asks the page; the page asks the
// worker that holds the files (the same request path every /api call takes). One mechanism for every kind of
// media element, CSS and the PDF viewer, with Range requests for seeking in audio and video.
//
// Why the page relays (not the Service Worker asking the Dedicated Worker directly): a Service Worker has no handle on
// a Dedicated Worker, and a MessageChannel through the page is the way the two are joined. The cost is that the page
// must be open to show files — it always is, the backend lives in it.
//
// First visit: the Service Worker is installed while the worker starts, and the page waits until it controls the
// page before the app is mounted, so the very first image already goes through it (no second copy of the page, no
// blob: addresses to swap in afterwards). If the browser cannot (no Service Worker: private windows in some
// browsers, an insecure address), the app still starts and uploaded files simply do not show; the report says so.

import { reloadPage } from "./api";
import { readSession, removeSession, writeSession } from "./sessionPrefs";
import { documentBaseUrl } from "./documentAccess";
import { serviceWorkerContainer } from "./storagePersist";
import type { WorkerClient } from "./browserAppWorker";

export type MediaServing = "serving" | "reloading" | "unsupported" | "failed";

/** Remembers that this tab already reloaded once for the Service Worker (the browser app only: not a SESSION_KEYS entry, so the normal build does not carry it). */
const RELOADED = "onden.mediaServiceWorkerReloaded";
const CONTROL_WAIT_MS = 4000;
const MEDIA_ID_PATH = /\/api\/media\/([^/]+)$/;

type AskMessage = { type: "onden-media"; url: string; method: string; headers: Array<[string, string]> };

/** The Service Worker is registered next to the page (`media-sw.js`), so a copy served from a sub-folder works too. */
export function registerMediaServiceWorker(): Promise<ServiceWorkerRegistration | undefined> {
  const container = serviceWorkerContainer();
  if (!container) return Promise.resolve(undefined);
  return container.register(new URL("media-sw.js", documentBaseUrl()), { scope: new URL("./", documentBaseUrl()).pathname }).catch(() => undefined);
}

/** `/api/media/<id>` (and its query) as the worker knows it, whatever folder the page is served from. */
export function workerPathOf(url: string): string | null {
  const parsed = new URL(url);
  const id = MEDIA_ID_PATH.exec(parsed.pathname)?.[1];
  return id ? `/api/media/${id}${parsed.search}` : null;
}

/** Answer the Service Worker's questions through `client`. Returns how to stop. */
export function answerMediaRequests(client: WorkerClient): () => void {
  const container = serviceWorkerContainer();
  if (!container) return () => {};
  const onMessage = (event: MessageEvent) => {
    const ask = event.data as AskMessage | undefined;
    const port = event.ports[0];
    if (ask?.type !== "onden-media" || !port) return;
    void (async () => {
      try {
        const path = workerPathOf(ask.url);
        if (!path) throw new Error("not a media address");
        const response = await client.request(new Request(new URL(path, ask.url), { method: ask.method, headers: ask.headers }));
        const noBody = ask.method === "HEAD" || response.status === 204 || response.status === 205 || response.status === 304;
        const body = noBody ? null : await response.arrayBuffer();
        port.postMessage({ status: response.status, statusText: response.statusText, headers: [...response.headers.entries()], body }, body ? [body] : []);
      } catch {
        port.postMessage({ status: 502, statusText: "", headers: [["content-type", "text/plain"]], body: new ArrayBuffer(0) });
      }
    })();
  };
  container.addEventListener("message", onMessage);
  return () => container.removeEventListener("message", onMessage);
}

/** Wait until the Service Worker controls this page. A hard reload (Shift+reload) leaves a page uncontrolled even
 *  with an active worker: one ordinary reload fixes that, once (a flag in sessionStorage stops a loop). */
export async function waitForMediaServing(registration: Promise<ServiceWorkerRegistration | undefined>): Promise<MediaServing> {
  const container = serviceWorkerContainer();
  if (!container) return "unsupported";
  if (!(await registration)) return "failed";
  try {
    await container.ready;
    if (!container.controller) {
      await new Promise<void>((resolve) => {
        const done = () => { container.removeEventListener("controllerchange", done); resolve(); };
        container.addEventListener("controllerchange", done);
        setTimeout(done, CONTROL_WAIT_MS);
      });
    }
  } catch {
    return "failed";
  }
  if (container.controller) {
    removeSession(RELOADED);
    return "serving";
  }
  // Without a place to remember it, do not reload: that could loop.
  if (readSession(RELOADED) !== "1" && writeSession(RELOADED, "1")) {
    reloadPage();
    return "reloading";
  }
  return "failed";
}
