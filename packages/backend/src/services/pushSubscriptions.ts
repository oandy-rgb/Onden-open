import { q } from "../db.js";
import type { ActorCtx } from "../types.js";
import { cutToUnits } from "@onden/markdown";
import { StatusError } from "../statusError.js";
import { isAllowedPushEndpoint } from "./webPush.js";

// A person's own devices for lock-screen reminders. Each person manages only
// their own rows: every query here is by the signed-in actor's id.

export type PushSubscriptionInput = { endpoint: string; p256dh: string; auth: string };

/** Keep the browser family, not the full string, so the row says which device it is. */
export function userAgentSummary(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  const browser = /SamsungBrowser/.test(ua) ? "Samsung Internet" : /Firefox\//.test(ua) ? "Firefox" : /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return cutToUnits([browser, os].filter(Boolean).join(" · "), 80);
}

/** Save this device's subscription for `actor`. The endpoint is the device's
 *  address: subscribing again (same device, maybe another account) replaces the row. */
export async function saveSubscription(actor: ActorCtx, workspaceId: string, input: PushSubscriptionInput, userAgent: string | null): Promise<void> {
  if (!isAllowedPushEndpoint(input.endpoint)) throw new StatusError(400, "invalid_push_endpoint");
  await q(
    `INSERT INTO push_subscriptions (workspace_id, actor_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (endpoint) DO UPDATE
       SET workspace_id = EXCLUDED.workspace_id, actor_id = EXCLUDED.actor_id,
           p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent, last_ok_at = NULL`,
    [workspaceId, actor.id, input.endpoint, input.p256dh, input.auth, userAgentSummary(userAgent)],
  );
}

/** Remove this device's subscription, only if it is `actor`'s. True when a row went. */
export async function removeSubscription(actor: ActorCtx, endpoint: string): Promise<boolean> {
  const r = await q(`DELETE FROM push_subscriptions WHERE endpoint = $1 AND actor_id = $2`, [endpoint, actor.id]);
  return (r.rowCount ?? 0) > 0;
}
