// Web Push: the server's keys, which push services a subscription may name, and
// the one place that talks to web-push. Off unless VAPID_PUBLIC_KEY,
// VAPID_PRIVATE_KEY and VAPID_SUBJECT are all set and usable — then nothing about
// push appears (no key endpoint, no subscribing, no scheduler), as with
// ONDEN_SECRET_KEY for the API way of running AI (docs/agents/deploy.md).
//
// The private key lives only in the environment: it is read when a message is
// signed, handed to web-push, and never logged or returned.

import webpush from "web-push";
import { config } from "../config.js";
import { log } from "../logger.js";

export type PushSubscriptionTarget = { endpoint: string; keys: { p256dh: string; auth: string } };

/** How a message gets sent. Injected in tests; `defaultSender` talks to the push service.
 *  A refusal carries the push service's HTTP status as `statusCode` (web-push's WebPushError). */
export type PushSender = (target: PushSubscriptionTarget, payload: string) => Promise<void>;

type Vapid = { publicKey: string; privateKey: string; subject: string };

let warnedBad = false;

function vapid(): Vapid | null {
  const publicKey = config.str("VAPID_PUBLIC_KEY")?.trim();
  const privateKey = config.str("VAPID_PRIVATE_KEY")?.trim();
  const subject = config.str("VAPID_SUBJECT")?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  // mailto: or https: only (RFC 8292); a key that web-push refuses means push is off, not a crash.
  if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(subject)) return badVapid("VAPID_SUBJECT must be a mailto: or https: URL");
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
  } catch {
    return badVapid("VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not a usable key pair");
  }
  return { publicKey, privateKey, subject };
}

function badVapid(reason: string): null {
  if (!warnedBad) {
    warnedBad = true;
    log.warn("web-push", `${reason}; Web Push stays off`);
  }
  return null;
}

/** Whether this server can send push at all. */
export const pushConfigured = (): boolean => vapid() !== null;

/** The public key a browser subscribes with; null when push is off. */
export const pushPublicKey = (): string | null => vapid()?.publicKey ?? null;

// A subscription's endpoint is a URL the browser chose and the server will POST
// to: only the push services real browsers use are accepted, over https, so a
// subscription cannot aim the server at anything else.
const PUSH_HOST_SUFFIXES = ["fcm.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com"];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** For logs: the push service, never the endpoint path (it is the device's address). */
export const endpointHost = (endpoint: string): string => { try { return new URL(endpoint).hostname; } catch { return "unknown"; } };

/** TTL: a push service may hold a message for a device that is off this long. */
const PUSH_TTL_SECONDS = 6 * 3600;

export const defaultSender: PushSender = async (target, payload) => {
  const v = vapid();
  if (!v) throw new Error("web push is not configured");
  await webpush.sendNotification(target, payload, {
    vapidDetails: { subject: v.subject, publicKey: v.publicKey, privateKey: v.privateKey },
    TTL: PUSH_TTL_SECONDS,
    urgency: "high", // a reminder must wake a sleeping phone
    timeout: 15_000,
  });
};
