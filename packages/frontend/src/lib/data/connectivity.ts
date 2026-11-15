// The workspace's connection lifecycle (D26): boot, the browser's online and
// offline events with the reconnect retry, the refresh after a later
// offline→online flip, the unload flush and the access-revoked notice. The
// app attaches it once (useAppData's mount) and disposes it on unmount;
// everything else about connectivity is decided here, beside the engine
// steps it orders (syncEngine.ts).
//
// The rules, in the order they act:
//   - Boot owns the FIRST online false→true flip (slim-bootstrap-clobber): boot
//     flips online the moment the slim/full paint lands and has already
//     hydrated, so that flip runs only a delta sync — a full refresh() there
//     would re-pull /api/bootstrap right after the slim paint and clobber it.
//     A boot that ended offline releases the flip: the next offline→online
//     transition must refresh to pull what boot could not fetch.
//   - Every later false→true flip syncs (drains the queue, pulls deltas) and
//     then refreshes what the deltas do not carry (the whole bootstrap when
//     the daily one is due), so sidebar and views are current.
//   - 'online' runs reconnect(). When it fails while the browser is online,
//     only the server is down and the browser will not fire 'online' again, so
//     the next attempt is self-scheduled RECONNECT_RETRY_MS later. The same
//     loop starts when the store goes offline (refresh() met an unreachable
//     server) or boot ends offline while the browser is online. A new
//     attempt, 'offline' and dispose each cancel a scheduled retry; while the
//     browser is offline the real 'online' event drives the retry instead.
//   - 'offline' runs wentOffline() (indicator off, gate lowered). reconnect()
//     itself decides the gate after a failed attempt (PR #189: offline during
//     a reconnect must not re-lock).

import { getAppState, subscribeApp } from "../appStore";
import { onAccessRevoked } from "../accessRevoked";
import { onProtocolBlockChange } from "../protocolGate";
import { installUnloadFlush } from "../localDb";
import { boot, forgetWorkspace, reconnect, refreshIfStale, sync, wentOffline } from "./syncEngine";

/** Wait before retrying a reconnect that failed while the browser was online. */
export const RECONNECT_RETRY_MS = 5000;

/** What the lifecycle needs from the window: its online/offline events and
 *  the browser's own network state (`navigator.onLine`). */
export type ConnectivityHost = {
  addEventListener(type: "online" | "offline", listener: () => void): void;
  removeEventListener(type: "online" | "offline", listener: () => void): void;
  readonly navigator?: { readonly onLine: boolean };
};

let live: { host: ConnectivityHost; users: number; stop: () => void; stopping: boolean } | null = null;

/** Start the connection lifecycle on `host` (the window): boot, then follow
 *  its online/offline events. Returns the disposer, which removes the
 *  listeners, the pending retry, the unload flush and the access-revoked
 *  handler; a reconnect answering after it schedules no retry.
 *
 *  One lifecycle runs at a time. Attaching while attached shares it (no
 *  second boot, no second set of listeners). The last disposer stops it at
 *  the end of the current microtask queue rather than at once, so React
 *  StrictMode's mount → unmount → mount in one commit keeps the first boot
 *  instead of booting twice. */
export function attachConnectivity(host: ConnectivityHost): () => void {
  if (live && live.host !== host) {
    if (!live.stopping) throw new Error("connectivity is already attached to another window");
    const previous = live;
    live = null;
    previous.stop();
  }
  if (live) {
    live.users += 1;
    live.stopping = false;
  } else {
    live = { host, users: 1, stop: start(host), stopping: false };
  }
  const attachment = live;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    attachment.users -= 1;
    if (attachment.users > 0) return;
    attachment.stopping = true;
    queueMicrotask(() => {
      if (live !== attachment || !attachment.stopping) return;
      live = null;
      attachment.stop();
    });
  };
}

function start(host: ConnectivityHost): () => void {
  let stopped = false;
  let bootOwnsFirstFlip = true;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let attempting = false; // a reconnect is in flight; its answer decides the next retry
  const cancelRetry = () => {
    if (retry) { clearTimeout(retry); retry = null; }
  };
  // The one retry loop. Only while the browser itself is online: then only the
  // server is down and no 'online' event will come. Never doubled, never for a
  // removed member, never when the store is already online.
  const scheduleRetry = () => {
    if (stopped || retry || attempting) return;
    if (!host.navigator?.onLine || getAppState().accessRevoked || getAppState().online) return;
    retry = setTimeout(() => { retry = null; void handleOnline(); }, RECONNECT_RETRY_MS);
  };

  // Removed from the workspace (401 membership_removed): not offline. Drop the
  // in-memory and on-device copy and let the shell show the notice instead.
  const stopAccessRevoked = onAccessRevoked(forgetWorkspace);

  void boot().then(({ endedOffline }) => {
    if (endedOffline) {
      bootOwnsFirstFlip = false;
      scheduleRetry(); // server down at page load while the browser is online
    }
  });

  async function handleOnline() {
    cancelRetry(); // a new attempt supersedes any scheduled retry
    attempting = true;
    let ok = false;
    try {
      ok = await reconnect();
    } finally {
      attempting = false;
    }
    if (stopped) return;
    if (!ok) scheduleRetry();
  }
  function handleOffline() {
    cancelRetry(); // the real 'online' event drives the next attempt
    wentOffline();
  }
  host.addEventListener("online", handleOnline);
  host.addEventListener("offline", handleOffline);

  // data-loss fix: relay pagehide / visibilitychange→hidden to the worker so
  // the debounced sql.js snapshot lands on disk before the tab closes.
  const disposeUnloadFlush = installUnloadFlush();

  // The online flip. The flag starts false, so a store already online at
  // attach counts as a flip, as the hook's mount-time effect did.
  let wasOnline = false;
  const followOnline = () => {
    const online = getAppState().online;
    const flipped = online && !wasOnline;
    // Recorded before sync() runs, so a store write inside it can't re-enter
    // this listener as a second flip.
    const wentDown = wasOnline && !online;
    wasOnline = online;
    if (online) cancelRetry(); // someone else (a whole bootstrap) brought it back
    else if (wentDown) scheduleRetry(); // e.g. refresh() found the server unreachable
    if (flipped) {
      if (bootOwnsFirstFlip) {
        // Boot already hydrated (slim now, full on idle). Consume the claim so
        // the NEXT offline→online transition refreshes; a delta sync keeps
        // views fresh meanwhile.
        bootOwnsFirstFlip = false;
        void sync();
      } else {
        // The deltas bring the mirror current; the whole bootstrap comes at
        // most daily, else only what the delta lacks (syncEngine refreshIfStale).
        void sync().then(() => refreshIfStale());
      }
    }
  };
  const unsubscribe = subscribeApp(followOnline);
  followOnline();
  // The server was updated after sync had been held back (lib/protocolGate.ts): catch up as on any reconnect.
  const stopProtocolWatch = onProtocolBlockChange((block) => { if (block === null && !stopped) void handleOnline(); });

  return () => {
    stopped = true;
    host.removeEventListener("online", handleOnline);
    host.removeEventListener("offline", handleOffline);
    cancelRetry();
    unsubscribe();
    disposeUnloadFlush();
    stopAccessRevoked();
    stopProtocolWatch();
  };
}
