// Onden service worker — keeps the app openable offline.
//
// What it caches, and why each rule is safe:
//   - "/" (the app shell): network-first; every successful load refreshes the
//     copy, so the offline shell is the build this device last ran (and whose
//     chunks it therefore holds), not the one from the day the SW installed.
//   - /_astro/* (hashed build files): cache-first, stored on first fetch. A
//     hashed name never changes content, so a cached copy is never stale; a
//     NEW build's chunk is simply a cache miss that goes to the network. (The
//     old "cache-first broke lazy imports" problem was a miss that never fell
//     back to the network; here a miss always does.)
//   - the local database engine (/sql.js/*.wasm), fonts, icons, manifest:
//     network-first with the cached copy as the offline fallback. They are not
//     hashed, so serving a cached copy while online could pair an old wasm with
//     a new worker; offline, the last good copy is the only way the local
//     database (and so the note list) can start at all.
//   - /api/* and non-GET: never touched (the app has its own offline queue).
// The browser HTTP cache is not enough offline: max-age=0 files (wasm, fonts)
// are revalidated and fail without a network, and it is not covered by the
// app's persistent-storage grant, so it can be evicted while Cache Storage is
// kept. Measured 2026-10-19: an offline reload had no wasm, so the local DB
// never started and the note list stayed empty.
//
// Bump CACHE when these semantics change: activate drops the older
// "onden-v*" caches only (other caches, such as a share inbox, are not ours).

const CACHE = "onden-v5";
const OFFLINE_URL = "/";
// 「分享 → Onden」 (manifest share_target, POST multipart): the shared form
// waits here until the signed-in workspace takes it
// (src/lib/share/shareInbox.ts, INBOX_CACHE — keep the names in sync).
const SHARE_INBOX = "onden-share-inbox";
const SHARE_ACTION = "/share-target";
const PRECACHE = [OFFLINE_URL, "/sql.js/sql-wasm-browser.wasm", "/manifest.webmanifest", "/favicon.svg"];
// Hashed files from older builds pile up across deploys; past this many the
// oldest are dropped (Cache Storage keeps insertion order). One session loads
// well under 100 code files; the headroom is for font slices (/_astro/*.woff2).
const MAX_HASHED_ENTRIES = 1000;

function isHashedAsset(url) {
  return url.pathname.startsWith("/_astro/");
}

function isStaticAsset(url) {
  return url.pathname.startsWith("/sql.js/") || url.pathname.startsWith("/fonts/")
    || url.pathname === "/manifest.webmanifest" || url.pathname === "/favicon.svg"
    || /^\/icon-\d+\.png$/.test(url.pathname) || url.pathname === "/pdf.worker.min.mjs";
}

// Best-effort: a full cache or a partial (206) response must not fail the fetch.
async function store(request, response) {
  if (!response || response.status !== 200 || response.type === "opaque") return;
  try {
    const cache = await caches.open(CACHE);
    await cache.put(request, response);
  } catch { /* quota or an uncacheable response: keep serving from the network */ }
}

async function trimHashed() {
  const cache = await caches.open(CACHE);
  const hashed = (await cache.keys()).filter((req) => isHashedAsset(new URL(req.url)));
  const excess = hashed.length - MAX_HASHED_ENTRIES;
  for (let i = 0; i < excess; i++) await cache.delete(hashed[i]);
}

// The first visit loads the app before this worker controls the page, so
// none of those files went through the fetch handler. The page then lists
// what it loaded (src/pages/index.astro) and the cacheable ones are stored
// here, so even a first visit followed by going offline can reload.
async function remember(urls) {
  const cache = await caches.open(CACHE);
  for (const raw of urls.slice(0, 300)) {
    let url;
    try { url = new URL(raw); } catch { continue; }
    if (url.origin !== self.location.origin || !(isHashedAsset(url) || isStaticAsset(url))) continue;
    if (await cache.match(url.href)) continue;
    try { await store(url.href, await fetch(url.href)); } catch { /* offline again: next launch */ }
  }
  await trimHashed();
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "remember" || !Array.isArray(data.urls)) return;
  event.waitUntil(remember(data.urls).catch(() => {}));
});

self.addEventListener("install", (event) => {
  // Each file on its own: one missing file must not leave the shell uncached.
  event.waitUntil(
    caches.open(CACHE).then((cache) => Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => {})))),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      // Only our own versioned caches: the share inbox (shares not yet
      // captured) does not match and is never wiped.
      Promise.all(keys.filter((k) => /^onden-v\d+$/.test(k) && k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

// Stash the shared form and send the window to the app, which opens quick
// capture with it — after the login gate if the share cold-started the app.
// 303 so the browser follows with a GET. A form that cannot be read still
// opens capture (empty) rather than an error page.
async function receiveShare(request) {
  try {
    const form = await request.formData();
    const cache = await caches.open(SHARE_INBOX);
    const key = new URL(`${SHARE_ACTION}/${Date.now()}-${Math.random().toString(36).slice(2)}`, self.location.origin);
    await cache.put(new Request(key.href), new Response(form));
  } catch {
    // fall through to the capture sheet
  }
  return Response.redirect(new URL("/?capture=1", self.location.origin).href, 303);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method === "POST" && url.origin === self.location.origin && url.pathname === SHARE_ACTION) {
    event.respondWith(receiveShare(request));
    return;
  }

  // Never intercept API calls, non-GET, or other origins.
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  // Navigation: network-first with the offline shell as the fallback. Only
  // the app's own page refreshes the shell copy (not /site/* pages).
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).then((response) => {
        if (url.pathname === OFFLINE_URL && response.ok) {
          const copy = response.clone();
          event.waitUntil(store(OFFLINE_URL, copy));
        }
        return response;
      }).catch(() =>
        caches.match(OFFLINE_URL).then((r) => r ?? Response.error()),
      ),
    );
    return;
  }

  if (isHashedAsset(url)) {
    event.respondWith(
      caches.match(request).then((cached) => cached ?? fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(store(request, copy).then(trimHashed).catch(() => {}));
        }
        return response;
      })).catch(() => Response.error()),
    );
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(
      fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(store(request, copy));
        }
        return response;
      }).catch(() => caches.match(request).then((r) => r ?? Response.error())),
    );
    return;
  }

  // Everything else: network-first, any cached copy as the offline fallback.
  event.respondWith(
    fetch(request).catch(() => caches.match(request).then((r) => r ?? Response.error())),
  );
});

// --- Due-soon reminders (busy-parent #2) ---------------------------------
// The in-app hook (useDueSoonNotifications) shows reminders via
// reg.showNotification while the tab is open; the server sends a Web Push for
// the same moment when it is not (backend modules/tasks/pushReminders.ts). Both
// land through the same shape: `tag` is `remind:<task>:<moment>` on both sides,
// so a moment already shown by the open app is replaced, not doubled. These two
// handlers make a notification CLICKABLE (open the task's note) and render a push.

function openTask(data) {
  const url = (data && data.url) || OFFLINE_URL;
  return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    // Focus an existing tab and ask it to navigate, instead of spawning a new
    // one — the SPA owns its own routing via the URL search params.
    for (const client of clients) {
      if ("focus" in client) {
        client.postMessage({ type: "open-task", url, nodeId: data && data.nodeId, taskId: data && data.taskId });
        return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
    return undefined;
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openTask(event.notification.data || {}));
});

self.addEventListener("push", (event) => {
  // Payload (backend reminderPayload): { title: task title, body: time, tag, data }.
  // Never note text. Rendered with the shape the in-app path uses so
  // notificationclick works the same.
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = {}; }
  const title = payload.title || "Onden reminder";
  const options = {
    body: payload.body || "",
    icon: "/favicon.svg",
    badge: "/favicon.svg",
    tag: payload.tag,
    data: payload.data || (payload.nodeId ? { nodeId: payload.nodeId, url: `/?view=notes&node=${payload.nodeId}` } : {}),
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
