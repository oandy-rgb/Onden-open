// The two places a share waits before the workspace takes it (shareInbox.ts):
// the PWA service worker's Cache Storage stash and the Android ShareIntent
// plugin. No data-layer imports, so the service-worker round trip is testable
// on its own (test/shareTarget.test.ts).

import { fileFromNative, rawShareFromForm, type NativeSharedFile, type RawShare } from "./sharePayload";

/** The Cache Storage bucket the service worker stashes shares in. Keep in
 *  sync with SHARE_INBOX in public/sw.js. */
export const INBOX_CACHE = "onden-share-inbox";

/** Read and remove every share the service worker stashed. */
export async function takeWebShares(): Promise<RawShare[]> {
  if (typeof caches === "undefined") return [];
  try {
    if (!(await caches.has(INBOX_CACHE))) return [];
    const cache = await caches.open(INBOX_CACHE);
    const shares: RawShare[] = [];
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      try {
        if (response) shares.push(rawShareFromForm(await response.formData()));
      } catch { /* an unreadable stash is dropped, not retried forever */ }
      await cache.delete(request);
    }
    return shares;
  } catch {
    return [];
  }
}

type NativeShare = { title?: string | null; text?: string | null; files?: NativeSharedFile[] };
type ShareIntentPlugin = {
  take(): Promise<{ share?: NativeShare | null }>;
  addListener(event: "shareReceived", listener: () => void): Promise<{ remove: () => Promise<void> }>;
};

let nativePlugin: Promise<ShareIntentPlugin | null> | null = null;

/** The Android app's ShareIntent plugin; null in a browser. */
export function shareIntentPlugin(): Promise<ShareIntentPlugin | null> {
  if (import.meta.env.VITE_NATIVE !== "true") return Promise.resolve(null);
  nativePlugin ??= import("@capacitor/core")
    .then(({ Capacitor, registerPlugin }) =>
      Capacitor.isPluginAvailable("ShareIntent") ? registerPlugin<ShareIntentPlugin>("ShareIntent") : null)
    .catch(() => null);
  return nativePlugin;
}

/** Take the share the Android app was opened (or re-focused) with, if any. */
export async function takeNativeShare(): Promise<RawShare | null> {
  const plugin = await shareIntentPlugin();
  if (!plugin) return null;
  try {
    const { share } = await plugin.take();
    if (!share) return null;
    return { title: share.title, text: share.text, files: (share.files ?? []).map(fileFromNative) };
  } catch {
    return null;
  }
}
