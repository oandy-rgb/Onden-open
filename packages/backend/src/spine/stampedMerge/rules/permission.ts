// Who may write, and from where (4.1, 4.13, 4.14). Pure rules over the merged data; nothing here changes a stored value.
import { type Stamp, compareStamps } from "../unit.js";

export type Permission = "none" | "view" | "suggest" | "edit";
export type PermissionChange = { actor: string; permission: Permission; stamp: Stamp };

/**
 * What `actor` could do at the moment of `at`: the latest change to them stamped strictly before it ("a revocation holds
 * from then on, not for what was written earlier", 4.1). Computed over the whole set of changes, so the order the changes
 * arrived in does not matter; a node that has not yet received a revocation computes a different answer for the same
 * write, which is why a write's verdict must be recomputed when more changes arrive (stampedMerge README, "late revocation").
 */
export function permissionAt(changes: readonly PermissionChange[], actor: string, at: Stamp): Permission {
  let best: PermissionChange | undefined;
  for (const c of changes) if (c.actor === actor && compareStamps(c.stamp, at) < 0 && (!best || compareStamps(c.stamp, best.stamp) > 0)) best = c;
  return best?.permission ?? "none";
}

/** A write by someone who could not edit at its time is kept as a suggestion for a person to decide, never dropped (the same road an AI's change takes). */
export function verdictOfWrite(changes: readonly PermissionChange[], write: { author: string; stamp: Stamp }): "apply" | "suggestion" {
  return permissionAt(changes, write.author, write.stamp) === "edit" ? "apply" : "suggestion";
}

export type IdentityChange = { kind: "owner-transfer" | "invite" | "sign-in"; stamp: Stamp };
/** Owner transfer, invitations and sign-in links change who someone is: only the main server's stamps count (4.13). Anything else is refused, not merged. */
export const identityChangeAllowed = (change: IdentityChange, mainOrigin: string): boolean => change.stamp.origin === mainOrigin;

/** How long a node may be away before what it still has to send is listed for the person to confirm one by one (4.14: the retry record is kept 30 days). */
export const OFFLINE_CONFIRM_AFTER_MS = 30 * 24 * 3600_000;
export const pendingNeedsConfirmation = (lastSyncedAtMs: number, nowMs: number, limitMs = OFFLINE_CONFIRM_AFTER_MS): boolean => nowMs - lastSyncedAtMs > limitMs;
