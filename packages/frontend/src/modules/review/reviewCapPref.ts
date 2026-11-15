// A person's own cap on reviews a day, kept for the account (lib/accountPrefStore,
// pref key "reviewsPerDay"): one number across every card, due and new together.
// The review status page sets it; the server applies it when it builds the queue.

import { createAccountPref } from "../../lib/accountPrefStore";
import { PREFS } from "../../lib/prefs";

/** A stored value read back, or null when it is not a whole number of 1–5000. */
export function parseReviewCap(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5000 ? value : null;
}

export const reviewCapPref = createAccountPref<number>({
  serverKey: "reviewsPerDay",
  follows: "account", // how much they want to review a day: the same on every screen
  copy: PREFS.reviewsPerDay,
  parse: parseReviewCap,
});
