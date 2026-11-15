// Make the page's own /api calls reach the worker instead of the network.
//
// Why the page's fetch and not a Service Worker: a Service Worker is stopped by the browser whenever it is idle
// and cannot hold the database; it would only be a second hop to the worker that does. The page's fetch layer is
// one object the whole app already goes through (lib/api, the sign-in client, uploads, downloads of the export).
// What it cannot see is a request the browser makes by itself — an <img src="/api/media/…">: those few GETs are
// the one thing the Service Worker is for (lib/browserAppMedia.ts, docs/architecture/browser-app.md §14).
//
// Also here: EventSource, rebuilt on the same bridge, because /api/events/stream is a fetch that never ends.

import { BROWSER_APP_CLEAR_SAMPLES_PATH, BROWSER_APP_STATE_PATH, type BrowserAppState } from "@onden/markdown";
import { pageOrigin } from "../lib/api";
import { documentBaseUrl } from "../lib/documentAccess";
import { addToast } from "../lib/appStore";
import { downloadBlob } from "../lib/download";
import { t } from "../lib/i18n";
import type { WorkerClient } from "./browserAppWorker";

const BRIDGED_PATH = /^\/(api\/|health$)/;

function isBridged(url: URL): boolean {
  return url.origin === pageOrigin() && BRIDGED_PATH.test(url.pathname);
}

export function installFetchBridge(client: WorkerClient): void {
  const network = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    return isBridged(new URL(request.url)) ? client.request(request) : network(input, init);
  };
  window.EventSource = createEventSource(client) as unknown as typeof EventSource;
  document.addEventListener("click", downloadThroughBridge, true);
}

/** A link the page offers for download (`<a href="/api/backup/full.zip" download>`) is followed by the browser itself,
 *  which cannot reach the worker: fetch it here and hand the bytes to the browser's download. */
function downloadThroughBridge(event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
  const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!(link instanceof HTMLAnchorElement) || !link.hasAttribute("download")) return;
  const url = new URL(link.href, documentBaseUrl());
  if (!isBridged(url)) return;
  event.preventDefault();
  void saveBridgedFile(url, link.getAttribute("download") || "onden-download")
    .then((name) => { if (name) announceDownload(name); else addToast(t("The download could not be made. Try again."), "error"); })
    .catch(() => addToast(t("The download could not be made. Try again."), "error"));
}

/** The browser's own download bar is easy to miss (and absent in some browsers): say that the file was made and what it is called. */
export function announceDownload(name: string): void {
  addToast(t("Downloaded \"{name}\". Keep the file somewhere safe.", { name }), "success", undefined, { inDialog: true });
}

/** Fetch `url` through the bridge and hand it to the browser's download under the name the answer gives (Content-Disposition).
 *  Resolves the file's name, or null when the worker refused. */
export async function saveBridgedFile(url: URL | string, fallbackName: string): Promise<string | null> {
  const response = await window.fetch(url);
  if (!response.ok) return null;
  const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(response.headers.get("content-disposition") ?? "")?.[1];
  const name = named ? decodeURIComponent(named) : fallbackName;
  downloadBlob(await response.blob(), name);
  return name;
}

/** The part of EventSource the app uses (onopen / onmessage / onerror, addEventListener, close, readyState),
 *  reading the stream through the bridge. The worker ends the stream only when the page closes it. */
function createEventSource(client: WorkerClient) {
  return class BridgedEventSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readonly url: string;
    readonly withCredentials: boolean;
    readyState = 0;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    private readonly abort = new AbortController();

    constructor(url: string | URL, init?: { withCredentials?: boolean }) {
      super();
      this.url = new URL(String(url), documentBaseUrl()).href;
      this.withCredentials = init?.withCredentials ?? false;
      void this.run();
    }

    close(): void {
      this.readyState = 2;
      this.abort.abort();
    }

    private emit(event: Event, handler: ((event: never) => void) | null): void {
      try { handler?.(event as never); } catch { /* a listener's error is its own */ }
      this.dispatchEvent(event);
    }

    private async run(): Promise<void> {
      try {
        const response = await client.request(new Request(this.url, { headers: { Accept: "text/event-stream" }, signal: this.abort.signal }));
        if (!response.ok || !response.body) throw new Error("stream refused");
        this.readyState = 1;
        this.emit(new Event("open"), this.onopen);
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          for (let at = buffer.indexOf("\n\n"); at >= 0; at = buffer.indexOf("\n\n")) {
            const frame = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
            if (data) this.emit(new MessageEvent("message", { data }), this.onmessage);
          }
        }
        throw new Error("stream ended");
      } catch {
        if (this.readyState === 2) return;
        // Like a real EventSource whose connection dropped for good: the app's own reconnect takes over.
        this.readyState = 2;
        this.emit(new Event("error"), this.onerror);
      }
    }
  };
}

/** What the worker says about its saved copy and the sample notes. */
export async function readBrowserAppState(): Promise<BrowserAppState> {
  return (await window.fetch(BROWSER_APP_STATE_PATH)).json() as Promise<BrowserAppState>;
}

/** Remove the sample notes (and only them). Resolves false when the worker refused. */
export async function removeSampleNotes(): Promise<boolean> {
  return (await window.fetch(BROWSER_APP_CLEAR_SAMPLES_PATH, { method: "POST" })).ok;
}

/** Delete the page's own databases (the offline mirror of the notes), so that nothing of the erased notes is shown again. */
export async function deletePageDatabases(): Promise<void> {
  for (const db of (await indexedDB.databases?.()) ?? []) if (db.name) indexedDB.deleteDatabase(db.name);
}
