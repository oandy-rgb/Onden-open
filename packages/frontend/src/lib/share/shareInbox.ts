// Where 「分享 → Onden」 shares wait until the workspace can take them.
//
// A share can arrive before anyone is signed in (a cold start from the share
// sheet lands on the server/login gates first), so each source keeps it until
// the workspace — mounted only after LoginGate — takes it:
//   • PWA: the service worker answers the share_target POST, stashes the form
//     in the INBOX_CACHE Cache Storage bucket and redirects to `/?capture=1`
//     (public/sw.js). takeWebShares() reads and removes the stash.
//   • Android: the ShareIntent plugin (android/app/src/main/java/com/onden/
//     app/ShareIntentPlugin.java) holds the intent's text and images until
//     take(); a share while the app is open fires "shareReceived".
//   • an old GET share_target (`?capture=1&title=&text=&url=`) is read from
//     the URL by BuilderApp before the URL sync rewrites it.
// The sources are read in shareSources.ts; useIncomingShare() turns what they
// hold into one SharedCapture for QuickCapture.

import { useEffect, useRef, useState } from "react";
// Direct import: through the index Rollup warns of a cross-chunk cycle (lib/data/index.ts re-exports reads.ts).
// eslint-disable-next-line onden/module-entry
import { reads } from "../data/reads";
import { draftWithTitle, mergeShares, parseSharePayload, type RawShare, type SharedCapture } from "./sharePayload";
import { shareIntentPlugin, takeNativeShare, takeWebShares } from "./shareSources";

/** A share for quick capture, with an id per arrival so the same share is
 *  never inserted twice, and the draft with the page's real title once the
 *  server has fetched it. */
export type IncomingShare = SharedCapture & { id: number; titledDraft?: string };

let nextId = 1;
// Shares taken from their source but not yet handed to a mounted workspace:
// a remount (or a second take racing the first) picks them up, so a share
// that left the stash is never lost on the way.
let undelivered: RawShare[] = [];
let initialTaken = false;

async function collect(initial: RawShare | null): Promise<void> {
  if (initial && !initialTaken) { initialTaken = true; undelivered.push(initial); }
  undelivered.push(...await takeWebShares());
  const native = await takeNativeShare();
  if (native) undelivered.push(native);
}

/** Shares arriving now (`initial`: the GET share BuilderApp read from the URL)
 *  or later, while the workspace is open. */
export function useIncomingShare(initial: RawShare | null, online: boolean): IncomingShare | null {
  const [share, setShare] = useState<IncomingShare | null>(null);
  const onlineRef = useRef(online);
  useEffect(() => { onlineRef.current = online; }, [online]);

  useEffect(() => {
    let alive = true;
    const deliver = () => {
      if (!alive) return;
      const raws = undelivered;
      undelivered = [];
      const capture = mergeShares(raws.map(parseSharePayload).filter((s) => s.draft || s.images.length || s.skipped.length));
      if (!capture) return;
      const id = nextId++;
      setShare({ ...capture, id });
      // The page's own title, when the server can fetch it; offline the
      // draft keeps the shared title or the bare URL.
      if (capture.url && onlineRef.current) {
        reads.workspace.linkTitle(capture.url)
          .then((title) => {
            const titled = draftWithTitle(capture, title);
            if (alive && titled !== capture.draft) {
              setShare((current) => current?.id === id ? { ...current, titledDraft: titled } : current);
            }
          })
          .catch(() => { /* keep the URL as it was shared */ });
      }
    };
    void collect(initial).then(deliver);

    // While the app is open, Android re-focuses it with a new share; an
    // installed PWA is navigated to `/?capture=1` instead (a fresh page load).
    let removeListener: (() => void) | null = null;
    void shareIntentPlugin()
      .then((plugin) => plugin?.addListener("shareReceived", () => { void collect(null).then(deliver); }))
      .then((handle) => {
        if (!handle) return;
        if (alive) removeListener = () => { void handle.remove(); };
        else void handle.remove();
      })
      .catch(() => {});
    return () => { alive = false; removeListener?.(); };
    // `initial` is read once, at mount: it is the URL the page opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return share;
}

/** Test seam: forget module state between tests. */
export function resetShareInboxForTests(): void {
  undelivered = [];
  initialTaken = false;
}
