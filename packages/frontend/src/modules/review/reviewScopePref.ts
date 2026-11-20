// The 範圍 the review page was last set to, kept for the account (lib/accountPrefStore, pref key "reviewScope"):
// the page's address text (reviewPlace) of a scope. The review page opens on it, so a person who studies one
// subject keeps studying it, and the status page counts the same cards. "all" is the default.

import { createAccountPref } from "../../lib/accountPrefStore";
import { PREFS } from "../../lib/prefs";
import { isScope, parsePlace, type ReviewScope } from "./reviewPlace";

/** A stored scope, or null when the value is not one (a damaged copy reads as never chosen). */
export const parseReviewScope = (value: unknown): ReviewScope | null => {
  const place = typeof value === "string" ? parsePlace(value) : null;
  return isScope(place) ? place : null;
};

export const reviewScopePref = createAccountPref<string>({
  serverKey: "reviewScope",
  follows: "account", // what a person is studying, not a layout: the same wherever they sign in
  copy: PREFS.reviewScope,
  parse: (value) => parseReviewScope(value) ? (value as string) : null,
});
