// Lock-screen reminders, the browser's half (docs/architecture/day-timeline.md §5).
// The server sends a Web Push for a task's reminder moment (backend
// modules/tasks/pushReminders.ts); the service worker (public/sw.js) shows it with
// the same `tag` the open app uses, so one moment is one notification.
//
// This file owns: whether this device can get them, subscribing / unsubscribing
// the browser, telling the server (POST/DELETE /api/push/subscriptions), and the
// one status every surface reads (the Tasks page hint, Settings). Nothing shows
// an endpoint or a key: the person sees "on", "off" and, when it fails, a reason.
//
// Absent unless the server has VAPID keys (GET /api/push/key answers 404): then
// `available` stays false and no surface shows anything.

import { useSyncExternalStore } from "react";
import { pushWriter, reads } from "./data";
import { isBrave, isIos } from "./pushBrowser";
import { serviceWorkerContainer } from "./storagePersist";

/** Why turning it on did not work, in terms the person can act on. */
export type PushProblem =
  | "blocked"   // notifications are blocked for this site
  | "brave"     // Brave ships with Google's push service off
  | "install"   // iPhone / iPad: only an app added to the Home Screen can get push
  | "failed";   // anything else: try again

export type PushStatus = {
  /** The server offers it and this browser can do it (or could, once installed). */
  available: boolean;
  /** This browser holds a subscription the server was told about. */
  subscribed: boolean;
  busy: boolean;
  problem: PushProblem | null;
};

let status: PushStatus = { available: false, subscribed: false, busy: false, problem: null };
const listeners = new Set<() => void>();
function set(next: Partial<PushStatus>): void {
  status = { ...status, ...next };
  for (const l of listeners) l();
}

export const getPushStatus = (): PushStatus => status;
export function subscribePushStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export const usePushStatus = (): PushStatus => useSyncExternalStore(subscribePushStatus, getPushStatus, getPushStatus);

function browserCanPush(): boolean {
  return typeof window !== "undefined" && "PushManager" in window && "Notification" in window && !!serviceWorkerContainer();
}

/** The VAPID key as the bytes `subscribe` wants. */
function keyBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64Url.length / 4) * 4, "=");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function serverKey(): Promise<string | null> {
  try { return (await reads.push.key()).public_key; } catch { return null; }
}

async function currentSubscription(): Promise<PushSubscription | null> {
  try { return (await (await serviceWorkerContainer()!.ready).pushManager.getSubscription()); } catch { return null; }
}

/** Tell the server about this browser's subscription (an upsert: safe to repeat, and it
 *  hands the device to the account signed in now). */
async function registerWithServer(subscription: PushSubscription): Promise<void> {
  const json = subscription.toJSON();
  await pushWriter.register({ endpoint: json.endpoint, p256dh: json.keys?.p256dh, auth: json.keys?.auth });
}

let refreshed = false;

/** Work out what this device can do and, if it already has a subscription, re-tell the
 *  server (once per page). Call when the app starts and when reminders are turned on. */
export async function refreshPushStatus(): Promise<void> {
  const key = await serverKey();
  if (!key) { set({ available: false, subscribed: false }); return; }
  if (!browserCanPush()) {
    // Only an installed iOS app has PushManager; offering the way in beats hiding it.
    set(isIos() ? { available: true, subscribed: false, problem: "install" } : { available: false, subscribed: false });
    return;
  }
  const existing = Notification.permission === "granted" ? await currentSubscription() : null;
  if (!existing) { set({ available: true, subscribed: false }); return; }
  if (!refreshed) {
    refreshed = true;
    try { await registerWithServer(existing); } catch { /* offline now: the next start tells it */ }
  }
  set({ available: true, subscribed: true, problem: null });
}

/** Turn lock-screen reminders on for this device: ask for notifications if not yet
 *  allowed, subscribe the browser, tell the server. Resolves true when it is on. */
export async function enablePush(): Promise<boolean> {
  if (status.busy) return status.subscribed;
  set({ busy: true, problem: null });
  try {
    const key = await serverKey();
    if (!key) { set({ available: false }); return false; }
    if (!browserCanPush()) { set({ problem: isIos() ? "install" : "failed" }); return false; }
    if (Notification.permission === "default") await Notification.requestPermission();
    if (Notification.permission !== "granted") { set({ problem: "blocked" }); return false; }
    let subscription = await currentSubscription();
    if (!subscription) {
      try {
        subscription = await (await serviceWorkerContainer()!.ready).pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
      } catch {
        // The browser could not reach its push service.
        set({ problem: (await isBrave()) ? "brave" : "failed" });
        return false;
      }
    }
    try { await registerWithServer(subscription); } catch { set({ problem: "failed" }); return false; }
    set({ available: true, subscribed: true });
    return true;
  } finally {
    set({ busy: false });
  }
}

/** Turn them off here: the server forgets the device, then the browser drops the subscription.
 *  If the server cannot be reached the browser still drops it, so the push service stops
 *  delivering and the server prunes the dead address on its next send. */
export async function disablePush(): Promise<void> {
  if (status.busy) return;
  set({ busy: true, problem: null });
  try {
    const subscription = await currentSubscription();
    if (subscription) {
      try { await pushWriter.remove(subscription.endpoint); } catch { /* see above */ }
      try { await subscription.unsubscribe(); } catch { /* already gone */ }
    }
    set({ subscribed: false });
  } finally {
    set({ busy: false });
  }
}

/** Signing out: this device must not keep getting this account's reminders. Best effort. */
export async function forgetPushDevice(): Promise<void> {
  if (status.subscribed) await disablePush();
}

/** Tests: back to the start. */
export function _resetPushForTests(): void {
  status = { available: false, subscribed: false, busy: false, problem: null };
  refreshed = false;
  listeners.clear();
}
