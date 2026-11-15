// 「分享 → Onden」: shares from the phone's share sheet into quick capture.
// sharePayload.ts parses a share, shareSources.ts reads where it waits (the
// PWA service worker's stash, the Android plugin), shareInbox.ts hands it to
// QuickCapture. What the page was opened with (`?capture=1`) is lib/captureArrival.ts.
export { useIncomingShare, type IncomingShare } from "./shareInbox";
export type { RawShare, SharedCapture } from "./sharePayload";
