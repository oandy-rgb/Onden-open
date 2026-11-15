// How long ago a device made an edit, as the device itself measures it. A device's clock can be hours off, so its
// absolute edit time never decides who wins (docs/architecture/proposals/distributed-ready-2026-11-12.md item 6): the
// device's error cancels in "now − edit time" when both come from the same clock, and the server dates the edit
// `its own logical clock − age` (spine/stamps.ts currentStampWall).
//
// Every request of the app carries the device's clock reading at the moment it is SENT as `X-Onden-Client-Now`
// (epoch ms; markdown sharedContract.ts, frontend lib/api.ts), also a request replayed from the offline queue. Old clients that do not send it
// give no age: the edit counts as made when it arrived.

import { CLIENT_NOW_HEADER } from "@onden/markdown";

export { CLIENT_NOW_HEADER };

/** Longer than any real offline stretch; keeps `now − age` a valid time. */
export const MAX_EDIT_AGE_MS = 10 * 365 * 24 * 3600_000;

/** The age of an edit the device dated `deviceEditTime` (its own clock, epoch ms), or 0 when the request carries no
 *  reading of that clock (an older client). Never negative. */
export function editAgeMs(clientNowHeader: string | undefined, deviceEditTime: number): number {
  const sentAt = clientNowHeader === undefined || clientNowHeader.trim() === "" ? NaN : Number(clientNowHeader);
  if (!Number.isFinite(sentAt) || !Number.isFinite(deviceEditTime)) return 0;
  return Math.min(Math.max(0, sentAt - deviceEditTime), MAX_EDIT_AGE_MS);
}
