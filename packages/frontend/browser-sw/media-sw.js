// The browser app's Service Worker (docs/architecture/browser-app.md §14). It does ONE thing: a request the browser
// makes by itself for an uploaded file — <img src="/api/media/…">, <audio>, <video>, a CSS url(), a PDF — is handed to
// the page, which asks the worker that holds the database and the stored files (lib/browserAppMedia.ts). Everything
// else (every other URL, every other method) is not touched: the fetch handler returns without responding, and the
// request goes where it would have gone. /api calls made by the page's own code never reach here; the page's fetch
// bridge answers them (lib/browserAppBridge.ts).
//
// It holds no state and caches nothing: the browser may stop it whenever it is idle, and the next request wakes it.
// The answer's Cache-Control (private, no-cache + ETag) is the media route's own and is passed through as it is.
//
// Why requests outside the registration's folder still arrive: a controlled page's every sub-request goes through its
// Service Worker, whatever the worker's scope. So a copy served from /onden/ sees `/api/media/x` (an absolute path
// the page wrote) as well as `/onden/api/media/x`.

const MEDIA_PATH = /\/api\/media\/[^/]+$/;
const ASK_TIMEOUT_MS = 30000;

self.addEventListener("install", () => { self.skipWaiting(); });
// Take over the pages that are already open (the first visit, which loaded before this worker existed).
self.addEventListener("activate", (event) => { event.waitUntil(self.clients.claim()); });

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" && request.method !== "HEAD") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !MEDIA_PATH.test(url.pathname)) return;
  event.respondWith(answerFromPage(event));
});

async function pageFor(event) {
  const asker = event.clientId ? await self.clients.get(event.clientId) : undefined;
  if (asker && asker.type === "window") return asker;
  return (await self.clients.matchAll({ type: "window", includeUncontrolled: false }))[0];
}

async function answerFromPage(event) {
  const { request } = event;
  const page = await pageFor(event);
  if (!page) return new Response("The page that keeps the files is not open.", { status: 503 });
  const answer = await new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), ASK_TIMEOUT_MS);
    channel.port1.onmessage = (message) => { clearTimeout(timer); resolve(message.data); };
    page.postMessage({ type: "onden-media", url: request.url, method: request.method, headers: [...request.headers.entries()] }, [channel.port2]);
  });
  if (!answer) return new Response("The page did not answer in time.", { status: 504 });
  const noBody = request.method === "HEAD" || answer.status === 204 || answer.status === 205 || answer.status === 304;
  return new Response(noBody ? null : answer.body, { status: answer.status, statusText: answer.statusText, headers: answer.headers });
}
