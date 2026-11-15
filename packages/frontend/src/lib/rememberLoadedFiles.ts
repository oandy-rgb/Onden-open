import { serviceWorkerContainer } from "./storagePersist";
/** Ask the service worker (public/sw.js) to keep the code and fonts this page
 *  has loaded so far. Files fetched before the worker controlled the page never
 *  went through its fetch handler, so on a first visit this is what lets the
 *  app reload offline. The page calls it after registering the worker
 *  (pages/index.astro) and again when the workspace chunk has arrived: that
 *  chunk is loaded after sign-in, which can be before or after the worker takes
 *  over. Best-effort and idempotent (the worker skips what it already holds). */
export function rememberLoadedFiles(): void {
  const worker = serviceWorkerContainer();
  if (!worker) return;
  worker.ready
    .then((reg) => {
      const urls = performance.getEntriesByType("resource").map((e) => e.name);
      reg.active?.postMessage({ type: "remember", urls });
    })
    .catch(() => {});
}
