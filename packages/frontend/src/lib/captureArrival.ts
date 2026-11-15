import { readUrlParams, stripUrlParams } from "./pageUrl";
import type { RawShare } from "./share";

// Web Share Target, the GET form an older installed manifest still uses: a
// mobile share lands on "/?capture=1&title=…&text=…&url=…" (per the W3C GET
// algorithm the params may REPLACE the action's own query, so a bare
// title/text/url arrival counts too). The current manifest POSTs to
// /share-target instead (images too); lib/share/shareInbox.ts picks that up.
// Consumed ONCE, synchronously at first render — it must run before
// BuilderWorkspace mounts because useUrlSync canonicalizes the search string to
// `?view=…` on its first effect and would silently eat the payload. The params
// are stripped via replaceState immediately so a reload (or the canonicalizer
// racing us) can't re-open the capture sheet with stale text.
// `?capture=1` is also a link in its own right (a home-screen shortcut): the
// capture box opens, empty when nothing was shared (`open`).
export type CaptureArrival = { share: RawShare | null; open: boolean };

export function consumeCaptureArrival(): CaptureArrival {
  if (typeof window === "undefined") return { share: null, open: false };
  const params = readUrlParams();
  const arrived =
    params.get("capture") === "1" || params.has("title") || params.has("text") || params.has("url");
  if (!arrived) return { share: null, open: false };
  // `?capture=1` alone is also where the service worker sends a POSTed share
  // (public/sw.js): its payload waits in the share inbox, not the URL.
  const share: RawShare = { title: params.get("title"), text: params.get("text"), url: params.get("url") };
  stripUrlParams(["capture", "title", "text", "url"]);
  return { share: share.title || share.text || share.url ? share : null, open: true };
}
